/**
 * Formato de cifras y fechas del dashboard (locale `es`).
 * - Miles con espacio fino (U+202F), como en el diseño: 184 320.
 * - Decimales con coma: 0,67 · 49,9 %.
 * - Signo menos tipográfico (U+2212).
 * - null/undefined/NaN → "—" (la UI añade el tooltip "sin denominador").
 */
export const EMPTY = '—';
export const THIN_SPACE = ' ';
const NBSP = ' ';
const MINUS = '−';

const formatters = new Map<string, Intl.NumberFormat>();
function numberFormat(decimals: number): Intl.NumberFormat {
  const key = String(decimals);
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat('es', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      // 'always': agrupa también 4 cifras (1 286); el `es` por defecto no lo hace.
      useGrouping: 'always' as unknown as boolean,
    });
    formatters.set(key, f);
  }
  return f;
}

export function isPresent(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 184320 → "184 320"; 383.94 (1) → "383,9". */
export function formatNumber(v: number | null | undefined, decimals = 0): string {
  if (!isPresent(v)) return EMPTY;
  return numberFormat(decimals)
    .formatToParts(v)
    .map((p) => (p.type === 'group' ? THIN_SPACE : p.type === 'minusSign' ? MINUS : p.value))
    .join('');
}

/** Proporción 0..1 → "49,9 %". */
export function formatPercent(ratio: number | null | undefined, decimals = 1): string {
  if (!isPresent(ratio)) return EMPTY;
  const pct = ratio * 100;
  // Enteros sin decimales: "64 %" en lugar de "64,0 %".
  const d = Number.isInteger(Math.round(pct * 10 ** decimals) / 10 ** decimals) ? 0 : decimals;
  return `${formatNumber(pct, d)}${NBSP}%`;
}

/** Puntuación 0..1 con 2 decimales: 0.6649 → "0,66". */
export function formatScore(v: number | null | undefined): string {
  return formatNumber(v, 2);
}

/** Números con signo para diffs: +38 / −4. */
export function formatSigned(v: number, sign: '+' | '-'): string {
  return `${sign === '+' ? '+' : MINUS}${formatNumber(Math.abs(v))}`;
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
const pad = (n: number) => String(n).padStart(2, '0');

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "16 oct" (hora local). */
export function formatDay(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "16 oct 10:02". */
export function formatDateTime(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  return `${formatDay(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "14 – 20 oct 2026" / "28 sept – 4 oct 2026" / "28 dic 2025 – 3 ene 2026". */
export function formatRange(from: string | Date, to: string | Date): string {
  const a = toDate(from);
  const b = toDate(to);
  if (!a || !b) return EMPTY;
  const sep = ' – ';
  if (a.getFullYear() !== b.getFullYear()) {
    return `${formatDay(a)} ${a.getFullYear()}${sep}${formatDay(b)} ${b.getFullYear()}`;
  }
  if (a.getMonth() === b.getMonth()) {
    if (a.getDate() === b.getDate()) return `${formatDay(b)} ${b.getFullYear()}`;
    return `${a.getDate()}${sep}${formatDay(b)} ${b.getFullYear()}`;
  }
  return `${formatDay(a)}${sep}${formatDay(b)} ${b.getFullYear()}`;
}

/** "hace 12 min", "hace 2 h", "hace 3 d"; desde una semana, la fecha. */
export function formatAgo(value: string | Date | null | undefined, now = Date.now()): string {
  const d = toDate(value);
  if (!d) return EMPTY;
  const s = Math.max(0, Math.round((now - d.getTime()) / 1000));
  if (s < 60) return 'hace un momento';
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h} h`;
  const days = Math.floor(h / 24);
  if (days < 7) return `hace ${days} d`;
  return formatDay(d);
}

/** Duración entre dos instantes: "1 h 25 min". */
export function formatDuration(from: string | null | undefined, to: string | null | undefined): string {
  const a = toDate(from);
  const b = toDate(to);
  if (!a || !b) return EMPTY;
  const min = Math.max(0, Math.round((b.getTime() - a.getTime()) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/** SHA corto (12) para mostrar. */
export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 12) : EMPTY;
}
