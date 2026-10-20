import type { PullRequestState } from '@magicode/contracts';

export type { PullRequestState };

export interface PullRequestQuery {
  project_id?: string;
  repository?: string;
  state?: PullRequestState;
}

/** Fila PullRequest (la escribe webhooks.projection). */
export interface PullRequestItem {
  repository: string;
  number: number;
  project_id?: string;
  provider?: string;
  state: PullRequestState;
  source_branch: string;
  target_branch: string;
  head_sha: string;
  merge_sha: string | null;
  url: string;
  task_keys?: string[] | Set<string>;
  opened_at?: string;
  merged_at?: string;
  closed_at?: string;
  last_event_at?: string;
  updated_at?: string;
  [k: string]: unknown;
}

/** Fila Commit mínima que se cruza con el PR (automation la calcula la extensión en local). */
export interface CommitLite {
  sha: string;
  branch?: string;
  remote_branch?: string;
  verified_remote?: boolean;
  automation?: { ai_matched_lines?: number; commit_added_lines?: number };
}

/** Vista de GET /pull-requests y totales de `meta`: schemas en contracts (integrations.ts). */
export type { PullRequestListItem, PullRequestTotals } from '@magicode/contracts';
