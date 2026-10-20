import type { Provenance } from '@magicode/contracts';

export type PullRequestState = 'open' | 'closed' | 'merged';

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

/** Vista de GET /pull-requests (propuesta para contracts: PullRequestListItem). */
export interface PullRequestListItem {
  repository: string;
  number: number;
  state: PullRequestState;
  source_branch: string;
  target_branch: string;
  task_keys: string[];
  head_sha: string;
  merge_sha: string | null;
  url: string;
  opened_at: string | null;
  merged_at: string | null;
  closed_at: string | null;
  updated_at: string;
  ai: {
    /** commits del PR conocidos (rama origen + head + merge) */
    commits: number;
    commits_with_ai: number;
    ai_matched_lines: number;
    commit_added_lines: number;
    contains_ai_lines: boolean;
    /** cruce por rama/SHA, no por ancestros reales del merge ⇒ estimated */
    provenance: Provenance;
  };
}

export interface PullRequestTotals {
  total: number;
  open: number;
  merged: number;
  closed: number;
  with_ai_lines: number;
}
