import { z } from 'zod';
import { TaskProvider } from './integrations.js';

/**
 * Respuesta de vuelta al gestor de tareas (Jira primero; Linear opcional).
 *
 *   Dashboard (manual) ─┐
 *                       ├─► OutboxAction (DynamoDB, status=pending) ─► Stream ─► task-sync Lambda ─► API Jira
 *   Regla automática ───┘        ▲                                                     │
 *   (pr.merged, deploy…)         └──────────── resultado / reintentos / auditoría ◄────┘
 *
 * - Outbox: la acción se persiste ANTES de llamar al proveedor (no se pierde si Jira falla) y es
 *   idempotente por `idempotency_key`.
 * - Anti-bucle: los cambios que hace MagiCode vuelven como webhook; se ignoran si el actor es la
 *   cuenta de servicio de la integración o si `action_id` está en la propiedad de entidad
 *   `magicode.last_action` del issue.
 * - Credenciales del proveedor (Jira: site + email + API token, u OAuth 3LO) en Secrets Manager
 *   `magicode/<env>/integrations/<integration_id>`; nunca en DynamoDB ni en respuestas.
 */

export const TaskActionKind = z.enum(['transition', 'comment', 'update_fields', 'remote_link', 'assign']);
export type TaskActionKind = z.infer<typeof TaskActionKind>;

export const TaskAction = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('transition'),
    /** nombre del estado destino ("En revisión") o id de transición de Jira */
    to_status: z.string().min(1).max(80).optional(),
    transition_id: z.string().max(20).optional(),
    /** comentario opcional que acompaña la transición */
    comment: z.string().max(4000).optional(),
  }),
  z.object({ kind: z.literal('comment'), body_markdown: z.string().min(1).max(8000) }),
  z.object({
    kind: z.literal('update_fields'),
    fields: z
      .object({
        story_points: z.number().nonnegative().optional(),
        labels_add: z.array(z.string().max(60)).max(20).optional(),
        labels_remove: z.array(z.string().max(60)).max(20).optional(),
        /** campos personalizados de métricas MagiCode (ids configurables por integración) */
        magicode_tokens: z.number().int().nonnegative().optional(),
        magicode_effective_lines: z.number().nonnegative().optional(),
        magicode_criticality: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      })
      .refine((f) => Object.keys(f).length > 0, 'al menos un campo'),
  }),
  z.object({
    kind: z.literal('remote_link'),
    /** URL absoluta, o plantilla que se renderiza a una (p. ej. "{{commit_url}}") */
    url: z
      .string()
      .min(1)
      .max(2048)
      .refine((u) => /^https?:\/\//.test(u) || /^\{\{[a-z_]+\}\}/.test(u), 'URL absoluta o plantilla {{…}}'),
    title: z.string().min(1).max(255),
    /** commit | pull_request | deployment | dashboard */
    relation: z.enum(['commit', 'pull_request', 'deployment', 'dashboard']),
  }),
  z.object({ kind: z.literal('assign'), assignee_account_id: z.string().max(128).nullable() }),
]);
export type TaskAction = z.infer<typeof TaskAction>;

/** POST /tasks/:taskKey/actions — acción manual desde el dashboard. */
export const TaskActionRequest = z.object({
  action: TaskAction,
  /** evita duplicar si el usuario hace doble click / reintenta */
  idempotency_key: z.string().min(8).max(128),
});
export type TaskActionRequest = z.infer<typeof TaskActionRequest>;

export const OutboxStatus = z.enum(['pending', 'sending', 'sent', 'failed', 'skipped']);
export type OutboxStatus = z.infer<typeof OutboxStatus>;

