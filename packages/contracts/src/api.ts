/**
 * Rutas de la API de productividad (apps/api, Hono sobre Lambda + HTTP API Gateway v2).
 * Auth: `Authorization: Bearer <MagiHub API key>`. El backend valida la key contra MagiHub
 * (GET /v1/keys/self), deriva tenant_id/key_id y guarda solo la huella — nunca la key.
 */
export const API_PREFIX = '/api/v1';

export const ROUTES = {
  health: '/health', // GET  — sin auth
  events: '/productivity/events', // POST — EventsRequest → EventsResponse (202)
  summary: '/productivity/summary', // GET  ?project_id&repository&session_id&from&to → ProductivitySummary
  timeline: '/productivity/timeline', // GET  ?project_id&from&to&bucket=hour|day → TimelinePoint[]
  projects: '/productivity/projects', // GET  → { project_id, repositories[], last_activity_at }[]
  sessions: '/productivity/sessions', // GET  ?project_id&from&to → SessionListItem[]
  session: '/productivity/sessions/:sessionId', // GET → SessionListItem & { changes: ChangeListItem[] }
  changes: '/productivity/changes', // GET  ?session_id | ?project_id → ChangeListItem[]
  commits: '/productivity/commits', // GET  ?repository → commits con automation
  usage: '/usage', // GET  ?from&to&granularity → UsageResponse (cacheado en Dynamo)
  usageSync: '/usage/sync', // POST ?from&to → fuerza lectura a MagiHub y guarda snapshot
  whoami: '/whoami', // GET  → KeyIdentity (sin la key)

  // Multitenant enlazado: proyecto → tarea → rama (todas aceptan ?project_id)
  tasks: '/tasks', // GET ?project_id&status_category → TaskListItem[]
  task: '/tasks/:taskKey', // GET → TaskDetail (TaskListItem + linked{sessions, commits, branches, pull_requests, deployments} + criticality)
  branches: '/branches', // GET ?project_id&repository → BranchListItem[]
  pullRequests: '/pull-requests', // GET ?project_id&repository&state → { data: PullRequestListItem[], meta: PullRequestTotals (histórico) }

  // Integraciones y webhooks (repo origen + gestor de tareas)
  integrations: '/integrations', // GET (sin secretos) · POST IntegrationCreate → IntegrationCreated (secreto 1 vez)
  integration: '/integrations/:integrationId', // DELETE · POST /rotate-secret
  webhook: '/webhooks/:provider/:integrationId', // POST — SIN Bearer; firma HMAC del proveedor

  // Respuesta de vuelta al gestor de tareas (writeback.ts)
  taskActions: '/tasks/:taskKey/actions', // GET auditoría OutboxAction[] · POST TaskActionRequest → 202 OutboxAction
  taskTransitions: '/tasks/:taskKey/transitions', // GET → AvailableTransition[] (consulta en vivo a Jira)
  integrationCredentials: '/integrations/:integrationId/credentials', // PUT TaskProviderCredentials → 204 (Secrets Manager)
  integrationRules: '/integrations/:integrationId/rules', // GET AutomationRule[] · POST AutomationRuleUpsert
  integrationRule: '/integrations/:integrationId/rules/:ruleId', // PUT · DELETE

  // Salud de integraciones (health.ts) — repositorio y tareas son OBLIGATORIOS por proyecto
  projectReadiness: '/projects/:projectId/readiness', // GET → ProjectReadiness (todos sus repos)
  repositories: '/repositories', // GET ?project_id → RepositoryOption[] (lista desplegable)
  repositoryReadiness: '/repositories/:repository/readiness', // GET → RepositoryReadiness (repository URL-encoded "org%2Frepo")
  integrationHealth: '/integrations/:integrationId/health', // GET → IntegrationHealth (?refresh=true consulta al proveedor)
  integrationTest: '/integrations/:integrationId/test', // POST IntegrationTestRequest → 202 IntegrationTestRun
  integrationTestRun: '/integrations/:integrationId/tests/:testId', // GET → IntegrationTestRun
  integrationRegisterWebhook: '/integrations/:integrationId/register-webhook', // POST → RegisterWebhookResult
} as const;

/** Headers de firma por proveedor (verificación HMAC-SHA256 con el secreto de la integración). */
export const WEBHOOK_SIGNATURE_HEADERS = {
  github: { signature: 'x-hub-signature-256', delivery: 'x-github-delivery', event: 'x-github-event' },
  bitbucket: { signature: 'x-hub-signature', delivery: 'x-request-uuid', event: 'x-event-key' },
  gitlab: { signature: 'x-gitlab-token', delivery: 'x-gitlab-event-uuid', event: 'x-gitlab-event' },
  jira: { signature: 'x-hub-signature', delivery: 'x-atlassian-webhook-identifier', event: 'x-atlassian-webhook-flow' },
  linear: { signature: 'linear-signature', delivery: 'linear-delivery', event: 'linear-event' },
} as const;

/** Envoltorio estándar de respuesta (mismo estilo que coolfix-v2 api-response.interface). */
export interface ApiResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}
export interface ApiError {
  statusCode: number;
  message: string;
  details?: unknown;
}
