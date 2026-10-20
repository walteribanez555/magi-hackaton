import { z } from 'zod';
import { GitProvider, TaskProvider } from './integrations.js';

/**
 * Salud de integraciones y "readiness" del proyecto.
 *
 * Un proyecto está LISTO solo si tiene, ambos obligatorios:
 *   1. webhook del REPOSITORIO (GitHub/Bitbucket/GitLab) activo y verificado;
 *   2. webhook del GESTOR DE TAREAS (Jira/Linear) activo y verificado.
 * Las credenciales del proveedor son opcionales pero habilitan: registro automático del webhook,
 * verificación contra la API del proveedor, prueba de ida y vuelta y respuesta a tareas.
 *
 * Mientras el proyecto no esté listo, el resumen marca las etapas que dependen de webhooks
 * (Git verificado, PR, despliegue, tareas) como `estimated` y el dashboard muestra el aviso.
 */

/** Credenciales del proveedor GIT (para verificar/registrar el webhook y lanzar pings). */
export const GitProviderCredentials = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('github'),
    /** fine-grained PAT con "Webhooks: read & write" y "Metadata: read" sobre el repo */
    token: z.string().min(20),
    api_url: z.url().optional(), // GitHub Enterprise; default https://api.github.com
  }),
  z.object({
    provider: z.literal('bitbucket'),
    username: z.string().min(1),
    app_password: z.string().min(10), // permisos: webhooks, repository:read
  }),
  z.object({ provider: z.literal('gitlab'), token: z.string().min(20), api_url: z.url().optional() }),
]);
export type GitProviderCredentials = z.infer<typeof GitProviderCredentials>;

export const HealthStatus = z.enum([
  'not_configured', // no existe la integración
  'awaiting_first_delivery', // creada, nunca llegó un evento válido
  'healthy', // entregas válidas recientes y verificación OK
  'degraded', // funciona pero hay advertencias (eventos faltantes, verificación vieja, commits sin push…)
  'failing', // firmas inválidas, proveedor responde error, prueba fallida
  'disabled',
]);
export type HealthStatus = z.infer<typeof HealthStatus>;

export const CheckId = z.enum([
  'integration_exists',
  'webhook_registered', // el proveedor tiene un webhook a NUESTRA URL (requiere credenciales)
  'webhook_events', // suscrito a los eventos requeridos
  'signature_valid', // últimas entregas con firma válida
  'recent_delivery', // recibimos algo en la ventana esperada
  'provider_last_response', // el proveedor reporta 2xx en su última entrega (GitHub deliveries API)
  'roundtrip_test', // prueba de ida y vuelta reciente exitosa
  'credentials_valid', // credenciales del proveedor válidas
  'commits_reconciled', // commits del IDE vistos también por webhook push (solo repositorio)
  'tasks_reconciled', // claves de tarea usadas en ramas existen en el gestor (solo tareas)
]);
export type CheckId = z.infer<typeof CheckId>;

export const CheckResult = z.object({
  id: CheckId,
  status: z.enum(['pass', 'warn', 'fail', 'skipped']),
  /** texto para la persona: qué pasa y qué hacer */
  message: z.string(),
  /** acción sugerida que el dashboard puede ofrecer como botón */
  action: z
    .enum(['create_integration', 'register_webhook', 'add_credentials', 'run_test', 'rotate_secret', 'open_provider_settings'])
    .nullable(),
  checked_at: z.string(),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});
export type CheckResult = z.infer<typeof CheckResult>;

/** Eventos que DEBEN llegar por proveedor para que el embudo sea verificable. */
export const REQUIRED_WEBHOOK_EVENTS: Record<z.infer<typeof GitProvider> | z.infer<typeof TaskProvider>, string[]> = {
  github: ['push', 'create', 'delete', 'pull_request', 'deployment_status'],
  bitbucket: ['repo:push', 'pullrequest:created', 'pullrequest:updated', 'pullrequest:fulfilled', 'pullrequest:rejected'],
  gitlab: ['push_events', 'tag_push_events', 'merge_requests_events', 'deployment_events'],
  jira: ['jira:issue_created', 'jira:issue_updated', 'jira:issue_deleted'],
  linear: ['Issue'],
};

export const IntegrationHealth = z.object({
  integration_id: z.string().nullable(),
  role: z.enum(['repository', 'tasks']),
  provider: z.string().nullable(),
  status: HealthStatus,
  checks: z.array(CheckResult),
  /** contadores de las últimas 24 h (sin payloads) */
  deliveries_24h: z.object({
    accepted: z.number().int(),
    duplicate: z.number().int(),
    ignored: z.number().int(),
    rejected_signature: z.number().int(),
    rejected_other: z.number().int(),
  }),
  /** último momento en que llegó cada tipo de evento */
  last_event_at: z.record(z.string(), z.string()),
  last_delivery_at: z.string().nullable(),
  last_error: z.string().nullable(),
  last_test: z
    .object({ test_id: z.string(), status: z.enum(['pending', 'passed', 'failed', 'timeout']), finished_at: z.string().nullable() })
    .nullable(),
  can_auto_register: z.boolean(), // hay credenciales con permiso para crear el webhook
});
export type IntegrationHealth = z.infer<typeof IntegrationHealth>;

