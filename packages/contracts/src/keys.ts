/**
 * Diseño single-table de DynamoDB (`magicode-<env>-productivity`).
 * Tabla: PK (S), SK (S) · GSI1: GSI1PK (S), GSI1SK (S) · Stream NEW_AND_OLD_IMAGES → projector → RDS.
 *
 * | Entidad       | PK                         | SK                              | GSI1PK                  | GSI1SK                       |
 * |---------------|----------------------------|---------------------------------|-------------------------|------------------------------|
 * | Project       | T#{t}                      | P#{project}                     | –                       | –                            |
 * | Session       | T#{t}#S#{session}          | META                            | T#{t}#P#{project}       | S#{started_at}#{session}     |
 * | RawEvent      | T#{t}#S#{session}          | E#{occurred_at}#{event_id}      | –                       | –                            |
 * | EventDedupe   | T#{t}#EVT#{event_id}       | EVT                             | –                       | –                            |
 * | AiRequest     | T#{t}#S#{session}          | R#{ai_request_id}               | T#{t}#K#{key}           | R#{occurred_at}              |
 * | Change        | T#{t}#S#{session}          | C#{change_id}                   | –                       | –                            |
 * | Commit        | T#{t}#REPO#{repo}          | COMMIT#{sha}                    | T#{t}#S#{session}       | COMMIT#{committed_at}        |
 * | Reference     | T#{t}#REPO#{repo}          | REF#{tag}                       | –                       | –                            |
 * | UsageSnapshot | T#{t}#K#{key}              | U#{granularity}#{window_start}#{suffix} | –               | –                            |
 * | UsageMarker   | T#{t}#K#{key}              | U#sync#latest                   | –                       | –   (entity UsageSnapshot, kind=sync-marker) |
 * | Task          | T#{t}#TASK#{key}           | META                            | T#{t}#P#{project}       | TASK#{updated_at}            |
 * | TaskLink      | T#{t}#TASK#{key}           | L#{kind}#{id}                   | –                       | –                            |
 * | Branch        | T#{t}#REPO#{repo}          | BRANCH#{name}                   | T#{t}#P#{project}       | BRANCH#{last_activity_at}    |
 * | PullRequest   | T#{t}#REPO#{repo}          | PR#{number:08d}                 | T#{t}#P#{project}       | PR#{updated_at}              |
 * | Deployment    | T#{t}#REPO#{repo}          | DEPLOY#{deployment_id}          | T#{t}#REPO#{repo}#SHA#{sha} | DEPLOY#{updated_at}      |
 * | Integration   | T#{t}                      | INT#{integration_id}            | –                       | –                            |
 * | IntLookup     | INT#{integration_id}       | META                            | –                       | –                            |
 * | WebhookDelivery | T#{t}#WH#{delivery_id}   | WH                              | –                       | –  (TTL `expires_at` 30 d)   |
 *
 * | OutboxAction  | T#{t}#TASK#{key}           | ACT#{created_at}#{action_id}    | T#{t}#OUTBOX#{status}   | {created_at}                 |
 * | ActionIdem    | T#{t}#IDEM#{idempotency_key} | IDEM                          | –                       | –  (TTL 7 d)                 |
 * | AutomationRule| T#{t}#INT#{integration}    | RULE#{rule_id}                  | –                       | –                            |
 *
 * | IntHealth     | T#{t}#INT#{integration}    | HEALTH                          | –                       | –   (contadores 24 h, último error, last_event_at) |
 * | IntHealthBucket | T#{t}#INT#{integration}  | HEALTH#H#{yyyy-mm-ddThh}        | –                       | –   (contador horario por outcome, TTL `expires_at` 3 d) |
 * | IntTestRun    | T#{t}#INT#{integration}    | TEST#{started_at}#{test_id}     | –                       | –   (TTL 30 d)               |
 *
 * OutboxAction: el stream (filtro entity=OutboxAction ∧ status=pending) dispara task-sync.
 * TaskLink.kind ∈ branch | session | commit | pr | deployment — permite reconstruir todo lo de una tarea
 * con UN Query sobre PK = T#{t}#TASK#{key}. IntLookup resuelve tenant + secreto desde la URL del webhook
 * (el secreto se guarda cifrado en reposo por DynamoDB; ver docs/integrations.md).
 *
 * UsageSnapshot: `suffix` = `{request_id|unknown}` con granularity=request (window_start es el
 * instante de la petición) y `{model|all}` con hour/day (MagiHub puede desglosar por modelo). El
 * marcador de cobertura (`U#sync#latest`: granularity, covered_from/to, synced_at,
 * request_unsupported, ingestion_delay_minutes) comparte la partición; se excluye de las lecturas
 * por prefijo `U#{granularity}#`.
 *
 * Atributos extra de Commit (además de los del evento git.committed):
 *  - verified_remote, remote_pushed_at, remote_branch, remote_files, remote_author_login,
 *    remote_session_id: los escribe el webhook push; la proyección del IDE (UpdateItem) NUNCA los pisa.
 *  - remote_only: el push llegó antes que el IDE (commit mínimo sin automation real);
 *    ide_reported_at: el IDE lo reportó después (automation pasa a ser válida).
 *  - task_keys: unión de claves del IDE (rama/envelope) y del push (mensaje/rama), filtradas por prefijos.
 *  - reference_tags: Set con los tags de reference.marked que lo incluyen.
 * Atributos extra de IntLookup: provider_hook_id (id del webhook en el proveedor), pending_test
 * (prueba de ida y vuelta en curso), service_account_id y managed_field_ids (write-back: anti-bucle),
 * credentials_configured_at.
 * Session guarda key_fingerprint (sha256(key)[:12]) y key_name de la identidad MagiHub — nunca la key.
 *
 * Todas las entidades llevan `entity` (nombre de la fila de arriba), `tenant_id`, `key_id`,
 * `created_at`, `updated_at` y `provenance`.
 */

