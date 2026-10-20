import { BadRequestException } from '../exceptions';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export const iso = (ms: number): string => new Date(ms).toISOString();

/** Normaliza un ISO cualquiera (con offset) a ISO UTC `...Z` — para ordenar lexicográficamente. */
export function toUtcIso(v: string): string {
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new BadRequestException(`Fecha inválida: ${v}`, 'INVALID_DATE');
  return new Date(ms).toISOString();
}

/** Ventana [from, to] con defaults (últimos `defaultDays`) y tope de días. */
export function resolveWindow(
  from: string | undefined,
  to: string | undefined,
  opts: { defaultDays?: number; maxDays?: number; now?: number } = {},
): { from: string; to: string } {
  const now = opts.now ?? Date.now();
  const toMs = to ? Date.parse(toUtcIso(to)) : now;
  const fromMs = from ? Date.parse(toUtcIso(from)) : toMs - (opts.defaultDays ?? 7) * DAY_MS;
  if (fromMs > toMs) throw new BadRequestException('`from` debe ser anterior a `to`', 'INVALID_WINDOW');
  if (opts.maxDays && toMs - fromMs > opts.maxDays * DAY_MS) {
    throw new BadRequestException(`La ventana máxima es de ${opts.maxDays} días`, 'WINDOW_TOO_LARGE');
  }
  return { from: iso(fromMs), to: iso(toMs) };
}

export const floorTo = (ms: number, bucketMs: number): number => Math.floor(ms / bucketMs) * bucketMs;
