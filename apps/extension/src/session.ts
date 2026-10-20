/**
 * Estado local de la sesión MagiCode (se guarda en workspaceState: NUNCA se envía).
 * Contiene la sal de la sesión y los hashes de las líneas aceptadas — no código.
 * Puro: no importa 'vscode'.
 */
import { randomBytes, randomUUID } from 'node:crypto';

export interface StoredChange {
  change_id: string;
  ai_request_id: string;
  paths: string[];
  lineHashes: string[];
  effectiveWeights: Record<string, number>;
  accepted_at: string;
  accepted_lines: number;
  effective_lines: number;
  /** hashes aún no vistos en ningún commit (undefined = todos) */
  pending_hashes?: string[];
}

export interface CommitRecord {
  sha: string;
  committed_at: string;
  change_ids: string[];
  ai_share: number;
  ai_matched_lines: number;
  has_session_trailer: boolean;
}

export interface ReferenceRecord {
  tag: string;
  sha: string;
  included_shas: string[];
  surviving_lines: number;
  surviving_effective_lines: number;
  marked_at: string;
}

export interface SessionStats {
  requests: number;
  request_errors: number;
  tokens_reported: number;
  proposed: number;
  accepted: number;
  rejected: number;
  accepted_lines: number;
  effective_lines: number;
  commits: number;
  ai_committed_lines: number;
  /** peticiones por modelo enrutado por Smart Auto (opcional: sesiones guardadas antes no lo traen) */
  models?: Record<string, number>;
  last_model?: string;
  last_usage_source?: 'bedrock' | 'magihub-mock' | 'magihub-response';
}

export interface SessionState {
  id: string;
  /** sal HMAC de la sesión: solo local */
  salt: string;
  started_at: string;
  last_activity_at: string;
  repo_root: string;
  stats: SessionStats;
  changes: StoredChange[];
  commits: CommitRecord[];
  processed_shas: string[];
  last_head?: string;
  reference?: ReferenceRecord;
}

export const SESSION_KEY = 'magicode.session';
export const TASK_OVERRIDE_KEY = 'magicode.taskOverride';
/** Una sesión sin actividad durante más de esto no se reanuda al reabrir la ventana. */
export const SESSION_RESUME_MAX_IDLE_MS = 8 * 60 * 60 * 1000;
const MAX_PROCESSED = 500;

export function emptyStats(): SessionStats {
  return {
    requests: 0,
    request_errors: 0,
    tokens_reported: 0,
    proposed: 0,
    accepted: 0,
    rejected: 0,
    accepted_lines: 0,
    effective_lines: 0,
    commits: 0,
    ai_committed_lines: 0,
  };
}

export function createSession(repoRoot: string, now: Date = new Date(), headSha?: string): SessionState {
  return {
    id: randomUUID(),
    salt: randomBytes(32).toString('hex'),
    started_at: now.toISOString(),
    last_activity_at: now.toISOString(),
    repo_root: repoRoot,
    stats: emptyStats(),
    changes: [],
    commits: [],
    processed_shas: headSha ? [headSha] : [],
    last_head: headSha,
  };
}

export function isResumable(s: SessionState | undefined, repoRoot: string, now: Date = new Date()): s is SessionState {
  if (!s || s.repo_root !== repoRoot) return false;
  const last = Date.parse(s.last_activity_at);
  return Number.isFinite(last) && now.getTime() - last < SESSION_RESUME_MAX_IDLE_MS;
}

export function touch(s: SessionState, now: Date = new Date()): void {
  s.last_activity_at = now.toISOString();
}

/** Hashes ya aceptados en la sesión (señal `repeated_in_session`). */
export function sessionAcceptedHashes(s: SessionState): Set<string> {
  const out = new Set<string>();
  for (const c of s.changes) for (const h of c.lineHashes) out.add(h);
  return out;
}

export interface ChangeRef {
  change_id: string;
  lineHashes: string[];
  effectiveWeights: Record<string, number>;
}

/** Todos los cambios aceptados (para supervivencia en la versión de referencia). */
export function acceptedForMatching(s: SessionState): ChangeRef[] {
  return s.changes.map((c) => ({ change_id: c.change_id, lineHashes: c.lineHashes, effectiveWeights: c.effectiveWeights }));
}

/**
 * Cambios con líneas aún no registradas en Git (matchCommit pide pasar solo esos: si un cambio
 * ya casó en un commit anterior, sus líneas ya registradas no deben contarse como perdidas).
 */
export function pendingForCommit(s: SessionState): ChangeRef[] {
  const out: ChangeRef[] = [];
  for (const c of s.changes) {
    const pending = c.pending_hashes ?? c.lineHashes;
    if (pending.length > 0) out.push({ change_id: c.change_id, lineHashes: pending, effectiveWeights: c.effectiveWeights });
  }
  return out;
}

/** Tras un commit: quita de los cambios casados los hashes que ya llegaron a Git. */
export function recordCommitted(s: SessionState, changeIds: readonly string[], matchedHashes: readonly string[]): void {
  const ids = new Set(changeIds);
  const matched = new Set(matchedHashes);
  for (const c of s.changes) {
    if (!ids.has(c.change_id)) continue;
    c.pending_hashes = (c.pending_hashes ?? c.lineHashes).filter((h) => !matched.has(h));
  }
}

export function touchedPaths(s: SessionState): string[] {
  return [...new Set(s.changes.flatMap((c) => c.paths))];
}

export function markProcessed(s: SessionState, sha: string): void {
  if (s.processed_shas.includes(sha)) return;
  s.processed_shas.push(sha);
  if (s.processed_shas.length > MAX_PROCESSED) s.processed_shas.splice(0, s.processed_shas.length - MAX_PROCESSED);
}

/** Registra el modelo enrutado (y el origen del usage) de una petición. */
export function recordModel(st: SessionStats, model: string | undefined, usageSource?: SessionStats['last_usage_source']): void {
  if (usageSource) st.last_usage_source = usageSource;
  if (!model) return;
  st.last_model = model;
  const models = (st.models ??= {});
  models[model] = (models[model] ?? 0) + 1;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
