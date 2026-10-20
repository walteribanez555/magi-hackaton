/**
 * Cliente de MagiHub Smart Auto (OpenAI-compatible) y parsing de respuestas. Puro: no importa 'vscode'.
 * La inferencia SIEMPRE pasa por {magihubBaseUrl}/v1/chat/completions con model = "smart-auto".
 */
import { KeyIdentity, SMART_AUTO_MODEL, TokenUsage } from '@magicode/contracts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PromptInput {
  /** ruta relativa al repo */
  path: string;
  languageId: string;
  fileContent: string;
  instruction: string;
  /** selección activa (líneas 1-based, inclusivas) */
  selection?: { startLine: number; endLine: number; text: string };
}

/** Límite de contexto enviado (caracteres); archivos más grandes se rechazan antes de llamar. */
export const MAX_CONTEXT_CHARS = 200_000;

export function buildSystemPrompt(path: string, languageId: string): string {
  return [
    'Eres MagiCode, un asistente de programación integrado en el IDE.',
    `Vas a modificar el archivo \`${path}\` (lenguaje: ${languageId}).`,
    'Reglas de formato OBLIGATORIAS:',
    '1. Responde ÚNICAMENTE con el contenido COMPLETO y NUEVO del archivo, de la primera a la última línea.',
    `2. Ponlo dentro de UN SOLO bloque de código delimitado con tres comillas invertidas (\`\`\`${languageId}).`,
    '3. No escribas explicaciones, comentarios fuera del bloque, diffs ni fragmentos parciales.',
    '4. Conserva todo lo que no haga falta cambiar exactamente igual (formato, orden, comentarios).',
  ].join('\n');
}

export function buildMessages(input: PromptInput): ChatMessage[] {
  const fence = '```';
  const parts: string[] = [
    `Instrucción: ${input.instruction.trim()}`,
    '',
    `Contenido actual de \`${input.path}\`:`,
    `${fence}${input.languageId}`,
    input.fileContent,
    fence,
  ];
  if (input.selection && input.selection.text.trim().length > 0) {
    parts.push(
      '',
      `El usuario seleccionó las líneas ${input.selection.startLine}–${input.selection.endLine}; enfoca el cambio ahí:`,
      `${fence}${input.languageId}`,
      input.selection.text,
      fence,
    );
  }
  parts.push('', 'Devuelve el archivo completo modificado en un único bloque de código.');
  return [
    { role: 'system', content: buildSystemPrompt(input.path, input.languageId) },
    { role: 'user', content: parts.join('\n') },
  ];
}

export interface ExtractedCode {
  code: string;
  /** false si no había bloque delimitado y se usó la respuesta entera */
  fenced: boolean;
  /** true si el bloque no estaba cerrado (respuesta truncada) */
  truncated: boolean;
}

/**
 * Extrae el bloque de código de la respuesta. Si hay varios, toma el más largo. Acepta ``` y ~~~,
 * con o sin etiqueta de lenguaje, y un bloque sin cerrar (respuesta truncada).
 */
