/** HTTP común de los clientes Jira/Linear: timeout, reintentos 429/5xx con Retry-After, errores sin secretos. */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** 429 / 5xx / red / timeout ⇒ se reintenta; 4xx ⇒ permanente */
    readonly transient: boolean,
  ) {
    super(message.slice(0, 500));
    this.name = 'ProviderError';
  }
}

export interface HttpOptions {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** reintentos DENTRO de la invocación (además del reintento del stream) */
  retries?: number;
  /** tope de espera por Retry-After (la Lambda tiene tiempo limitado) */
  maxWaitMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Mensaje de error legible del cuerpo del proveedor (Jira: errorMessages/errors; GraphQL: errors[].message). */
export function errorSummary(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const b = body as { errorMessages?: unknown; errors?: unknown; message?: unknown };
  const parts: string[] = [];
  if (Array.isArray(b.errorMessages)) parts.push(...b.errorMessages.map(String));
  if (Array.isArray(b.errors)) parts.push(...b.errors.map((e) => String((e as { message?: unknown })?.message ?? e)));
  else if (b.errors && typeof b.errors === 'object') {
    parts.push(...Object.entries(b.errors as Record<string, unknown>).map(([k, v]) => `${k}: ${String(v)}`));
  }
  if (typeof b.message === 'string') parts.push(b.message);
  return parts.join('; ').slice(0, 300);
}

export async function requestJson<T = unknown>(
  url: string,
  init: RequestInit,
  opts: HttpOptions & { label: string },
): Promise<{ status: number; body: T | null }> {
  const doFetch = opts.fetch ?? (globalThis.fetch as FetchLike);
  const sleep = opts.sleep ?? defaultSleep;
  const retries = opts.retries ?? 2;
  const maxWait = opts.maxWaitMs ?? 5000;
  let lastErr: ProviderError | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      lastErr = new ProviderError(`${opts.label}: ${timeout ? 'timeout' : 'error de red'}`, null, true);
      if (attempt < retries) await sleep(Math.min(maxWait, 500 * 2 ** attempt));
      continue;
    }
    const text = await res.text().catch(() => '');
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (res.ok) return { status: res.status, body: body as T | null };

    const transient = res.status === 429 || res.status >= 500;
    const summary = errorSummary(body);
    lastErr = new ProviderError(`${opts.label}: HTTP ${res.status}${summary ? ` — ${summary}` : ''}`, res.status, transient);
    if (!transient || attempt >= retries) throw lastErr;
    const wait = retryAfterMs(res.headers.get('retry-after')) ?? 500 * 2 ** attempt;
    if (wait > maxWait) throw lastErr; // mejor devolver al stream que agotar el timeout de la Lambda
    await sleep(wait);
  }
  throw lastErr ?? new ProviderError(`${opts.label}: error desconocido`, null, true);
}

/** Comparación de nombres de estado: sin mayúsculas, acentos ni espacios repetidos. */
export const normalizeName = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
