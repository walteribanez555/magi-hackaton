import type {
  CheckId,
  Criticality,
  FunnelStage,
  HealthStatus,
  OutboxStatus,
  Provenance,
  RuleTrigger,
  TaskAction,
} from '@magicode/contracts';

/** Textos de la UI para los enums del contrato (español, tono del diseño). */

export const STAGE_LABEL: Record<FunnelStage, string> = {
  generated: 'Generado',
  accepted: 'Aceptado',
  committed: 'Registrado en Git',
  in_reference: 'Versión de referencia',
  deployed: 'En producción',
};

export const STAGE_SHORT: Record<FunnelStage, string> = {
  generated: 'Generado',
  accepted: 'Aceptado',
  committed: 'Git',
  in_reference: 'Versión demo',
  deployed: 'Producción',
};

export const STAGE_EVIDENCE: Record<FunnelStage, string> = {
  generated: 'code.proposed',
  accepted: 'code.accepted en el IDE',
  committed: 'SHA verificado por webhook',
  in_reference: 'tag de referencia',
  deployed: 'deployment success',
};

export const PROVENANCE_LETTER: Record<Provenance, string> = { real: 'R', estimated: 'E', simulated: 'S' };
export const PROVENANCE_LABEL: Record<Provenance, string> = {
  real: 'real: medido en MagiHub, Git o el IDE',
  estimated: 'estimado: aproximación declarada',
  simulated: 'simulado: mock o seed de demo',
};

export const CRITICALITY_LABEL: Record<Criticality, string> = {
  low: 'Baja',
  medium: 'Media',
  high: 'Alta',
  critical: 'Crítica',
};

export const TASK_CATEGORY_LABEL: Record<'todo' | 'in_progress' | 'done', string> = {
  todo: 'Por hacer',
  in_progress: 'En curso',
  done: 'Hecha',
};

export const CHANGE_STATUS_LABEL: Record<string, string> = {
  proposed: 'propuesto',
  accepted: 'aceptado',
  rejected: 'rechazado',
  committed: 'en Git',
  in_reference: 'en versión demo',
};

export const PR_STATE_LABEL: Record<string, string> = { open: 'abierto', merged: 'fusionado', closed: 'cerrado' };

export const PROVIDER_LABEL: Record<string, string> = {
  github: 'GitHub',
  bitbucket: 'Bitbucket',
  gitlab: 'GitLab',
  jira: 'Jira Cloud',
  linear: 'Linear',
};

export const PROVIDER_EVENTS: Record<string, string> = {
  github: 'push, create, delete, pull_request, deployment_status',
  bitbucket: 'repo:push, pullrequest:created, updated, fulfilled, rejected',
  gitlab: 'push, tag_push, merge_requests, deployment',
  jira: 'jira:issue_created, issue_updated, issue_deleted',
  linear: 'Issue',
};

export const OUTBOX_STATUS_LABEL: Record<OutboxStatus, string> = {
  pending: 'pendiente',
  sending: 'enviando',
  sent: 'enviado',
  failed: 'fallido',
  skipped: 'omitido',
};

export const RULE_TRIGGER_LABEL: Record<RuleTrigger, string> = {
  'session.started': 'empieza la primera sesión de MagiCode en la rama',
  'commit.linked': 'se enlaza un commit con líneas IA',
  'pr.opened': 'se abre un pull request',
  'pr.merged': 'se fusiona un pull request',
  'reference.marked': 'la tarea entra en la versión de referencia',
  'deployment.success': 'hay un despliegue exitoso',
};

export const HEALTH_LABEL: Record<HealthStatus, string> = {
  healthy: 'Correcto',
  degraded: 'Con advertencias',
  failing: 'Con fallas',
  awaiting_first_delivery: 'Esperando primer evento',
  not_configured: 'Sin configurar',
  disabled: 'Desactivada',
};

export const CHECK_LABEL: Record<CheckId, string> = {
  integration_exists: 'La integración existe',
  webhook_registered: 'Webhook registrado en el proveedor',
  webhook_events: 'Suscrito a los eventos requeridos',
  signature_valid: 'Firmas válidas',
  recent_delivery: 'Entregas recientes',
  provider_last_response: 'Última respuesta del proveedor',
  roundtrip_test: 'Prueba de ida y vuelta',
  credentials_valid: 'Credenciales válidas',
  commits_reconciled: 'Commits del IDE vistos por webhook',
  tasks_reconciled: 'Claves de tarea existen en el gestor',
};

export const CHECK_STATUS_LABEL: Record<'pass' | 'warn' | 'fail' | 'skipped', string> = {
  pass: 'Pasa',
  warn: 'Advertencia',
  fail: 'Falla',
  skipped: 'Omitido',
};

export type CheckAction =
  | 'create_integration'
  | 'register_webhook'
  | 'add_credentials'
  | 'run_test'
  | 'rotate_secret'
  | 'open_provider_settings';

export const CHECK_ACTION_LABEL: Record<CheckAction, string> = {
  create_integration: 'Crear integración',
  register_webhook: 'Registrar webhook automáticamente',
  add_credentials: 'Agregar credenciales',
  run_test: 'Comprobar ahora',
  rotate_secret: 'Rotar secreto',
  open_provider_settings: 'Abrir configuración del proveedor',
};

/** Nombres legibles de las features del modelo (top_factors). */
export const FEATURE_LABEL: Record<string, string> = {
  accepted_added_lines: 'Líneas agregadas aceptadas',
  accepted_deleted_lines: 'Líneas borradas aceptadas',
  files_count: 'Número de archivos',
  importance_score: 'Importancia',
  redundancy_score: 'Redundancia',
  mechanical_share: 'Proporción mecánica',
  effective_lines: 'Líneas efectivas',
  edited_before_accept_ratio: 'Editado por la persona antes de aceptar',
  core_tier_share: 'Cambio en archivos core',
  test_tier_share: 'Cambio en archivos de test',
  logic_kind_share: 'Proporción de lógica',
  test_kind_share: 'Proporción de líneas de test',
  tokens_total: 'Tokens de la petición',
  tokens_per_effective_line: 'Tokens por línea efectiva',
  regenerations: 'Regeneraciones',
  latency_ms: 'Latencia de la petición',
  session_acceptance_rate: 'Tasa de aceptación de la sesión',
  has_task: 'Tiene tarea enlazada',
  task_is_bug: 'Tarea de tipo Bug',
  branch_is_default: 'Commit directo en la rama principal',
  hour_of_day: 'Hora del día',
};

export const LINE_KIND_LABEL: Record<string, string> = {
  logic: 'Lógica',
  test: 'Test',
  declaration: 'Declaración',
  trivial: 'Trivial',
  import: 'Import',
  comment: 'Comentario',
  config: 'Config',
};

/** Acción de Jira en palabras: "Transición → En revisión", "Comentario", … */
export function describeTaskAction(a: TaskAction): string {
  switch (a.kind) {
    case 'transition':
      return `Transición → ${a.to_status ?? `#${a.transition_id ?? '?'}`}${a.comment ? ' con comentario' : ''}`;
    case 'comment':
      return 'Comentario';
    case 'update_fields':
      return `Actualizar campos (${Object.keys(a.fields).join(', ')})`;
    case 'remote_link':
      return `Enlace ${a.relation === 'dashboard' ? 'al dashboard' : `a ${a.relation === 'pull_request' ? 'pull request' : a.relation === 'deployment' ? 'despliegue' : 'commit'}`}`;
    case 'assign':
      return a.assignee_account_id ? 'Asignar' : 'Quitar responsable';
  }
}
