import type { Criticality, Provenance, TaskListItem } from '@magicode/contracts';

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

/** Vistas de GET /tasks/:taskKey: schemas en contracts (integrations.ts). */
export type { TaskCommitView, TaskDeploymentView, TaskDetail, TaskSessionView } from '@magicode/contracts';
