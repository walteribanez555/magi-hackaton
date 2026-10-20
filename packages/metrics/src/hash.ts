import { createHash, createHmac } from 'node:crypto';

/** Normaliza una línea: recorta extremos y colapsa espacios internos a uno solo. */
export function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

/**
 * Hash de línea que puede viajar al backend: HMAC-SHA256(salt, línea_normalizada) → 16 hex.
 * El salt es de sesión: sin él no se puede hacer diccionario de líneas comunes.
 */
export function hashLine(salt: string, normalized: string): string {
  return createHmac('sha256', salt).update(normalized, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Huella del contenido generado (detecta regeneraciones redundantes sin guardar código):
 * sha256 de las líneas normalizadas no vacías unidas por `\n` → 16 hex.
 * Insensible a indentación, espacios y líneas en blanco.
 */
export function outputHash(text: string): string {
  const body = splitLines(text)
    .map(normalizeLine)
    .filter((l) => l.length > 0)
    .join('\n');
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Huella determinista de un parche: rutas ordenadas + hashes de línea (en su orden) → 16 hex.
 * El orden de los archivos de entrada no afecta el resultado.
 */
export function patchHash(files: Array<{ path: string; lineHashes: string[] }>): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const h = createHash('sha256');
  for (const f of sorted) {
    h.update(`${f.path}\u0000${f.lineHashes.join(',')}\u0001`, 'utf8');
  }
  return h.digest('hex').slice(0, 16);
}

/** Divide en líneas aceptando LF y CRLF. */
export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Redondea a 4 decimales (evita ruido de coma flotante en payloads). */
export function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Acota a [0, 1] y redondea a 4 decimales. */
export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return round4(Math.min(1, Math.max(0, n)));
}

/** Cociente seguro (0 si el denominador es 0) acotado a [0, 1]. */
export function ratio(num: number, den: number): number {
  return den > 0 ? clamp01(num / den) : 0;
}
