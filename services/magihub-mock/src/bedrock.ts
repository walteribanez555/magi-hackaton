import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
  type Message,
  type SystemContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import type { TokenUsage } from '@magicode/contracts';
import { textOf, type ChatMessage } from './completions';

/**
 * Proveedor REAL de MagiHub "Smart Auto" sobre Amazon Bedrock (Converse API).
 *
 * - MAGIHUB_PROVIDER=bedrock|mock (default mock: local/tests sin AWS).
 * - Smart Auto: prompts cortos y simples → SMART_AUTO_FAST_MODEL; largos o con señales de
 *   trabajo grande (refactor, arquitectura, varios archivos) → SMART_AUTO_STRONG_MODEL.
 * - Los IDs son inference profiles (global./us.): el rol necesita InvokeModel sobre el profile
 *   Y sobre el foundation-model subyacente en todas las regiones a las que enruta.
 */

export type ProviderName = 'bedrock' | 'mock';

export const providerName = (): ProviderName => (process.env.MAGIHUB_PROVIDER === 'bedrock' ? 'bedrock' : 'mock');

export const DEFAULT_FAST_MODEL = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';
export const DEFAULT_STRONG_MODEL = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

export interface SmartAutoConfig {
  fastModel: string;
  strongModel: string;
  maxTokens: number;
  /** umbral de caracteres del prompt para considerar "corto" */
  shortPromptChars: number;
  /** timeout por llamada a Bedrock (ms); la Lambda corre con 120 s */
  timeoutMs: number;
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export const smartAutoConfig = (e: NodeJS.ProcessEnv = process.env): SmartAutoConfig => ({
  fastModel: e.SMART_AUTO_FAST_MODEL || DEFAULT_FAST_MODEL,
  strongModel: e.SMART_AUTO_STRONG_MODEL || DEFAULT_STRONG_MODEL,
  maxTokens: num(e.SMART_AUTO_MAX_TOKENS, 4096),
  shortPromptChars: num(e.SMART_AUTO_SHORT_PROMPT_CHARS, 1500),
  timeoutMs: num(e.BEDROCK_TIMEOUT_MS, 110_000),
});

// ── Smart Auto routing ──────────────────────────────────────────────────────────

/** Señales de tarea grande (es/en) que fuerzan el modelo fuerte aunque el prompt sea corto. */
const STRONG_SIGNALS =
  /\b(refactor\w*|arquitectur\w*|architect\w*|varios archivos|m[uú]ltiples archivos|multiple files|multi-?file|across (the )?(codebase|repo)|migra(r|ci[oó]n) (el|la|todo)|redise[nñ]\w*)/i;

export type RouteTier = 'fast' | 'strong';

export interface RouteDecision {
  tier: RouteTier;
  model: string;
  reason: 'short_prompt' | 'long_prompt' | 'strong_signal';
  promptChars: number;
}

export function routeSmartAuto(messages: ChatMessage[], cfg: SmartAutoConfig = smartAutoConfig()): RouteDecision {
  const promptChars = messages.reduce((a, m) => a + textOf(m).length, 0);
  const text = messages.map(textOf).join('\n');
  if (STRONG_SIGNALS.test(text)) return { tier: 'strong', model: cfg.strongModel, reason: 'strong_signal', promptChars };
  if (promptChars >= cfg.shortPromptChars) return { tier: 'strong', model: cfg.strongModel, reason: 'long_prompt', promptChars };
  return { tier: 'fast', model: cfg.fastModel, reason: 'short_prompt', promptChars };
}

// ── Mapeo OpenAI → Converse ─────────────────────────────────────────────────────

export interface ConverseInput {
  system: SystemContentBlock[];
  messages: Message[];
}

/**
 * OpenAI messages → Converse:
 * - system/developer → `system` (en orden).
 * - user/assistant (tool → user) → `messages`; los turnos consecutivos del mismo rol se unen
 *   (Converse exige alternancia) y los textos vacíos se descartan.
 * - Converse exige que la conversación empiece con `user`.
 */
export function toConverse(messages: ChatMessage[]): ConverseInput {
  const system: SystemContentBlock[] = [];
  const out: Message[] = [];
  for (const m of messages) {
    const text = textOf(m);
    if (!text.trim()) continue;
    if (m.role === 'system' || m.role === 'developer') {
      system.push({ text });
      continue;
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const last = out[out.length - 1];
    if (last && last.role === role) last.content!.push({ text });
    else out.push({ role, content: [{ text }] });
  }
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: [{ text: '(continúa)' }] });
  return { system, messages: out };
}

const FINISH: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  guardrail_intervened: 'content_filter',
  content_filtered: 'content_filter',
};
export const finishReasonOf = (stopReason: string | undefined): string => FINISH[stopReason ?? ''] ?? 'stop';

// ── Precios (USD por millón de tokens) ──────────────────────────────────────────
/**
 * Precios on-demand públicos de Amazon Bedrock (aws.amazon.com/bedrock/pricing, revisados
 * 2026-10, contexto ≤ 200K). Supuesto: los inference profiles geográficos (`us.`) cuestan
 * +10% sobre el global (`global.`). cache_read se cobra aparte del input no cacheado.
 * Modelo sin precio conocido ⇒ cost_usd = undefined (no se inventa).
 */
