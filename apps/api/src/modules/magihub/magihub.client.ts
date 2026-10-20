import { KeyIdentity, UsageResponse } from '@magicode/contracts';
import { config } from '../../config/config';
import { createLogger } from '../../config/logger';
import {
  MagiHubAuthError,
  MagiHubUnavailableError,
  MagiHubUnsupportedError,
  type MagiHubClient,
  type UsageQuery,
} from './magihub.types';

const logger = createLogger('MagiHub');

export interface HttpMagiHubOptions {
  baseUrl: string;
  keysSelfPath: string;
  usagePath: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** Cliente HTTP de MagiHub: fetch + timeout + validación de respuestas con los schemas de contracts. */
export class HttpMagiHubClient implements MagiHubClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: HttpMagiHubOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async get(apiKey: string, path: string, params?: Record<string, string>): Promise<{ status: number; body: unknown }> {
    const url = new URL(this.opts.baseUrl + path);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      logger.warn('MagiHub request failed', { path, reason });
      throw new MagiHubUnavailableError(`MagiHub no responde (${reason})`);
    }
    const text = await res.text();
    let body: unknown = undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  async whoami(apiKey: string): Promise<KeyIdentity> {
    const { status, body } = await this.get(apiKey, this.opts.keysSelfPath);
    if (status === 401 || status === 403) throw new MagiHubAuthError(status);
    if (status !== 200) throw new MagiHubUnavailableError(`MagiHub keys/self respondió ${status}`);
    const parsed = KeyIdentity.safeParse(body);
    if (!parsed.success) throw new MagiHubUnavailableError('MagiHub keys/self: respuesta fuera de contrato');
    return parsed.data;
  }

  async usage(apiKey: string, q: UsageQuery): Promise<UsageResponse> {
    const { status, body } = await this.get(apiKey, this.opts.usagePath, {
      from: q.from,
      to: q.to,
      granularity: q.granularity,
    });
    if (status === 401 || status === 403) throw new MagiHubAuthError(status);
    if (status === 400 || status === 404 || status === 422) {
      throw new MagiHubUnsupportedError(status, `MagiHub usage no acepta granularity=${q.granularity} (${status})`);
    }
    if (status !== 200) throw new MagiHubUnavailableError(`MagiHub usage respondió ${status}`);
    const parsed = UsageResponse.safeParse(body);
    if (!parsed.success) throw new MagiHubUnavailableError('MagiHub usage: respuesta fuera de contrato');
    return parsed.data;
  }
}

let client: MagiHubClient | undefined;

/** Cliente por defecto (desde config). Los tests pueden sustituirlo con `setMagiHubClient`. */
export function getMagiHubClient(): MagiHubClient {
  if (client) return client;
  const m = config.getValue('magihub');
  client = new HttpMagiHubClient({
    baseUrl: m.baseUrl,
    keysSelfPath: m.keysSelfPath,
    usagePath: m.usagePath,
    timeoutMs: m.timeoutMs,
  });
  return client;
}

export function setMagiHubClient(c: MagiHubClient | undefined): void {
  client = c;
}
