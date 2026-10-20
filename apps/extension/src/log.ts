/**
 * Logger con redacción de secretos. Puro: el sink real (OutputChannel) se inyecta desde extension.ts.
 */

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string, err?: unknown): void;
}

const PATTERNS: RegExp[] = [
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, // Authorization headers
  /\b(sk|mh|mhk|magihub)[-_][A-Za-z0-9_-]{8,}\b/gi, // prefijos típicos de API keys
  /(\/\/[^/\s:@]+:)[^@\s/]+@/g, // credenciales en URLs: https://user:token@host
];

/** Quita secretos conocidos y patrones típicos de claves. */
export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('«redacted»');
  }
  out = out.replace(PATTERNS[0]!, '$1«redacted»');
  out = out.replace(PATTERNS[1]!, '«redacted-key»');
  out = out.replace(PATTERNS[2]!, '$1«redacted»@');
  return out;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Logger que redacta antes de escribir en `sink`. `getSecrets` devuelve las claves vigentes. */
export function createLogger(sink: (line: string) => void, getSecrets: () => readonly (string | undefined)[] = () => []): Logger {
  const write = (level: string, msg: string) => {
    const ts = new Date().toISOString().slice(11, 23);
    sink(`[${ts}] ${level.padEnd(5)} ${redact(msg, getSecrets())}`);
  };
  return {
    debug: (m) => write('debug', m),
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m, err) => write('error', err === undefined ? m : `${m}: ${errorMessage(err)}`),
  };
}

export const nullLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
