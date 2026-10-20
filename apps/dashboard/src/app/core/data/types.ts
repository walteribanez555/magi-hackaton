/**
 * Tipos de vista del dashboard. Lo que existe en @magicode/contracts se importa de ahí
 * (solo `import type`); aquí van las formas que el contrato aún no fija (ver notas).
 */
import type {
  BranchListItem,
  ChangeListItem,
  Criticality,
  FunnelStage,
  ProductivitySummary,
  Provenance,
  SessionListItem,
  TaskListItem,
} from '@magicode/contracts';

/** GET /productivity/projects (el contrato lo documenta solo en el comentario de ROUTES). */
export interface ProjectItem {
  project_id: string;
  repositories: string[];
  last_activity_at: string | null;
}

/** GET /productivity/filters (contracts FilterOptions). */
export interface FilterOptionsView {
  repositories: string[];
  developers: { id: string; name: string | null; sessions: number }[];
  pr_authors: { login: string; pull_requests: number }[];
}

/** Campos de developer que el API agrega a la sesión (events.ts: developer = email de git). */
export type SessionWithDeveloper = SessionListItem & { developer?: string | null; developer_name?: string | null };

/** Commit enlazado a una tarea (contracts no define el tipo de /productivity/commits). */
export interface TaskCommit {
  sha: string;
  repository?: string;
  branch?: string | null;
  session_id?: string | null;
  message_task_keys?: string[];
  /** líneas del commit que vinieron de la IA / líneas totales del commit */
  ai_lines?: number | null;
  total_lines?: number | null;
  /** cómo se enlazó con la tarea: "hashes de línea + trailer", "MagiCode-Task: MAG-123"… */
  link_reason?: string | null;
  timestamp: string;
  in_reference?: boolean;
  deployed?: boolean;
}

/** PR enlazado (repo.pull_request normalizado). */
export interface PullRequestListItem {
  number: number;
  repository: string;
  title?: string | null;
  source_branch: string;
  target_branch: string;
  state: 'open' | 'closed' | 'merged';
  task_keys: string[];
  url: string;
  head_sha?: string | null;
  merge_sha?: string | null;
  commits_with_ai?: number | null;
  /** autor del PR en el proveedor (filtro ?pr_author) */
  author_login?: string | null;
  updated_at: string;
}

export interface DeploymentItem {
  deployment_id: string;
  sha: string;
  environment: string;
  state: string;
  url?: string | null;
  at: string;
}

/**
 * GET /tasks/:taskKey. El contrato dice "TaskListItem & { sessions, commits, branches,
 * pull_requests, summary }", pero esos nombres ya existen en TaskListItem con otro tipo
 * (number / string[]): se modela como reemplazo y se tolera la forma de lista.
 */
export interface TaskDetail
  extends Omit<TaskListItem, 'sessions' | 'commits' | 'branches' | 'pull_requests'> {
  type?: string | null;
  sessions: SessionListItem[] | number;
  commits: TaskCommit[] | number;
  branches: Array<BranchListItem | string>;
  pull_requests: Array<PullRequestListItem | TaskListItem['pull_requests'][number]>;
  deployments?: DeploymentItem[];
  changes?: ChangeListItem[];
  summary?: ProductivitySummary | null;
}

/** GET /productivity/sessions/:id */
export type SessionDetail = SessionListItem & { changes: ChangeListItem[] };

/** Fila de "Por tarea" con criticidad derivada de los cambios de la tarea. */
export interface TaskRow {
  task: TaskListItem | null;
  key: string;
  title: string;
  tokens: { value: number | null; provenance: Provenance };
  effective_lines: number;
  criticality: { level: Criticality; score: number } | null;
}

export const STAGE_ORDER: FunnelStage[] = ['generated', 'accepted', 'committed', 'in_reference', 'deployed'];

/** Índice de la guía (public/kb/index.json). */
export interface KbArticleMeta {
  id: string;
  title: string;
  summary?: string;
  section?: string;
  file: string;
  metric_keys: string[];
  order?: number;
}
