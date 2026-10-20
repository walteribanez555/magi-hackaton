import { z } from 'zod';
import { Provenance } from './provenance.js';

/**
 * Multitenant enlazado: todo cuelga de un tenant (derivado de la API key) y se enlaza así:
 *
 *   Tenant ─┬─ Project ─┬─ Repository (GitHub/Bitbucket, vía webhook)
 *           │           ├─ Task (Jira, vía webhook)  ←─ clave "MAG-123"
 *           │           └─ Session (IDE) ── Change ── Commit ── Reference/Deployment
 *           └─ Integration (una por proveedor + proyecto; secreto HMAC propio)
 *
 *   Branch  = rama del repo; se enlaza a Task(s) por la clave en su nombre
 *             (`feature/MAG-123-login`) y a Sessions por el `branch` del evento.
 *   Commit  = se enlaza a Task(s) por clave en el mensaje y por la rama.
 *   PR      = rama origen → base; tareas por título/rama.
 *   Deployment = evidencia REAL de despliegue (GitHub deployment_status) → etapa "deployed".
 *
 * Los webhooks no traen API key: el tenant sale de la Integration (`/webhooks/{provider}/{integration_id}`)
 * y la autenticidad de la firma HMAC del proveedor con el secreto de esa integración.
 */

/** Clave de tarea estilo Jira: PROYECTO-123. */
export const TASK_KEY_RE = /\b([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/g;
export const TaskKey = z.string().regex(/^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/);
export type TaskKey = z.infer<typeof TaskKey>;

/** Extrae claves de tarea únicas de ramas, mensajes de commit o títulos de PR. */
export function extractTaskKeys(...texts: Array<string | undefined | null>): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    // las ramas suelen ir en minúsculas: feature/mag-123-login
    for (const m of t.toUpperCase().matchAll(TASK_KEY_RE)) out.add(m[1]!);
  }
  return [...out];
}

export const GitProvider = z.enum(['github', 'bitbucket', 'gitlab']);
export type GitProvider = z.infer<typeof GitProvider>;
export const TaskProvider = z.enum(['jira', 'linear']);
export type TaskProvider = z.infer<typeof TaskProvider>;
export const IntegrationProvider = z.enum([...GitProvider.options, ...TaskProvider.options]);
export type IntegrationProvider = z.infer<typeof IntegrationProvider>;

export const Integration = z.object({
  integration_id: z.string(),
  tenant_id: z.string(),
  project_id: z.string(),
  provider: IntegrationProvider,
  /** git: "org/repo"; jira: claves de proyecto Jira ["MAG"] */
  repository: z.string().optional(),
  task_project_keys: z.array(z.string()).optional(),
  /** URL a configurar en el proveedor */
  webhook_url: z.string(),
  status: z.enum(['pending', 'active', 'disabled']),
  last_delivery_at: z.string().nullable(),
  created_at: z.string(),
});
export type Integration = z.infer<typeof Integration>;

/** POST /integrations — el secreto HMAC lo genera el backend y se muestra UNA vez. */
export const IntegrationCreate = z.discriminatedUnion('provider', [
  z.object({ provider: GitProvider, project_id: z.string().min(1), repository: z.string().min(3) }),
  z.object({
    provider: TaskProvider,
    project_id: z.string().min(1),
    task_project_keys: z.array(z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/)).min(1),
    base_url: z.url().optional(), // https://empresa.atlassian.net — para enlazar a la tarea
  }),
]);
export type IntegrationCreate = z.infer<typeof IntegrationCreate>;
export const IntegrationCreated = Integration.extend({ webhook_secret: z.string() });
export type IntegrationCreated = z.infer<typeof IntegrationCreated>;

/**
 * Evento de webhook NORMALIZADO (lo que el backend guarda tras validar firma y traducir el
 * payload del proveedor). Nunca se guarda el payload crudo completo: solo estos campos.
 */
const WhBase = {
  delivery_id: z.string(), // X-GitHub-Delivery / X-Request-UUID / X-Atlassian-Webhook-Identifier
  integration_id: z.string(),
  provider: IntegrationProvider,
  received_at: z.string(),
};

