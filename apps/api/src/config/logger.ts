import { config, type LogLevel } from './config';
import type { ILogger } from './types';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Claves que nunca se escriben en logs (la API key viaja en Authorization).
const SENSITIVE_KEY = /^(authorization|x-api-key|api[_-]?key|apikey|password|secret|cookie|set-cookie|raw_key|key_raw)$/i;
// Valores con pinta de credencial aunque vengan bajo otra clave.
const SENSITIVE_VALUE = /^(bearer\s+\S+|mh_[A-Za-z0-9_\-]{4,}|sk-[A-Za-z0-9]{8,})$/i;

/** Redacta recursivamente credenciales antes de serializar. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return SENSITIVE_VALUE.test(value.trim()) ? '[REDACTED]' : value;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Logger JSON estructurado (una línea por evento → CloudWatch Logs Insights). */
class Logger implements ILogger {
  constructor(
    private readonly context: string = 'App',
    private readonly base: Record<string, unknown> = {},
  ) {}

  private write(level: LogLevel, message: string, data?: unknown): void {
    if (LEVELS[level] < LEVELS[config.getValue('logLevel')] ) return;
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      context: this.context,
      msg: message,
      ...this.base,
    };
    if (data !== undefined) entry.data = redact(data);
    const line = JSON.stringify(entry);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  debug(message: string, data?: unknown): void { this.write('debug', message, data); }
  info(message: string, data?: unknown): void { this.write('info', message, data); }
  warn(message: string, data?: unknown): void { this.write('warn', message, data); }
  error(message: string, error?: unknown): void { this.write('error', message, error); }

  child(fields: Record<string, unknown>): ILogger {
    return new Logger(this.context, { ...this.base, ...(redact(fields) as Record<string, unknown>) });
  }
}

export const createLogger = (context?: string, base?: Record<string, unknown>): ILogger => new Logger(context, base);
export default Logger;
