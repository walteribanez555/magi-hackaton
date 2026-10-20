import type { BranchListItem } from '@magicode/contracts';

export interface BranchQuery {
  project_id?: string;
  repository?: string;
  /** email de git: ramas con sesiones de ese developer */
  developer?: string;
  /** login del autor del PR: ramas origen de sus PRs */
  pr_author?: string;
  /** incluir ramas borradas en el remoto (default false) */
  include_deleted?: boolean;
}

export type { BranchListItem };

/** Fila Branch tal como la escriben productivity (IDE) y webhooks (remoto). Sets ⇒ Set<string> o string[]. */
export interface BranchItem {
  repository: string;
  branch: string;
  project_id?: string;
  task_keys?: Set<string> | string[];
  session_ids?: Set<string> | string[];
  commit_shas?: Set<string> | string[];
  head_sha?: string;
  merged_into?: string;
  last_activity_at?: string;
  updated_at?: string;
  deleted?: boolean;
  [k: string]: unknown;
}
