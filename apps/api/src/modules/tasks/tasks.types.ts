import type { BranchListItem, Criticality, Provenance, TaskListItem } from '@magicode/contracts';
import type { PullRequestListItem } from '../pull-requests/pull-requests.types';

export type StatusCategory = TaskListItem['status_category'];

export interface TaskQuery {
  project_id?: string;
  status_category?: StatusCategory;
}

/** Fila Task (webhooks Jira/Linear). */
export interface TaskItem {
  task_key: string;
  project_id: string;
  title: string;
  type?: string | null;
  status: string;
  status_category: StatusCategory;
  assignee?: string | null;
  story_points?: number | null;
  url?: string | null;
  provider?: string;
  integration_id?: string;
  source_updated_at?: string;
  updated_at?: string;
  deleted?: boolean;
  [k: string]: unknown;
}

export type LinkKind = 'branch' | 'session' | 'commit' | 'pr' | 'deployment';

/** Fila TaskLink (la escriben productivity —IDE— y webhooks —remoto—). */
export interface TaskLinkItem {
  SK: string;
  task_key: string;
  kind: LinkKind;
  link_id: string;
  project_id?: string;
  repository?: string;
  branch?: string;
  sha?: string;
  session_id?: string;
  number?: number;
  state?: string;
  url?: string;
  deployment_id?: string;
  environment?: string;
  deployed?: boolean;
  linked_at?: string;
  updated_at?: string;
  [k: string]: unknown;
}

/** Agregado de tokens/líneas de las sesiones enlazadas a la tarea. */
export interface TaskMetrics {
  tokens: { value: number | null; provenance: Provenance };
  accepted_lines: number;
  effective_lines: number;
  /** máxima criticidad de los cambios (scores XGBoost/heurística), si existe */
  criticality: Criticality | null;
}

export interface TaskSessionView {
  session_id: string;
  repository: string | null;
  branch: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface TaskCommitView {
  sha: string;
  repository: string;
  branch: string | null;
  committed_at: string | null;
  verified_remote: boolean;
  commit_source: string | null;
  session_id: string | null;
  ai_matched_lines: number | null;
  commit_added_lines: number | null;
  ai_share: number | null;
}

export interface TaskDeploymentView {
  deployment_id: string;
  repository: string | null;
  sha: string | null;
  environment: string | null;
  state: string | null;
  deployed: boolean;
  url: string | null;
}

/** GET /tasks/:taskKey (propuesta para contracts: TaskDetail = TaskListItem & { linked }). */
export interface TaskDetail extends TaskListItem {
  linked: {
    sessions: TaskSessionView[];
    commits: TaskCommitView[];
    branches: BranchListItem[];
    pull_requests: PullRequestListItem[];
    deployments: TaskDeploymentView[];
  };
  criticality: Criticality | null;
}