export const PRICES_PER_MTOK: Record<string, { input: number; output: number; cacheRead: number }> = {
  'global.anthropic.claude-haiku-4-5-20251001-v1:0': { input: 1, output: 5, cacheRead: 0.1 },
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': { input: 1.1, output: 5.5, cacheRead: 0.11 },
  'global.anthropic.claude-sonnet-4-5-20250929-v1:0': { input: 3, output: 15, cacheRead: 0.3 },
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0': { input: 3.3, output: 16.5, cacheRead: 0.33 },
};

export function bedrockCostOf(model: string, usage: TokenUsage): number | undefined {
  const p = PRICES_PER_MTOK[model];
  if (!p) return undefined;
  const cached = usage.cached_tokens ?? 0;
  const usd = (usage.prompt_tokens * p.input + usage.completion_tokens * p.output + cached * p.cacheRead) / 1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

// ── Cliente + invocación ────────────────────────────────────────────────────────

/** Lo mínimo que se usa del cliente (inyectable en tests). */
export interface BedrockLike {
  send(cmd: ConverseCommand, opts?: { abortSignal?: AbortSignal }): Promise<ConverseCommandOutput>;
}

let client: BedrockRuntimeClient | undefined;
/** Cliente único por contenedor; reintentos estándar del SDK (throttling/5xx) con 3 intentos. */
export const bedrockClient = (): BedrockLike =>
  (client ??= new BedrockRuntimeClient({
    region: process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1',
    maxAttempts: num(process.env.BEDROCK_MAX_ATTEMPTS, 3),
  })) as unknown as BedrockLike;

export interface CompletionParams {
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
}

export interface CompletionResult {
  content: string;
  model: string;
  route: RouteDecision;
  requestId: string;
  usage: TokenUsage;
  finishReason: string;
  latencyMs: number;
  bedrockLatencyMs?: number;
}

/** Error de Bedrock traducido a status HTTP / tipo OpenAI. */
export class BedrockError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 429 | 502 | 504,
    readonly type: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

export function mapBedrockError(e: unknown): BedrockError {
  const err = e as { name?: string; message?: string; $metadata?: { requestId?: string } };
  const name = err?.name ?? 'Error';
  const msg = `Bedrock ${name}: ${err?.message ?? 'unknown error'}`;
  const rid = err?.$metadata?.requestId;
  switch (name) {
    case 'ValidationException':
      return new BedrockError(msg, 400, 'invalid_request_error', rid);
    case 'AccessDeniedException':
      return new BedrockError(msg, 403, 'provider_access_denied', rid);
    case 'ThrottlingException':
    case 'ServiceQuotaExceededException':
      return new BedrockError(msg, 429, 'rate_limit_exceeded', rid);
    case 'ModelTimeoutException':
    case 'AbortError':
    case 'TimeoutError':
      return new BedrockError(msg, 504, 'provider_timeout', rid);
    default:
      return new BedrockError(msg, 502, 'provider_error', rid);
  }
}

export async function converseSmartAuto(
  params: CompletionParams,
  bedrock: BedrockLike = bedrockClient(),
  cfg: SmartAutoConfig = smartAutoConfig(),
): Promise<CompletionResult> {
  const route = routeSmartAuto(params.messages, cfg);
  const { system, messages } = toConverse(params.messages);
  if (!messages.length) throw new BedrockError('`messages` needs at least one non-empty user/assistant message', 400, 'invalid_request_error');

  const maxTokens = Math.min(Math.max(1, Math.floor(params.max_tokens ?? cfg.maxTokens)), cfg.maxTokens);
  const stop = params.stop === undefined ? undefined : Array.isArray(params.stop) ? params.stop : [params.stop];
  const inferenceConfig = {
    maxTokens,
    ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
    // Algunos modelos rechazan temperature y topP a la vez: topP solo si no hay temperature.
    ...(typeof params.top_p === 'number' && typeof params.temperature !== 'number' ? { topP: params.top_p } : {}),
    ...(stop?.length ? { stopSequences: stop.slice(0, 4) } : {}),
  };

  const started = Date.now();
  let res: ConverseCommandOutput;
  try {
    res = await bedrock.send(
      new ConverseCommand({
        modelId: route.model,
        ...(system.length ? { system } : {}),
        messages,
        inferenceConfig,
      }),
      { abortSignal: AbortSignal.timeout(cfg.timeoutMs) },
    );
  } catch (e) {
    throw mapBedrockError(e);
  }

  const content = (res.output?.message?.content ?? []).map((b) => b.text ?? '').join('');
  const u: Partial<NonNullable<ConverseCommandOutput['usage']>> = res.usage ?? {};
  const cached = u.cacheReadInputTokens ?? 0;
  const usage: TokenUsage = {
    prompt_tokens: u.inputTokens ?? 0,
    completion_tokens: u.outputTokens ?? 0,
    total_tokens: u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
    ...(cached ? { cached_tokens: cached } : {}),
  };
  const requestId = res.$metadata?.requestId;
  if (!requestId) throw new BedrockError('Bedrock response without requestId', 502, 'provider_error');

  return {
    content,
    model: route.model,
    route,
    requestId,
    usage,
    finishReason: finishReasonOf(res.stopReason),
    latencyMs: Date.now() - started,
    ...(typeof res.metrics?.latencyMs === 'number' ? { bedrockLatencyMs: res.metrics.latencyMs } : {}),
  };
}