export function extractCodeBlock(content: string): ExtractedCode | null {
  const text = content.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const blocks: { code: string; truncated: boolean }[] = [];
  let open: { marker: string; start: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!open) {
      const m = /^\s*(`{3,}|~{3,})[\w.+#-]*\s*.*$/.exec(line);
      if (m) open = { marker: m[1]!, start: i + 1 };
    } else {
      const close = new RegExp(`^\\s*${open.marker[0] === '`' ? '`' : '~'}{${open.marker.length},}\\s*$`);
      if (close.test(line)) {
        blocks.push({ code: lines.slice(open.start, i).join('\n'), truncated: false });
        open = null;
      }
    }
  }
  if (open) blocks.push({ code: lines.slice(open.start).join('\n'), truncated: true });

  if (blocks.length === 0) {
    const trimmed = text.trim();
    return trimmed.length > 0 ? { code: trimmed, fenced: false, truncated: false } : null;
  }
  const best = blocks.reduce((a, b) => (b.code.length > a.code.length ? b : a));
  return { code: best.code, fenced: true, truncated: best.truncated };
}

/** Ajusta saltos de línea al EOL del documento y al salto final del original. */
export function conformText(code: string, eol: '\n' | '\r\n', trailingNewline: boolean): string {
  let body = code.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  if (trailingNewline) body += '\n';
  return eol === '\r\n' ? body.replace(/\n/g, '\r\n') : body;
}

export interface HeaderBag {
  get(name: string): string | null;
}

export interface ParsedSmartAuto {
  requestId: string;
  requestIdSource: 'header' | 'body' | 'local';
  model?: string;
  usage?: TokenUsage;
  content: string;
  finishReason?: string;
  /** la respuesta se declara simulada (mock) */
  simulated: boolean;
  /** proveedor real detrás de Smart Auto (header `x-magihub-provider`, p. ej. "bedrock") */
  provider?: string;
}

const clampId = (s: string) => s.trim().slice(0, 128);

function toInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
}

/** Normaliza `usage` estilo OpenAI al contrato TokenUsage. */
export function parseUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const prompt = toInt(u.prompt_tokens) ?? toInt(u.input_tokens);
  const completion = toInt(u.completion_tokens) ?? toInt(u.output_tokens);
  if (prompt === undefined && completion === undefined && toInt(u.total_tokens) === undefined) return undefined;
  const total = toInt(u.total_tokens) ?? (prompt ?? 0) + (completion ?? 0);
  const details = (u.prompt_tokens_details ?? u.input_tokens_details) as Record<string, unknown> | undefined;
  const cached = toInt(u.cached_tokens) ?? toInt(details?.cached_tokens);
  const candidate = {
    prompt_tokens: prompt ?? 0,
    completion_tokens: completion ?? 0,
    total_tokens: total,
    ...(cached !== undefined ? { cached_tokens: cached } : {}),
  };
  const r = TokenUsage.safeParse(candidate);
  return r.success ? r.data : undefined;
}

/** Request id: header `x-request-id` (o variantes) → body.id → id local. */
export function pickRequestId(headers: HeaderBag, body: unknown, localId: () => string): Pick<ParsedSmartAuto, 'requestId' | 'requestIdSource'> {
  for (const h of ['x-request-id', 'x-magihub-request-id', 'request-id']) {
    const v = headers.get(h);
    if (v && v.trim()) return { requestId: clampId(v), requestIdSource: 'header' };
  }
  const id = body && typeof body === 'object' ? (body as Record<string, unknown>).id : undefined;
  if (typeof id === 'string' && id.trim()) return { requestId: clampId(id), requestIdSource: 'body' };
  return { requestId: `local-${localId()}`, requestIdSource: 'local' };
}

export function isSimulated(headers: HeaderBag, body: unknown): boolean {
  for (const h of ['x-magihub-simulated', 'x-simulated', 'x-magihub-mock']) {
    const v = headers.get(h);
    if (v && /^(1|true|yes)$/i.test(v.trim())) return true;
  }
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (b.simulated === true) return true;
    if (b.system_fingerprint === 'magihub-mock') return true;
  }
  return false;
}

/** Header `x-magihub-provider` normalizado (minúsculas); undefined si no viene. */
export function pickProvider(headers: HeaderBag): string | undefined {
  const v = headers.get('x-magihub-provider')?.trim().toLowerCase();
  return v ? v.slice(0, 40) : undefined;
}

export type UsageSource = 'bedrock' | 'magihub-mock' | 'magihub-response';

/**
 * Origen del `usage` reportado:
 * - simulado explícito (mock) → 'magihub-mock'
 * - `x-magihub-provider: bedrock` → 'bedrock' (tokens reales medidos por Bedrock, aunque la URL sea local)
 * - URL local sin proveedor declarado → 'magihub-mock' (el mock de la demo)
 * - resto → 'magihub-response'
 */
export function usageSourceFor(r: { simulated: boolean; provider?: string }, baseUrl: string): UsageSource {
  if (r.simulated) return 'magihub-mock';
  if (r.provider === 'bedrock') return 'bedrock';
  return isLocalUrl(baseUrl) ? 'magihub-mock' : 'magihub-response';
}

export function parseSmartAutoResponse(headers: HeaderBag, body: unknown, localId: () => string): ParsedSmartAuto {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const choices = Array.isArray(b.choices) ? (b.choices as Array<Record<string, unknown>>) : [];
  const first = choices[0] ?? {};
  const message = (first.message ?? {}) as Record<string, unknown>;
  let content = '';
  if (typeof message.content === 'string') content = message.content;
  else if (Array.isArray(message.content)) {
    content = (message.content as Array<Record<string, unknown>>)
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join('');
  } else if (typeof first.text === 'string') content = first.text;
  const provider = pickProvider(headers);
  return {
    ...pickRequestId(headers, body, localId),
    model: typeof b.model === 'string' ? b.model.slice(0, 120) : undefined,
    usage: parseUsage(b.usage),
    content,
    finishReason: typeof first.finish_reason === 'string' ? first.finish_reason : undefined,
    simulated: isSimulated(headers, body),
    ...(provider ? { provider } : {}),
  };
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** true si la URL apunta a la máquina local (en la demo, el mock de MagiHub). */
export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

export class SmartAutoError extends Error {
  constructor(
    message: string,
    readonly status: 'error' | 'cancelled',
    readonly requestId: string,
    readonly latencyMs: number,
    readonly httpStatus?: number,
    readonly usage?: TokenUsage,
    readonly model?: string,
    readonly simulated = false,
    readonly provider?: string,
  ) {
    super(message);
    this.name = 'SmartAutoError';
  }
}

export interface SmartAutoCall {
  baseUrl: string;
  apiKey: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  localId: () => string;
  now?: () => number;
}

export interface SmartAutoResult extends ParsedSmartAuto {
  latencyMs: number;
  httpStatus: number;
}

/** POST /v1/chat/completions (no streaming). Lanza SmartAutoError con requestId/latencia en fallos. */
export async function callSmartAuto(call: SmartAutoCall): Promise<SmartAutoResult> {
  const fetchImpl = call.fetchImpl ?? (globalThis.fetch as FetchLike);
  const now = call.now ?? Date.now;
  const started = now();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), call.timeoutMs ?? 120_000);
  const onAbort = () => timeout.abort();
  call.signal?.addEventListener('abort', onAbort);
  try {
    let res: Response;
    try {
      res = await fetchImpl(joinUrl(call.baseUrl, '/v1/chat/completions'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${call.apiKey}`,
        },
        body: JSON.stringify({ model: SMART_AUTO_MODEL, messages: call.messages, stream: false, temperature: 0.2 }),
        signal: timeout.signal,
      });
    } catch (err) {
      const cancelled = call.signal?.aborted === true;
      throw new SmartAutoError(
        cancelled ? 'Cancelado por el usuario' : `No se pudo contactar a MagiHub: ${(err as Error).message}`,
        cancelled ? 'cancelled' : 'error',
        `local-${call.localId()}`,
        Math.max(0, Math.round(now() - started)),
      );
    }
    const latencyMs = Math.max(0, Math.round(now() - started));
    let body: unknown = undefined;
    const text = await res.text().catch(() => '');
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    const parsed = parseSmartAutoResponse(res.headers, body, call.localId);
    if (!res.ok) {
      const errObj = body && typeof body === 'object' ? (body as Record<string, unknown>).error : undefined;
      const detail =
        errObj && typeof errObj === 'object' && typeof (errObj as Record<string, unknown>).message === 'string'
          ? String((errObj as Record<string, unknown>).message)
          : typeof errObj === 'string'
            ? errObj
            : res.statusText;
      throw new SmartAutoError(
        `MagiHub respondió ${res.status}: ${detail}`.slice(0, 300),
        'error',
        parsed.requestId,
        latencyMs,
        res.status,
        parsed.usage,
        parsed.model,
        parsed.simulated,
        parsed.provider,
      );
    }
    if (!body) {
      throw new SmartAutoError('Respuesta de MagiHub no es JSON', 'error', parsed.requestId, latencyMs, res.status);
    }
    return { ...parsed, latencyMs, httpStatus: res.status };
  } finally {
    clearTimeout(timer);
    call.signal?.removeEventListener('abort', onAbort);
  }
}

/** GET /v1/keys/self — valida la key y devuelve su identidad (sin la key). */
export async function fetchKeyIdentity(
  baseUrl: string,
  apiKey: string,
  fetchImpl: FetchLike = globalThis.fetch as FetchLike,
): Promise<{ ok: true; identity: KeyIdentity } | { ok: false; status?: number; message: string }> {
  let res: Response;
  try {
    res = await fetchImpl(joinUrl(baseUrl, '/v1/keys/self'), {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { ok: false, message: `No se pudo contactar a MagiHub (${(err as Error).message})` };
  }
  if (!res.ok) return { ok: false, status: res.status, message: `MagiHub respondió ${res.status}` };
  const body = await res.json().catch(() => undefined);
  const candidate = body && typeof body === 'object' && 'data' in body ? (body as { data: unknown }).data : body;
  const parsed = KeyIdentity.safeParse(candidate);
  if (!parsed.success) return { ok: false, status: res.status, message: 'Respuesta de /v1/keys/self inesperada' };
  return { ok: true, identity: parsed.data };
}