export const RepoCommitRef = z.object({
  sha: z.string(),
  message_task_keys: z.array(z.string()),
  author_login: z.string().optional(),
  timestamp: z.string(),
  files_added: z.number().int(),
  files_modified: z.number().int(),
  files_removed: z.number().int(),
  has_session_trailer: z.boolean(), // `MagiCode-Session:` en el mensaje
  session_id: z.string().optional(), // valor del trailer
});
export type RepoCommitRef = z.infer<typeof RepoCommitRef>;

export const NormalizedWebhookEvent = z.discriminatedUnion('kind', [
  z.object({
    ...WhBase,
    kind: z.literal('repo.push'),
    repository: z.string(),
    branch: z.string(),
    before: z.string(),
    after: z.string(),
    forced: z.boolean(),
    commits: z.array(RepoCommitRef),
  }),
  z.object({
    ...WhBase,
    kind: z.literal('repo.tag'),
    repository: z.string(),
    tag: z.string(),
    sha: z.string(),
    action: z.enum(['created', 'deleted']),
  }),
  z.object({
    ...WhBase,
    kind: z.literal('repo.branch'),
    repository: z.string(),
    branch: z.string(),
    action: z.enum(['created', 'deleted']),
  }),
  z.object({
    ...WhBase,
    kind: z.literal('repo.pull_request'),
    repository: z.string(),
    number: z.number().int(),
    title_task_keys: z.array(z.string()),
    source_branch: z.string(),
    target_branch: z.string(),
    state: z.enum(['open', 'closed', 'merged']),
    merge_sha: z.string().nullable(),
    head_sha: z.string(),
    url: z.string(),
  }),
  z.object({
    ...WhBase,
    kind: z.literal('repo.deployment'),
    repository: z.string(),
    deployment_id: z.string(),
    sha: z.string(),
    ref: z.string(),
    environment: z.string(),
    state: z.enum(['pending', 'in_progress', 'success', 'failure', 'error', 'inactive']),
    url: z.string().optional(), // evidencia (log/target URL)
  }),
  z.object({
    ...WhBase,
    kind: z.literal('task.upserted'),
    task_key: z.string(),
    title: z.string(), // resumen de la tarea (texto de negocio, no código)
    type: z.string().optional(), // Story/Bug/Task
    status: z.string(),
    status_category: z.enum(['todo', 'in_progress', 'done']),
    assignee: z.string().optional(),
    story_points: z.number().optional(),
    url: z.string().optional(),
    updated_at: z.string(),
  }),
  z.object({ ...WhBase, kind: z.literal('task.deleted'), task_key: z.string() }),
]);
export type NormalizedWebhookEvent = z.infer<typeof NormalizedWebhookEvent>;

/** Vistas que consume el dashboard. */
export const TaskListItem = z.object({
  task_key: z.string(),
  project_id: z.string(),
  title: z.string(),
  status: z.string(),
  status_category: z.enum(['todo', 'in_progress', 'done']),
  assignee: z.string().nullable(),
  story_points: z.number().nullable(),
  url: z.string().nullable(),
  branches: z.array(z.string()),
  sessions: z.number(),
  commits: z.number(),
  pull_requests: z.array(z.object({ number: z.number(), state: z.string(), url: z.string() })),
  tokens: z.object({ value: z.number().nullable(), provenance: Provenance }),
  accepted_lines: z.number(),
  effective_lines: z.number(),
  deployed: z.boolean(), // algún commit de la tarea tiene deployment success
  updated_at: z.string(),
});
export type TaskListItem = z.infer<typeof TaskListItem>;

export const BranchListItem = z.object({
  repository: z.string(),
  branch: z.string(),
  task_keys: z.array(z.string()),
  sessions: z.number(),
  commits: z.number(),
  head_sha: z.string().nullable(),
  merged_into: z.string().nullable(),
  last_activity_at: z.string(),
});
export type BranchListItem = z.infer<typeof BranchListItem>;
