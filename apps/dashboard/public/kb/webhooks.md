# Webhooks del repositorio (GitHub / Bitbucket) y del gestor de tareas (Jira)

## Qué es

Los **webhooks** traen al servicio de productividad lo que ocurre fuera del IDE: pushes, ramas, tags, pull requests y despliegues del repositorio origen, y altas/cambios de tareas del gestor (Jira). Con ellos se completan las etapas del embudo que el IDE no ve (PR, merge, despliegue) y se enlaza el trabajo con la tarea de negocio.

## Cómo se calcula

Flujo de una entrega:

```
Proveedor ──POST /api/v1/webhooks/{provider}/{integration_id}──▶ API (sin Bearer)
  1. IntLookup (PK INT#{integration_id}) → tenant, proyecto, secreto HMAC
  2. Verificación de firma con el secreto de la integración (tiempo constante)
  3. Dedupe por delivery id (WebhookDelivery, TTL 30 días)
  4. Adaptador del proveedor → NormalizedWebhookEvent[] (validado con Zod)
  5. Proyección a entidades: Branch, Commit, PullRequest, Deployment, Task, TaskLink
```

Los webhooks **no traen API key**: el tenant sale de la integración (el id va en la URL) y la autenticidad, de la firma.

Firma por proveedor (`WEBHOOK_SIGNATURE_HEADERS`):

| proveedor   | header de firma        | formato                                  | header de entrega               | header de evento              |
|-------------|------------------------|------------------------------------------|---------------------------------|-------------------------------|
| `github`    | `x-hub-signature-256`  | `sha256=<hex HMAC-SHA256(secreto, cuerpo crudo)>` | `x-github-delivery`     | `x-github-event`              |
| `bitbucket` | `x-hub-signature`      | `sha256=<hex>`                           | `x-request-uuid`                | `x-event-key`                 |
| `jira`      | `x-hub-signature`      | `sha256=<hex>`                           | `x-atlassian-webhook-identifier`| `x-atlassian-webhook-flow` (el tipo real va en el cuerpo: `webhookEvent`) |
| `gitlab`    | `x-gitlab-token`       | secreto en claro (GitLab no firma)       | `x-gitlab-event-uuid`           | `x-gitlab-event`              |
| `linear`    | `linear-signature`     | `<hex>`                                  | `linear-delivery`               | `linear-event`                |

Eventos soportados y su forma normalizada:

| proveedor  | evento del proveedor                                      | evento normalizado (`kind`)  | campos clave |
|------------|-----------------------------------------------------------|------------------------------|--------------|
| GitHub     | `push` a `refs/heads/*`                                   | `repo.push`                  | `branch`, `before`, `after`, `forced`, `commits[]` |
| GitHub     | `push` a `refs/tags/*`                                    | `repo.tag`                   | `tag`, `sha`, `action` |
| GitHub     | `create` / `delete` de rama, `push` con `deleted`         | `repo.branch`                | `branch`, `action` |
| GitHub     | `pull_request` (`opened`, `edited`, `closed`, `reopened`, `synchronize`, `ready_for_review`, `converted_to_draft`) | `repo.pull_request` | `number`, `state`, `source_branch`, `target_branch`, `merge_sha`, `head_sha`, `title_task_keys`, `url` |
| GitHub     | `deployment_status`                                       | `repo.deployment`            | `deployment_id`, `sha`, `environment`, `state`, `url` (evidencia) |
| Bitbucket  | `repo:push` (ramas y tags)                                | `repo.push` / `repo.tag` / `repo.branch` | igual que GitHub, sin conteo de archivos |
| Bitbucket  | `pullrequest:created|updated|fulfilled|rejected`          | `repo.pull_request`          | `fulfilled`/`MERGED` → `merged`; `rejected`/`DECLINED`/`SUPERSEDED` → `closed` |
| Jira Cloud | `jira:issue_created`, `jira:issue_updated`                | `task.upserted`              | `task_key`, `title`, `type`, `status`, `status_category`, `assignee`, `story_points`, `url` |
| Jira Cloud | `jira:issue_deleted`                                      | `task.deleted`               | `task_key` |
| todos      | `ping` / `diagnostics:ping`                               | (ping)                       | – |

