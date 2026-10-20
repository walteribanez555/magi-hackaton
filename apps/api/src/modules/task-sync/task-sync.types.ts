import type {
  AutomationRule,
  AvailableTransition,
  OutboxAction,
  RuleTrigger,
  TaskAction,
  TaskProviderCredentials,
} from '@magicode/contracts';

/** Fila OutboxAction (PK T#{t}#TASK#{key} · SK ACT#{created_at}#{action_id} · GSI1 T#{t}#OUTBOX#{status}). */
export interface OutboxItem extends OutboxAction {
  PK: string;
  SK: string;
  GSI1PK: string;
  GSI1SK: string;
  entity: 'OutboxAction';
  key_id: string;
  project_id?: string;
  provenance: 'real';
  /** momento en que un worker la tomó (status=sending) — para recuperar "sending" huérfanos */
  claimed_at?: string;
}

export interface AutomationRuleItem extends AutomationRule {
  PK: string;
  SK: string;
  entity: 'AutomationRule';
  tenant_id: string;
  key_id: string;
  provenance: 'real';
}

/** Variables de plantilla {{…}} de las reglas. */
export interface RuleVars {
  task_key?: string;
  sha?: string;
  pr_url?: string;
  environment?: string;
  tokens?: number | string;
  effective_lines?: number | string;
  criticality?: string;
  dashboard_url?: string;
  /** extensión MagiCode (propuesta para contracts): URL del commit en el proveedor git */
  commit_url?: string;
  repository?: string;
  [k: string]: string | number | undefined;
}

export interface RuleContext {
  task_key: string;
  /**
   * Referencia ÚNICA del disparo, ya incluye la tarea: `${task_key}|<tipo>:<repo>:<id>`.
   * idempotency_key = `${rule_id}:${trigger_ref}` ⇒ el mismo hecho nunca encola dos veces la misma regla.
   */
  trigger_ref: string;
  status_category?: 'todo' | 'in_progress' | 'done';
  environment?: string;
  target_branch?: string;
  vars: RuleVars;
}

export interface PlannedAction {
  rule_id: string;
  integration_id: string;
  idempotency_key: string;
  trigger_ref: string;
  action: TaskAction;
  /** se encola directamente como `skipped` con este last_error (p. ej. "commit_url desconocido") */
  skip_reason?: string;
}

export interface SkippedRule {
  rule_id: string;
  reason: string;
}

/** Disparo que llega del webhook o del módulo productivity (lo cablea el lead). */
export interface TriggerInput {
  tenant_id: string;
  project_id?: string;
  task_keys: string[];
  /** referencia del hecho SIN la tarea: `pr:org/repo:12`, `deploy:org/repo:987`, `ref:org/repo:v1.0`, `commit:org/repo:<sha>` */
  ref: string;
  environment?: string;
  target_branch?: string;
  vars?: RuleVars;
}

export type FireTrigger = (trigger: RuleTrigger, input: TriggerInput) => Promise<void>;

/** Resultado de ejecutar una acción en el proveedor (resumen, nunca secretos). */
export interface ExecuteResult {
  status: 'sent' | 'skipped';
  result: Record<string, unknown>;
  /** transition: estado resultante para refrescar la fila Task local (el webhook propio se ignora) */
  task_status?: { status: string; status_category: 'todo' | 'in_progress' | 'done' };
}

export interface TaskProviderClient {
  /** identidad de la cuenta de servicio (anti-bucle) */
  whoami(): Promise<{ account_id: string; display_name?: string }>;
  transitions(taskKey: string): Promise<AvailableTransition[]>;
  execute(taskKey: string, action: TaskAction, actionId: string): Promise<ExecuteResult>;
}

export type { TaskProviderCredentials };