export const ENTITY = {
  project: 'Project',
  session: 'Session',
  rawEvent: 'RawEvent',
  dedupe: 'EventDedupe',
  aiRequest: 'AiRequest',
  change: 'Change',
  commit: 'Commit',
  reference: 'Reference',
  usage: 'UsageSnapshot',
  task: 'Task',
  taskLink: 'TaskLink',
  branch: 'Branch',
  pullRequest: 'PullRequest',
  deployment: 'Deployment',
  integration: 'Integration',
  integrationLookup: 'IntLookup',
  webhookDelivery: 'WebhookDelivery',
  outboxAction: 'OutboxAction',
  actionIdem: 'ActionIdem',
  automationRule: 'AutomationRule',
  integrationHealth: 'IntHealth',
  integrationTestRun: 'IntTestRun',
} as const;
export type EntityName = (typeof ENTITY)[keyof typeof ENTITY];

const enc = (v: string) => v.replace(/#/g, '%23');

export const keys = {
  project: (t: string, project: string) => ({ PK: `T#${enc(t)}`, SK: `P#${enc(project)}` }),
  projectsOfTenant: (t: string) => ({ PK: `T#${enc(t)}`, SKPrefix: 'P#' }),

  sessionPk: (t: string, session: string) => `T#${enc(t)}#S#${enc(session)}`,
  session: (t: string, session: string) => ({ PK: keys.sessionPk(t, session), SK: 'META' }),
  sessionGsi1: (t: string, project: string, startedAt: string, session: string) => ({
    GSI1PK: `T#${enc(t)}#P#${enc(project)}`,
    GSI1SK: `S#${startedAt}#${enc(session)}`,
  }),

  rawEvent: (t: string, session: string, occurredAt: string, eventId: string) => ({
    PK: keys.sessionPk(t, session),
    SK: `E#${occurredAt}#${eventId}`,
  }),
  dedupe: (t: string, eventId: string) => ({ PK: `T#${enc(t)}#EVT#${eventId}`, SK: 'EVT' }),

  aiRequest: (t: string, session: string, requestId: string) => ({
    PK: keys.sessionPk(t, session),
    SK: `R#${enc(requestId)}`,
  }),
  aiRequestGsi1: (t: string, keyId: string, occurredAt: string) => ({
    GSI1PK: `T#${enc(t)}#K#${enc(keyId)}`,
    GSI1SK: `R#${occurredAt}`,
  }),

  change: (t: string, session: string, changeId: string) => ({
    PK: keys.sessionPk(t, session),
    SK: `C#${enc(changeId)}`,
  }),

  repoPk: (t: string, repo: string) => `T#${enc(t)}#REPO#${enc(repo)}`,
  commit: (t: string, repo: string, sha: string) => ({ PK: keys.repoPk(t, repo), SK: `COMMIT#${sha}` }),
  commitGsi1: (t: string, session: string, committedAt: string) => ({
    GSI1PK: keys.sessionPk(t, session),
    GSI1SK: `COMMIT#${committedAt}`,
  }),
  reference: (t: string, repo: string, tag: string) => ({ PK: keys.repoPk(t, repo), SK: `REF#${enc(tag)}` }),

  usage: (t: string, keyId: string, granularity: string, windowStart: string) => ({
    PK: `T#${enc(t)}#K#${enc(keyId)}`,
    SK: `U#${granularity}#${windowStart}`,
  }),

  taskPk: (t: string, taskKey: string) => `T#${enc(t)}#TASK#${enc(taskKey)}`,
  task: (t: string, taskKey: string) => ({ PK: keys.taskPk(t, taskKey), SK: 'META' }),
  taskGsi1: (t: string, project: string, updatedAt: string) => ({
    GSI1PK: `T#${enc(t)}#P#${enc(project)}`,
    GSI1SK: `TASK#${updatedAt}`,
  }),
  taskLink: (t: string, taskKey: string, kind: 'branch' | 'session' | 'commit' | 'pr' | 'deployment', id: string) => ({
    PK: keys.taskPk(t, taskKey),
    SK: `L#${kind}#${enc(id)}`,
  }),

  branch: (t: string, repo: string, name: string) => ({ PK: keys.repoPk(t, repo), SK: `BRANCH#${enc(name)}` }),
  branchGsi1: (t: string, project: string, lastActivityAt: string) => ({
    GSI1PK: `T#${enc(t)}#P#${enc(project)}`,
    GSI1SK: `BRANCH#${lastActivityAt}`,
  }),
  pullRequest: (t: string, repo: string, n: number) => ({
    PK: keys.repoPk(t, repo),
    SK: `PR#${String(n).padStart(8, '0')}`,
  }),
  pullRequestGsi1: (t: string, project: string, updatedAt: string) => ({
    GSI1PK: `T#${enc(t)}#P#${enc(project)}`,
    GSI1SK: `PR#${updatedAt}`,
  }),
  deployment: (t: string, repo: string, deploymentId: string) => ({
    PK: keys.repoPk(t, repo),
    SK: `DEPLOY#${enc(deploymentId)}`,
  }),
  deploymentGsi1: (t: string, repo: string, sha: string, updatedAt: string) => ({
    GSI1PK: `${keys.repoPk(t, repo)}#SHA#${sha}`,
    GSI1SK: `DEPLOY#${updatedAt}`,
  }),

  integration: (t: string, integrationId: string) => ({ PK: `T#${enc(t)}`, SK: `INT#${integrationId}` }),
  integrationLookup: (integrationId: string) => ({ PK: `INT#${integrationId}`, SK: 'META' }),
  webhookDelivery: (t: string, deliveryId: string) => ({ PK: `T#${enc(t)}#WH#${enc(deliveryId)}`, SK: 'WH' }),

  outboxAction: (t: string, taskKey: string, createdAt: string, actionId: string) => ({
    PK: keys.taskPk(t, taskKey),
    SK: `ACT#${createdAt}#${actionId}`,
  }),
  outboxGsi1: (t: string, status: string, createdAt: string) => ({
    GSI1PK: `T#${enc(t)}#OUTBOX#${status}`,
    GSI1SK: createdAt,
  }),
  actionIdem: (t: string, idempotencyKey: string) => ({ PK: `T#${enc(t)}#IDEM#${enc(idempotencyKey)}`, SK: 'IDEM' }),
  integrationHealth: (t: string, integrationId: string) => ({ PK: `T#${enc(t)}#INT#${integrationId}`, SK: 'HEALTH' }),
  integrationTestRun: (t: string, integrationId: string, startedAt: string, testId: string) => ({
    PK: `T#${enc(t)}#INT#${integrationId}`,
    SK: `TEST#${startedAt}#${testId}`,
  }),
  automationRule: (t: string, integrationId: string, ruleId: string) => ({
    PK: `T#${enc(t)}#INT#${integrationId}`,
    SK: `RULE#${ruleId}`,
  }),
} as const;
