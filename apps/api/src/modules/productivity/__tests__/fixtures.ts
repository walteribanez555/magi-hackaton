import type { ChangeDimensions, UsageRecord } from '@magicode/contracts';
import type { AiRequestItem, ChangeItem, CommitItem, MetricsInput, ReferenceMark, SessionItem } from '../productivity.types';

const base = { PK: 'pk', SK: 'sk', tenant_id: 't1', key_id: 'k1', created_at: '2026-10-20T10:00:00.000Z', updated_at: '2026-10-20T10:00:00.000Z' };

export const session = (id = 's1', o: Partial<SessionItem> = {}): SessionItem => ({
  ...base,
  entity: 'Session',
  provenance: 'real',
  session_id: id,
  project_id: 'p1',
  repository: 'org/repo',
  started_at: '2026-10-20T10:00:00.000Z',
  last_activity_at: '2026-10-20T11:00:00.000Z',
  source: 'ide-extension',
  ...o,
});

export const request = (id: string, tokens: number | undefined, o: Partial<AiRequestItem> = {}): AiRequestItem => ({
  ...base,
  entity: 'AiRequest',
  provenance: 'real',
  ai_request_id: id,
  session_id: 's1',
  project_id: 'p1',
  repository: 'org/repo',
  model: 'mock-sonnet',
  status: 'ok',
  latency_ms: 100,
  usage: tokens === undefined ? undefined : { prompt_tokens: Math.floor(tokens / 2), completion_tokens: tokens - Math.floor(tokens / 2), total_tokens: tokens },
  usage_source: 'magihub-response',
  occurred_at: '2026-10-20T10:05:00.000Z',
  source: 'ide-extension',
  ...o,
});

export const dims = (lines: number, o: { effective?: number; redundant?: number; mechanical?: number; trivial?: number; weighted?: number } = {}): ChangeDimensions => {
  const trivial = o.trivial ?? 0;
  const weighted = o.weighted ?? lines * 0.8;
  return {
    importance: {
      lines,
      weighted_lines: weighted,
      score: lines ? weighted / lines : 0,
      by_kind: { logic: lines - trivial, declaration: 0, test: 0, config: 0, comment: 0, import: 0, trivial },
    },
    redundancy: {
      intra_change: o.redundant ?? 0,
      existing_in_repo: 0,
      repeated_in_session: 0,
      redundant_lines: o.redundant ?? 0,
      score: lines - trivial ? (o.redundant ?? 0) / (lines - trivial) : 0,
    },
    automation: {
      mechanical_lines: o.mechanical ?? 0,
      mechanical_share: lines ? (o.mechanical ?? 0) / lines : 0,
      accepted_as_is: lines,
      edited_before_accept: 0,
    },
    effective_lines: o.effective ?? weighted,
  };
};

export const change = (id: string, reqId: string, o: Partial<ChangeItem> = {}): ChangeItem => ({
  ...base,
  entity: 'Change',
  provenance: 'real',
  change_id: id,
  session_id: 's1',
  project_id: 'p1',
  repository: 'org/repo',
  ai_request_id: reqId,
  status: 'proposed',
  first_seen_at: '2026-10-20T10:06:00.000Z',
  proposed_at: '2026-10-20T10:06:00.000Z',
  proposed_added_lines: 10,
  ...o,
});

export const accepted = (id: string, reqId: string, lines: number, o: Partial<ChangeItem> & { d?: Parameters<typeof dims>[1] } = {}): ChangeItem => {
  const { d, ...rest } = o;
  return change(id, reqId, {
    status: 'accepted',
    proposed_added_lines: lines,
    accepted_at: '2026-10-20T10:07:00.000Z',
    accepted_added_lines: lines,
    accepted_deleted_lines: 0,
    dimensions: dims(lines, d),
    ...rest,
  });
};

export const commit = (sha: string, changeIds: string[], matched: number, o: Partial<CommitItem> = {}): CommitItem => ({
  ...base,
  entity: 'Commit',
  provenance: 'real',
  sha,
  repository: 'org/repo',
  session_id: 's1',
  project_id: 'p1',
  committed_at: '2026-10-20T10:30:00.000Z',
  files: [],
  change_ids: changeIds,
  automation: { commit_added_lines: matched * 2, ai_matched_lines: matched, ai_share: 0.5, ai_lost_lines: 0, effective_lines: matched * 0.8 },
  has_session_trailer: true,
  commit_source: 'git-local',
  occurred_at: '2026-10-20T10:30:00.000Z',
  ...o,
});

export const ref = (tag: string, surviving: number, o: Partial<ReferenceMark> = {}): ReferenceMark => ({
  tag,
  sha: 'a'.repeat(40),
  kind: 'demo-reference',
  included_shas: [],
  surviving_lines: surviving,
  surviving_effective_lines: surviving * 0.8,
  session_id: 's1',
  project_id: 'p1',
  repository: 'org/repo',
  occurred_at: '2026-10-20T10:40:00.000Z',
  provenance: 'real',
  ...o,
});

export const usageRec = (requestId: string | undefined, tokens: number, o: Partial<UsageRecord> = {}): UsageRecord => ({
  request_id: requestId,
  window_start: '2026-10-20T10:05:00.000Z',
  window_end: '2026-10-20T10:05:00.000Z',
  usage: { prompt_tokens: 0, completion_tokens: tokens, total_tokens: tokens },
  requests: 1,
  ...o,
});

export const input = (o: Partial<MetricsInput> = {}): MetricsInput => ({
  scope: { tenant_id: 't1', key_id: 'k1', from: '2026-10-20T00:00:00.000Z', to: '2026-10-20T23:59:59.000Z' },
  scoped: false,
  magihubMode: 'real',
  usage: null,
  sessions: [session()],
  requests: [],
  changes: [],
  commits: [],
  references: [],
  deployments: [],
  now: '2026-10-20T12:00:00.000Z',
  ...o,
});