/** Fila de auditoría / outbox — GET /tasks/:taskKey/actions. */
export const OutboxAction = z.object({
  action_id: z.string(),
  tenant_id: z.string(),
  integration_id: z.string(),
  provider: TaskProvider,
  task_key: z.string(),
  action: TaskAction,
  origin: z.discriminatedUnion('type', [
    z.object({ type: z.literal('manual'), key_id: z.string() }), // quién (huella de la key)
    z.object({ type: z.literal('rule'), rule_id: z.string(), trigger_ref: z.string() }),
  ]),
  idempotency_key: z.string(),
  status: OutboxStatus,
  attempts: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  /** respuesta resumida del proveedor (id de comentario, estado resultante…) */
  result: z.record(z.string(), z.unknown()).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type OutboxAction = z.infer<typeof OutboxAction>;

/** Disparadores para reglas automáticas (salen de eventos IDE y webhooks del repo). */
export const RuleTrigger = z.enum([
  'session.started', // primera sesión MagiCode en la rama de la tarea
  'commit.linked', // commit con líneas IA enlazado a la tarea
  'pr.opened',
  'pr.merged',
  'reference.marked', // la tarea entra en la versión demo
  'deployment.success', // evidencia real de despliegue
]);
export type RuleTrigger = z.infer<typeof RuleTrigger>;

/**
 * Regla: cuando ocurre `trigger` (y se cumple `when`), encolar `action`.
 * `action` admite plantillas en textos y URLs: {{task_key}} {{sha}} {{commit_url}} {{repository}}
 * {{pr_url}} {{environment}} {{tokens}} {{effective_lines}} {{criticality}} {{dashboard_url}}.
 * {{commit_url}} se arma desde el remoto del repositorio (GitHub/Bitbucket); si no se conoce, la
 * acción se marca `skipped` en vez de publicar un enlace roto.
 */
export const AutomationRule = z.object({
  rule_id: z.string(),
  integration_id: z.string(),
  name: z.string().min(1).max(120),
  enabled: z.boolean(),
  trigger: RuleTrigger,
  when: z
    .object({
      environment: z.string().optional(), // deployment.success solo para "production"
      target_branch: z.string().optional(), // pr.merged solo hacia "main"
      from_status_category: z.enum(['todo', 'in_progress', 'done']).optional(),
    })
    .default({}),
  action: TaskAction,
  created_at: z.string(),
  updated_at: z.string(),
});
export type AutomationRule = z.infer<typeof AutomationRule>;
export const AutomationRuleUpsert = AutomationRule.omit({
  rule_id: true,
  integration_id: true,
  created_at: true,
  updated_at: true,
});
export type AutomationRuleUpsert = z.infer<typeof AutomationRuleUpsert>;

/** Reglas que se crean por defecto al conectar Jira (desactivables). */
export const DEFAULT_RULES: AutomationRuleUpsert[] = [
  {
    name: 'Enlazar commits con líneas IA',
    enabled: true,
    trigger: 'commit.linked',
    when: {},
    action: { kind: 'remote_link', url: '{{commit_url}}', title: 'Commit {{sha}} (MagiCode)', relation: 'commit' },
  },
  {
    name: 'PR abierto → En revisión',
    enabled: false,
    trigger: 'pr.opened',
    when: { from_status_category: 'in_progress' },
    action: { kind: 'transition', to_status: 'En revisión', comment: 'PR abierto: {{pr_url}}' },
  },
  {
    name: 'Despliegue en producción → Hecho',
    enabled: false,
    trigger: 'deployment.success',
    when: { environment: 'production' },
    action: {
      kind: 'transition',
      to_status: 'Hecho',
      comment: 'Desplegado {{sha}} en {{environment}}. Tokens MagiHub: {{tokens}} · líneas efectivas: {{effective_lines}}.',
    },
  },
];

/** PUT /integrations/:id/credentials — se guarda en Secrets Manager, respuesta sin secretos. */
export const TaskProviderCredentials = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('jira'),
    site_url: z.url(), // https://empresa.atlassian.net
    email: z.email(),
    api_token: z.string().min(10),
    /** ids de campos personalizados para escribir métricas (opcionales) */
    field_ids: z
      .object({
        story_points: z.string().optional(),
        magicode_tokens: z.string().optional(),
        magicode_effective_lines: z.string().optional(),
        magicode_criticality: z.string().optional(),
      })
      .optional(),
  }),
  z.object({ provider: z.literal('linear'), api_key: z.string().min(10) }),
]);
export type TaskProviderCredentials = z.infer<typeof TaskProviderCredentials>;

/** GET /tasks/:taskKey/transitions — transiciones disponibles ahora en Jira para el issue. */
export const AvailableTransition = z.object({ id: z.string(), name: z.string(), to_status: z.string(), to_category: z.enum(['todo', 'in_progress', 'done']) });
export type AvailableTransition = z.infer<typeof AvailableTransition>;
