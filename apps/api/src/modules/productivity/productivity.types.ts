import type {
  ChangeDimensions,
  ChangeListItem,
  ChangeScores,
  CommitAutomation,
  DataSource,
  FileChange,
  Provenance,
  ProductivitySummary,
  TokenUsage,
  UsageGranularity,
  UsageRecord,
} from '@magicode/contracts';

/** Estados del cambio: proposed → accepted | rejected → committed → in_reference. */
export type ChangeStatus = ChangeListItem['status'];
export type EventSource = 'ide-extension' | 'demo-seed';

/** Atributos comunes a toda entidad (keys.ts). */
/** `SummaryScope` en contracts solo exporta el schema; el tipo se toma de ProductivitySummary. */
export type SummaryScope = ProductivitySummary['scope'];

export interface BaseItem {
  PK: string;
  SK: string;
  entity: string;
  tenant_id: string;
  key_id: string;
  created_at: string;
  updated_at: string;
  provenance: Provenance;
}

export interface SessionItem extends BaseItem {
  session_id: string;
  project_id: string;
  repository: string;
  branch?: string;
  task_key?: string;
  started_at: string;
  ended_at?: string;
  end_reason?: string;
  last_activity_at: string;
  editor?: string;
  extension_version?: string;
  head_sha?: string;
  source: EventSource;
  event_count?: number;
  GSI1PK?: string;
  GSI1SK?: string;
}

export interface AiRequestItem extends BaseItem {
  ai_request_id: string;
  session_id: string;
  project_id: string;
  repository: string;
  branch?: string;
  task_key?: string;
  model?: string;
  status: 'ok' | 'error' | 'cancelled';
  latency_ms: number;
  usage?: TokenUsage;
  usage_source?: 'magihub-response' | 'magihub-mock';
  output_hash?: string;
  regenerates?: string;
  occurred_at: string;
  source: EventSource;
}

export interface ChangeItem extends BaseItem {
  change_id: string;
  session_id: string;
  project_id: string;
  repository: string;
  branch?: string;
  task_key?: string;
  ai_request_id?: string;
  status: ChangeStatus;
  first_seen_at: string;
  proposed_at?: string;
  proposed_files?: FileChange[];
  proposed_added_lines?: number;
  proposed_patch_hash?: string;
  accepted_at?: string;
  accepted_files?: FileChange[];
  accepted_added_lines?: number;
  accepted_deleted_lines?: number;
  patch_hash?: string;
  dimensions?: ChangeDimensions;
  rejected_at?: string;
  reject_reason?: string;
  committed_at?: string;
  commit_sha?: string;
  in_reference_at?: string;
  reference_tags?: string[];
  deployed_at?: string;
  /** lo escribe el módulo scoring (ChangeScores) */
  scores?: ChangeScores;
  source?: EventSource;
}

export interface CommitItem extends BaseItem {
  sha: string;
  repository: string;
  session_id: string;
  project_id: string;
  branch?: string;
  task_keys?: string[];
  parent_sha?: string;
  committed_at: string;
  files: FileChange[];
  change_ids: string[];
  automation: CommitAutomation;
  has_session_trailer: boolean;
  remote_url?: string;
  commit_source: 'git-local' | 'git-remote';
  reference_tags?: string[];
  occurred_at: string;
  source?: EventSource;
}

export interface ReferenceMark {
  tag: string;
  sha: string;
  kind: 'demo-reference' | 'deployment';
  evidence_url?: string;
  included_shas: string[];
  surviving_lines: number;
  surviving_effective_lines: number;
  session_id: string;
  project_id: string;
  repository: string;
  occurred_at: string;
  provenance: Provenance;
  source?: EventSource;
}

export interface ReferenceItem extends BaseItem, ReferenceMark {}

/** Evidencia de despliegue (Deployment items que escribe el módulo de webhooks). */
export interface DeploymentEvidence {
  deployment_id?: string;
  repository: string;
  sha: string;
  state: string;
  environment?: string;
  url?: string;
  updated_at?: string;
}

/** Consumo MagiHub ya leído de los snapshots para la ventana. */
export interface UsageInput {
  records: UsageRecord[];
  granularity: UsageGranularity;
  provenance: Provenance;
  source: DataSource;
}

/** Entrada pura del cálculo de métricas (productivity.metrics.ts). Arrays ya filtrados por ventana/scope. */
export interface MetricsInput {
  scope: SummaryScope;
  /** true si hay filtro de project/repository/session/task/branch (no es "toda la key") */
  scoped: boolean;
  /** MAGIHUB_MODE=mock ⇒ toda cifra de tokens es simulated */
  magihubMode: 'real' | 'mock';
  usage: UsageInput | null;
  sessions: SessionItem[];
  requests: AiRequestItem[];
  /** todas las peticiones de la key en la ventana (prorrateo cuando la granularidad es hora/día) */
  keyRequests?: AiRequestItem[];
  changes: ChangeItem[];
  commits: CommitItem[];
  references: ReferenceMark[];
  deployments: DeploymentEvidence[];
  external?: { pull_requests: number; pull_requests_merged: number; tasks: number; tasks_done: number };
  now: string;
}

/** Filtros de los GET de productividad. */
export interface ProductivityQuery {
  project_id?: string;
  repository?: string;
  session_id?: string;
  task_key?: string;
  branch?: string;
  from: string;
  to: string;
}