Detalles de normalización:

- `commits[]` (`RepoCommitRef`): `sha`, `message_task_keys` (claves del mensaje + trailer `MagiCode-Task:`), `author_login`, `timestamp`, `files_added`/`files_modified`/`files_removed` (conteos de archivos), `has_session_trailer` y `session_id` (del trailer `MagiCode-Session:`). **El mensaje no se guarda**.
- PR `state`: `merged` si el proveedor lo marca fusionado; `closed` si se cerró sin fusionar; `open` en otro caso. `merge_sha` solo se informa si se fusionó.
- Jira `status_category`: `new` → `todo`, `indeterminate` → `in_progress`, `done` → `done`. Story points del campo `customfield_10016` (configurable con `JIRA_STORY_POINTS_FIELD`). `url = {base_url}/browse/{key}`.
- Deployment `state` de GitHub: `queued`/`waiting` → `pending`; `success`, `failure`, `error`, `inactive`, `in_progress` se mantienen.

Respuestas:

| código | cuándo |
|--------|--------|
| `200 {ok, ping}` | ping del proveedor |
| `200 {ok, processed, kinds}` | entrega procesada |
| `200 {ok, duplicate}` | la entrega (`{provider}:{delivery_id}`) ya se había procesado |
| `202 {ok, ignored, reason}` | evento no soportado, o fuera del alcance de la integración (otro repositorio, o tarea de un prefijo Jira no configurado) |
| `400` | el proveedor de la URL no coincide con el de la integración, o el cuerpo no es JSON |
| `401` | firma inválida o ausente |
| `404` | proveedor desconocido, integración inexistente o deshabilitada |

Si la proyección falla, se borra el registro de dedupe para que el reintento del proveedor sí se procese. Cada entrega aceptada actualiza `Integration.last_delivery_at` y pasa la integración a `active`.

Reglas de proyección relevantes para las métricas:

- Un commit que llega por `push` y que el IDE nunca reportó se guarda como commit "solo remoto" con `automation` en cero: no suma líneas IA al embudo.
- PR: el estado es monótono (un PR `merged` no vuelve a `open`/`closed` por una entrega desordenada). Se guardan `opened_at`, `merged_at` y `closed_at` con la **hora de recepción** del webhook, no la del proveedor. Al fusionar, la rama origen guarda `merged_into`.
- Deployment: `success` es terminal (un `inactive` posterior no borra la evidencia; el último estado queda en `latest_state`). Se enlaza a tareas por el commit con ese SHA, por los PR cuyo `merge_sha`/`head_sha` coincide y por la clave en `ref`.
- Tarea: no se pisa una versión más nueva (`source_updated_at`) con una entrega desordenada; `task.deleted` marca `deleted = true`.

Integraciones: `POST /api/v1/integrations` con `{provider, project_id, repository}` (Git) o `{provider, project_id, task_project_keys, base_url?}` (Jira). El backend genera el secreto (32 bytes hex) y lo devuelve **una sola vez** (`IntegrationCreated.webhook_secret`), junto con `webhook_url`. Estado: `pending` hasta la primera entrega, `active`, `disabled`. `POST /integrations/{id}/rotate-secret` lo rota.

## Fuente y procedencia

- Fuente: `git-remote` (repositorio) y gestor de tareas. Procedencia `real`: los datos vienen firmados por el proveedor.
- Los despliegues por webhook son la única vía, junto con `reference.marked{kind=deployment}` con `evidence_url`, de llegar a la etapa `deployed` (`deployment-evidence`).

## Cómo interpretarlo