/** Una API key de MagiHub usada contra este repositorio (nunca la key: solo id + huella). */
export const RepositoryApiKey = z.object({
  key_id: z.string(),
  key_fingerprint: z.string(),
  key_name: z.string().nullable(),
  last_used_at: z.string().nullable(),
  sessions_7d: z.number().int(),
  /** dedicada = solo se usó en este repo (mejor atribución); compartida = también en otros */
  usage: z.enum(['dedicated', 'shared']),
});
export type RepositoryApiKey = z.infer<typeof RepositoryApiKey>;

/**
 * El CONJUNTO DE CLAVES de un repositorio — lo que el dashboard muestra al elegirlo en la lista
 * desplegable: API keys de MagiHub, webhook del repositorio (+ secreto/credenciales) y webhook
 * del gestor de tareas que cubre a ese repo (+ credenciales). Ambos webhooks son obligatorios.
 */
export const RepositoryReadiness = z.object({
  repository: z.string(), // "org/repo"
  project_id: z.string(),
  ready: z.boolean(),
  api_keys: z.array(RepositoryApiKey),
  repository_webhook: IntegrationHealth, // role 'repository'
  tasks_webhook: IntegrationHealth, // role 'tasks' (la integración de tareas del proyecto que cubre este repo)
  ide: z.object({ last_event_at: z.string().nullable(), sessions_7d: z.number().int() }),
  blocking_reasons: z.array(z.string()),
  evaluated_at: z.string(),
});
export type RepositoryReadiness = z.infer<typeof RepositoryReadiness>;

/** GET /projects/:projectId/readiness — el proyecto está listo si TODOS sus repos lo están. */
export const ProjectReadiness = z.object({
  project_id: z.string(),
  ready: z.boolean(),
  repositories: z.array(RepositoryReadiness),
  blocking_reasons: z.array(z.string()),
  evaluated_at: z.string(),
});
export type ProjectReadiness = z.infer<typeof ProjectReadiness>;

/** GET /repositories — para la lista desplegable (agrupa por proyecto). */
export const RepositoryOption = z.object({
  repository: z.string(),
  project_id: z.string(),
  ready: z.boolean(),
  status: HealthStatus, // el peor de sus dos webhooks
});
export type RepositoryOption = z.infer<typeof RepositoryOption>;

/**
 * POST /integrations/:id/test — prueba de ida y vuelta:
 * - github:   POST /repos/{o}/{r}/hooks/{hook_id}/pings → esperamos el evento `ping` firmado.
 * - gitlab:   POST /projects/:id/hooks/:hook_id/test/push_events.
 * - bitbucket: sin ping; se verifica vía API (webhook existe y activo) + último evento recibido.
 * - jira:     agrega y quita la etiqueta `magicode-healthcheck` en `test_issue_key` → esperamos
 *             `jira:issue_updated` (el anti-bucle lo reconoce como prueba, no lo ignora).
 * - sin credenciales: modo manual — se devuelve un `test_id` y las instrucciones para disparar un
 *   evento (Redeliver en GitHub, editar un issue en Jira); la prueba pasa cuando llega.
 * Resultado por polling GET /integrations/:id/tests/:testId (timeout 60 s automático, 15 min manual).
 */
export const IntegrationTestRequest = z.object({
  mode: z.enum(['auto', 'manual']).default('auto'),
  test_issue_key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/).optional(), // solo jira
});
export type IntegrationTestRequest = z.infer<typeof IntegrationTestRequest>;

export const IntegrationTestRun = z.object({
  test_id: z.string(),
  integration_id: z.string(),
  mode: z.enum(['auto', 'manual']),
  status: z.enum(['pending', 'passed', 'failed', 'timeout']),
  steps: z.array(
    z.object({
      name: z.string(), // "Ping enviado al proveedor", "Evento recibido", "Firma válida", "Procesado"
      status: z.enum(['pending', 'pass', 'fail', 'skipped']),
      at: z.string().nullable(),
      message: z.string().nullable(),
    }),
  ),
  instructions: z.string().nullable(), // modo manual
  started_at: z.string(),
  finished_at: z.string().nullable(),
  latency_ms: z.number().int().nullable(), // del disparo a la recepción
});
export type IntegrationTestRun = z.infer<typeof IntegrationTestRun>;

/** POST /integrations/:id/register-webhook — crea/actualiza el webhook en el proveedor con nuestra URL, secreto y eventos. */
export const RegisterWebhookResult = z.object({
  provider_hook_id: z.string(),
  created: z.boolean(), // false = ya existía y se actualizó
  events: z.array(z.string()),
});
export type RegisterWebhookResult = z.infer<typeof RegisterWebhookResult>;
