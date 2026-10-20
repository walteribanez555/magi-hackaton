import { ENTITY } from '@magicode/contracts';

/** Fila destino en PostgreSQL. `pk` = columnas de ON CONFLICT. */
export interface PgRow {
  table: string;
  pk: string[];
  values: Record<string, unknown>;
}

type Item = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const arr = (v: unknown): string[] => (v instanceof Set ? [...v] : Array.isArray(v) ? v.map(String) : []);
const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const s = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));

/**
 * Item de DynamoDB (ya unmarshalled) → fila de la réplica analítica. Devuelve null para entidades
 * que no se replican (EventDedupe, RawEvent, marcador de sync, entidades de otros módulos).
 */
export function mapItem(it: Item): PgRow | null {
  const common = {
    tenant_id: it.tenant_id,
    provenance: it.provenance ?? 'real',
    created_at: it.created_at ?? it.updated_at,
    updated_at: it.updated_at ?? it.created_at,
  };
  switch (it.entity) {
    case ENTITY.project:
      return {
        table: 'projects',
        pk: ['tenant_id', 'project_id'],
        values: { ...common, project_id: it.project_id, key_id: s(it.key_id), repositories: arr(it.repositories), last_activity_at: s(it.last_activity_at) },
      };
    case ENTITY.session:
      return {
        table: 'sessions',
        pk: ['tenant_id', 'session_id'],
        values: {
          ...common,
          session_id: it.session_id,
          key_id: it.key_id,
          project_id: it.project_id,
          repository: it.repository,
          branch: s(it.branch),
          task_key: s(it.task_key),
          started_at: it.started_at,
          ended_at: s(it.ended_at),
          end_reason: s(it.end_reason),
          last_activity_at: s(it.last_activity_at),
          editor: s(it.editor),
          extension_version: s(it.extension_version),
          head_sha: s(it.head_sha),
          source: it.source ?? 'ide-extension',
          event_count: n(it.event_count) ?? 0,
        },
      };
    case ENTITY.aiRequest:
      return {
        table: 'ai_requests',
        pk: ['tenant_id', 'session_id', 'ai_request_id'],
        values: {
          ...common,
          session_id: it.session_id,
          ai_request_id: it.ai_request_id,
          key_id: it.key_id,
          project_id: it.project_id,
          repository: it.repository,
          branch: s(it.branch),
          task_key: s(it.task_key),
          model: s(it.model),
          status: it.status,
          latency_ms: n(it.latency_ms) ?? 0,
          prompt_tokens: n(it.usage?.prompt_tokens),
          completion_tokens: n(it.usage?.completion_tokens),
          total_tokens: n(it.usage?.total_tokens),
          cached_tokens: n(it.usage?.cached_tokens),
          usage_source: s(it.usage_source),
          output_hash: s(it.output_hash),
          regenerates: s(it.regenerates),
          occurred_at: it.occurred_at,
          source: it.source ?? 'ide-extension',
        },
      };
    case ENTITY.change: {
      const d = it.dimensions;
      return {
        table: 'changes',
        pk: ['tenant_id', 'session_id', 'change_id'],
        values: {
          ...common,
          session_id: it.session_id,
          change_id: it.change_id,
          key_id: it.key_id,
          project_id: it.project_id,
          repository: it.repository,
          branch: s(it.branch),
          task_key: s(it.task_key),
          ai_request_id: s(it.ai_request_id),
          status: it.status,
          first_seen_at: it.first_seen_at ?? it.created_at,
          proposed_at: s(it.proposed_at),
          accepted_at: s(it.accepted_at),
          rejected_at: s(it.rejected_at),
          reject_reason: s(it.reject_reason),
          committed_at: s(it.committed_at),
          in_reference_at: s(it.in_reference_at),
          deployed_at: s(it.deployed_at),
          proposed_added_lines: n(it.proposed_added_lines),
          accepted_added_lines: n(it.accepted_added_lines),
          accepted_deleted_lines: n(it.accepted_deleted_lines),
          effective_lines: n(d?.effective_lines),
          importance_score: n(d?.importance?.score),
          redundancy_score: n(d?.redundancy?.score),
          mechanical_share: n(d?.automation?.mechanical_share),
          files: json(it.accepted_files ?? it.proposed_files ?? []),
          dimensions: json(d),
          scores: json(it.scores),
          commit_sha: s(it.commit_sha),
          reference_tags: arr(it.reference_tags),
          source: s(it.source),
        },
      };
    }
    case ENTITY.commit: {
      const a = it.automation ?? {};
      return {
        table: 'commits',
        pk: ['tenant_id', 'repository', 'sha'],
        values: {
          ...common,
          repository: it.repository,
          sha: it.sha,
          key_id: it.key_id,
          session_id: it.session_id,
          project_id: it.project_id,
          branch: s(it.branch),
          task_keys: arr(it.task_keys),
          parent_sha: s(it.parent_sha),
          committed_at: it.committed_at,
          files: json(it.files ?? []),
          change_ids: arr(it.change_ids),
          automation: json(a),
          commit_added_lines: n(a.commit_added_lines),
          ai_matched_lines: n(a.ai_matched_lines),
          ai_lost_lines: n(a.ai_lost_lines),
          ai_share: n(a.ai_share),
          effective_lines: n(a.effective_lines),
          has_session_trailer: !!it.has_session_trailer,
          remote_url: s(it.remote_url),
          commit_source: it.commit_source ?? 'git-local',
          reference_tags: arr(it.reference_tags),
          source: s(it.source),
        },
      };
    }
    case ENTITY.reference:
      return {
        table: 'refs',
        pk: ['tenant_id', 'repository', 'tag'],
        values: {
          ...common,
          repository: it.repository,
          tag: it.tag,
          key_id: it.key_id,
          sha: it.sha,
          kind: it.kind,
          evidence_url: s(it.evidence_url),
          included_shas: arr(it.included_shas),
          surviving_lines: n(it.surviving_lines) ?? 0,
          surviving_effective_lines: n(it.surviving_effective_lines) ?? 0,
          session_id: s(it.session_id),
          project_id: s(it.project_id),
          branch: s(it.branch),
          marked_at: it.occurred_at ?? it.created_at,
          source: s(it.source),
        },
      };
    case ENTITY.usage: {
      if (it.kind === 'sync-marker' || !['request', 'hour', 'day'].includes(it.granularity)) return null;
      const prefix = `U#${it.granularity}#`;
      return {
        table: 'usage_snapshots',
        pk: ['tenant_id', 'key_id', 'granularity', 'window_key'],
        values: {
          ...common,
          key_id: it.key_id,
          granularity: it.granularity,
          window_key: String(it.SK).startsWith(prefix) ? String(it.SK).slice(prefix.length) : String(it.SK),
          window_start: it.window_start,
          window_end: it.window_end,
          request_id: s(it.request_id),
          model: s(it.model),
          prompt_tokens: n(it.usage?.prompt_tokens) ?? 0,
          completion_tokens: n(it.usage?.completion_tokens) ?? 0,
          total_tokens: n(it.usage?.total_tokens) ?? 0,
          cached_tokens: n(it.usage?.cached_tokens),
          requests: n(it.requests) ?? 0,
          cost_usd: n(it.cost_usd),
          simulated: !!it.simulated,
          source: it.source ?? 'magihub-usage-api',
          synced_at: it.synced_at ?? it.updated_at,
        },
      };
    }
    default:
      return null; // RawEvent, EventDedupe, Task/Branch/PR/... (otros módulos)
  }
}

const ident = (v: string) => `"${v.replace(/"/g, '""')}"`;

/** UPSERT idempotente: solo pisa si la versión entrante no es más vieja (updated_at). */
export function upsertSql(row: PgRow): { text: string; values: unknown[] } {
  const cols = Object.keys(row.values);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const updates = cols.filter((c) => !row.pk.includes(c)).map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`);
  const text =
    `INSERT INTO ${ident(row.table)} (${cols.map(ident).join(', ')}) VALUES (${placeholders.join(', ')}) ` +
    `ON CONFLICT (${row.pk.map(ident).join(', ')}) DO UPDATE SET ${updates.join(', ')} ` +
    `WHERE ${ident(row.table)}."updated_at" <= EXCLUDED."updated_at"`;
  return { text, values: cols.map((c) => row.values[c]) };
}