- `Integration.last_delivery_at` antiguo o `null` con `status = pending`: el webhook no está configurado o la firma falla. Revisar el secreto en el proveedor.
- `counts.pull_requests`, `counts.pull_requests_merged`, `counts.deployments_success`, `counts.tasks` y `counts.tasks_done` del resumen salen de estas entregas; si están en 0 con actividad en el IDE, falta la integración.
- `has_session_trailer = true` en un commit remoto permite enlazarlo con la sesión aunque el IDE no haya emitido `git.committed` (p. ej. commit hecho desde otra máquina).
- Los webhooks del repositorio (`pr.opened`, `pr.merged`, `deployment.success`…) también disparan las reglas que escriben de vuelta en Jira; ver [respuesta a tareas](respuesta-a-tareas.md). Los webhooks de Jira provocados por esas escrituras se filtran con el anti-bucle.

## Ejemplo

Sesión `demo-001` (ver [ejemplo completo](ejemplo-demo-001.md)):

1. Jira envía `jira:issue_updated` de `MAG-123` (Story, 5 puntos, estado "In Progress" → `in_progress`). Se crea/actualiza la tarea.
2. GitHub envía `create` de la rama `feature/MAG-123-descuentos` → `repo.branch` (created). La clave `MAG-123` se extrae del nombre y se crea el enlace tarea → rama.
3. GitHub envía `push` con el commit `3f9c2e1`: mensaje "MAG-123 descuentos por volumen" con trailer `MagiCode-Session: demo-001` → `message_task_keys = ["MAG-123"]`, `has_session_trailer = true`, `session_id = "demo-001"`.
4. GitHub envía `pull_request` `opened` del #14 (`feature/MAG-123-descuentos` → `main`, título "MAG-123: descuentos por volumen") → `state = open`.
5. Al fusionar: `pull_request` `closed` con `merged = true` → `state = merged`, `merge_sha = 9d8e7f6…`.
6. Push del tag `demo-v0.1` → `repo.tag` (created, `sha = 9d8e7f6…`). La extensión emite `reference.marked` con `kind = demo-reference`.
7. Jira envía `jira:issue_updated` con estado "Done" → `status_category = done`; `counts.tasks_done = 1`.

No hay `deployment_status`: `counts.deployments_success = 0` y la etapa `deployed` queda en 0.

## Errores comunes / límites

- La firma se calcula sobre el **cuerpo crudo**: un proxy que reformatee el JSON rompe la verificación.
- Bitbucket no informa archivos por commit en el webhook: `files_added/modified/removed = 0`.
- El adaptador de Bitbucket no procesa despliegues: la etapa `deployed` desde Bitbucket requiere `reference.marked{kind=deployment}` con `evidence_url` (p. ej. URL del pipeline).
- `create`/`delete` de tags en GitHub se ignoran (no traen SHA); los tags se procesan desde `push`.
- Un despliegue solo cuenta para las líneas de una sesión si su SHA es el **mismo** que el del commit de la sesión (ver [embudo](embudo.md)).
- Jira Cloud solo firma los webhooks de administración con secreto; los webhooks de Automation no firman.

## Implementación

- Contratos: `packages/contracts/src/integrations.ts` (`Integration`, `IntegrationCreate`, `NormalizedWebhookEvent`, `RepoCommitRef`), `packages/contracts/src/api.ts` (`ROUTES.webhook`, `WEBHOOK_SIGNATURE_HEADERS`).
- Firma: `apps/api/src/modules/webhooks/webhooks.signature.ts`.
- Adaptadores: `apps/api/src/modules/webhooks/adapters/` (`github.adapter.ts`, `bitbucket.adapter.ts`, `jira.adapter.ts`, `gitlab.adapter.ts`, `linear.adapter.ts`, `common.ts`).
- Orquestación (lookup, firma, alcance, dedupe): `apps/api/src/modules/webhooks/webhooks.service.ts`; proyección a entidades (Branch, Commit, PullRequest, Deployment, Task, TaskLink): `apps/api/src/modules/webhooks/webhooks.projection.ts`; persistencia: `apps/api/src/modules/webhooks/webhooks.repository.ts`.
- Integraciones: `apps/api/src/modules/integrations/`. Guía de configuración por proveedor: `docs/integrations.md`.
