import { extractTaskKeys, type IntegrationProvider, type RepoCommitRef } from '@magicode/contracts';

/** SHA "vacío" que usan GitHub/GitLab para refs creadas/borradas. */
export const ZERO_SHA = '0000000000000000000000000000000000000000';
export const isZeroSha = (sha: string | undefined | null): boolean => !sha || /^0+$/.test(sha);

export type Json = Record<string, unknown>;

export const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
/** author_login del PR (solo si el proveedor lo trae; sin espacios). */
export const authorOf = (login: string | undefined): { author_login?: string } => {
  const v = login?.trim();
  return v ? { author_login: v } : {};
};
export const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined;

/** Fecha del proveedor → ISO UTC; acepta ISO, "+0000" sin dos puntos (Jira) y epoch ms. */
export function toIso(v: unknown, fallback: string): string {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v !== 'string' || !v) return fallback;
  let ms = Date.parse(v);
  if (Number.isNaN(ms)) ms = Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(ms) ? fallback : new Date(ms).toISOString();
}

const SESSION_TRAILER = /^\s*MagiCode-Session:\s*(\S+)\s*$/im;
const TASK_TRAILER = /^\s*MagiCode-Task:\s*(.+)$/gim;

/** Trailers de MagiCode en el mensaje del commit (el mensaje NO se guarda; solo esto). */
export function parseTrailers(message: string | undefined): { session_id?: string; task_keys: string[] } {
  if (!message) return { task_keys: [] };
  const session = SESSION_TRAILER.exec(message)?.[1];
  const taskValues = [...message.matchAll(TASK_TRAILER)].map((m) => m[1]);
  return {
    ...(session ? { session_id: session.slice(0, 128) } : {}),
    task_keys: extractTaskKeys(...taskValues),
  };
}

/** Construye un RepoCommitRef a partir de los pocos campos que interesan (sin mensaje, sin diff). */
export function commitRef(input: {
  sha: string;
  message?: string;
  author_login?: string;
  timestamp: string;
  added?: unknown;
  modified?: unknown;
  removed?: unknown;
}): RepoCommitRef {
  const trailers = parseTrailers(input.message);
  const keys = new Set([...extractTaskKeys(input.message), ...trailers.task_keys]);
  return {
    sha: input.sha,
    message_task_keys: [...keys],
    ...(input.author_login ? { author_login: input.author_login } : {}),
    timestamp: input.timestamp,
    files_added: arr(input.added).length,
    files_modified: arr(input.modified).length,
    files_removed: arr(input.removed).length,
    has_session_trailer: !!trailers.session_id,
    ...(trailers.session_id ? { session_id: trailers.session_id } : {}),
  };
}

/** refs/heads/x → {type:'branch', name:x}; refs/tags/v1 → {type:'tag', name:'v1'}. */
export function parseRef(ref: string | undefined): { type: 'branch' | 'tag'; name: string } | null {
  if (!ref) return null;
  if (ref.startsWith('refs/heads/')) return { type: 'branch', name: ref.slice('refs/heads/'.length) };
  if (ref.startsWith('refs/tags/')) return { type: 'tag', name: ref.slice('refs/tags/'.length) };
  return null;
}

/** Statuscategory de Jira → categoría normalizada. */
export function jiraStatusCategory(key: string | undefined): 'todo' | 'in_progress' | 'done' {
  switch ((key ?? '').toLowerCase()) {
    case 'indeterminate':
      return 'in_progress';
    case 'done':
      return 'done';
    case 'new':
    default:
      return 'todo';
  }
}

export const base = <P extends IntegrationProvider>(
  input: { delivery_id: string; integration_id: string; received_at: string },
  provider: P,
) => ({
  delivery_id: input.delivery_id,
  integration_id: input.integration_id,
  provider,
  received_at: input.received_at,
});
