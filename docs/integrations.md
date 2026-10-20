# Integraciones — repositorio, gestor de tareas y write-back

MagiCode relaciona el consumo de tokens de MagiHub con el código IA que se acepta, se registra en
Git y llega a una versión/despliegue. Los **webhooks** del repositorio origen (GitHub, Bitbucket,
GitLab) y del gestor de tareas (Jira, Linear) centralizan todo en el backend:

```
tenant (API key MagiHub) ─ proyecto ─┬─ repositorio ── webhook git ──► push · rama · tag · PR · deploy
                                     ├─ tareas ─────── webhook Jira ──► issue creado/actualizado/borrado
                                     └─ sesiones IDE ─ cambios ─ commits ─ PR ─ despliegue
```

Código: `apps/api/src/modules/{integrations,webhooks,tasks,branches,pull-requests,task-sync,integration-health}`.
Contratos: `packages/contracts/src/{integrations,writeback,health,keys,api}.ts`.

---

## 1. Integraciones obligatorias y salud

Un repositorio está **listo** solo si tiene, ambos obligatorios:

1. el **webhook del repositorio** (GitHub/Bitbucket/GitLab) activo y verificado;
2. el **webhook del gestor de tareas** (Jira/Linear) del proyecto, activo y verificado.

El dashboard elige el repositorio en una lista desplegable (`GET /repositories`) y muestra su
**conjunto de claves** (`GET /repositories/{org%2Frepo}/readiness`): API keys de MagiHub usadas en ese
repo (dedicada / compartida), webhook del repositorio, webhook de tareas, actividad del IDE y los
motivos que bloquean. Un proyecto está listo si **todos** sus repos lo están
(`GET /projects/{id}/readiness`). Mientras no lo esté, el resumen de productividad incluye el aviso
`project_not_ready` y las etapas que dependen de webhooks (Git verificado, PR, despliegue, tareas) se
muestran como estimadas.

### Estados (`HealthStatus`)

| estado | significado |
|---|---|
| `not_configured` | no existe la integración para ese rol |
| `disabled` | la integración fue deshabilitada (`DELETE /integrations/:id`) |
| `failing` | algún check en `fail` (firma inválida, el proveedor reporta error, prueba fallida, webhook ausente) — tiene prioridad porque explica por qué no llegan eventos |
| `awaiting_first_delivery` | creada, nunca llegó un evento con firma válida |
| `degraded` | funciona pero hay advertencias |
| `healthy` | entregas válidas y todos los checks en `pass`/`skipped` |

Bloquean "listo": `not_configured`, `disabled`, `awaiting_first_delivery`, `failing`.

### Checks y cómo resolverlos

`GET /integrations/:id/health` evalúa con datos locales (barato). Con `?refresh=true` además consulta
la API del proveedor (requiere credenciales) y deja el resultado en caché (`checked_at`).

| check | rol | fail / warn cuando… | cómo arreglarlo (acción sugerida) |
|---|---|---|---|
| `integration_exists` | ambos | falta o está deshabilitada | crear la integración (`create_integration`) |
| `credentials_valid` | ambos | el proveedor rechaza el token (solo con refresh) | generar un token nuevo con permisos de webhooks (`add_credentials`) |
| `webhook_registered` | ambos | el proveedor no tiene un webhook a nuestra URL, o está desactivado | botón «Registrar» (`register_webhook`) o crearlo a mano |
| `webhook_events` | ambos | faltan eventos requeridos (warn) | volver a registrar: actualiza los eventos |
| `signature_valid` | ambos | **fail**: la última entrega llegó con firma inválida y no hubo una válida después; **warn**: hubo rechazos en 24 h pero luego entregas válidas (¿webhook duplicado con un secreto viejo?) | rotar el secreto (`rotate_secret`) y pegarlo en el proveedor; borrar webhooks duplicados |
| `recent_delivery` | repo | sin eventos en 7 días **y** hubo sesiones del IDE en ese repo | revisar que el webhook siga activo |
| `recent_delivery` | tareas | sin eventos en 7 días | revisar el webhook y el filtro JQL |
| `provider_last_response` | repo (GitHub) | GitHub reporta que nuestra última respuesta fue HTTP ≥ 400 | revisar secreto y URL; lanzar la prueba |
| `roundtrip_test` | ambos | **fail**: la última prueba falló/expiró; **warn**: nunca se ejecutó o tiene > 7 días | `POST /integrations/:id/test` |
| `commits_reconciled` | repo | commits reportados por el IDE hace > 1 h (y después de crear el webhook) que no llegaron por `push` | hacer push o añadir el evento `push` al webhook |
| `tasks_reconciled` | tareas | claves usadas en ramas sin tarea sincronizada (muestra hasta 5) | revisar el filtro JQL o editar esas tareas |

Contabilidad de entregas (`deliveries_24h`): `accepted`, `duplicate`, `ignored`, `rejected_signature`,
`rejected_other` por hora (filas `HEALTH#H#<hora>` con TTL de 3 días) + `last_event_at` por tipo de
evento, `last_delivery_at` y `last_error`. Las firmas inválidas se registran contra la integración de
la URL. **Nunca** se guarda el cuerpo ni el secreto.

### Prueba de ida y vuelta

`POST /integrations/:id/test` (`{ "mode": "auto" | "manual", "test_issue_key": "MAG-1" }`) y polling a
`GET /integrations/:id/tests/:testId`.

| proveedor | modo auto (con credenciales) | se completa cuando llega… |
|---|---|---|
| GitHub | `POST /repos/{o}/{r}/hooks/{id}/pings` | el evento `ping` firmado |
| GitLab | `POST /projects/:id/hooks/:hook_id/test/push_events` | un `push` firmado |
| Bitbucket | sin ping: verifica el webhook por API + último evento válido (< 7 d) | resultado inmediato |
| Jira | agrega y quita la etiqueta `magicode-healthcheck` en `test_issue_key` | el `jira:issue_updated` de esa etiqueta (el anti-bucle lo reconoce como prueba; solo actualiza `updated_at` de la tarea) |
| sin credenciales / Linear | manual: se devuelven `instructions` (Redeliver en GitHub, editar un issue en Jira) | la próxima entrega con firma válida |

Pasos: «Ping enviado al proveedor» → «Evento recibido» → «Firma válida» → «Procesado». Si llega una
entrega con firma inválida durante la prueba, falla con el diagnóstico del secreto. Timeout: 60 s
(auto) / 15 min (manual), evaluado al consultar. Las pruebas expiran (TTL) a los 30 días.

### Registro automático del webhook

`POST /integrations/:id/register-webhook` crea o actualiza el webhook con nuestra URL, el secreto y
`REQUIRED_WEBHOOK_EVENTS`; guarda `provider_hook_id`. Requiere credenciales (`PUT /credentials`):

| proveedor | API | permisos del token |
|---|---|---|
| GitHub | `POST/PATCH /repos/{o}/{r}/hooks` (content_type json) | fine-grained PAT: *Webhooks: read & write*, *Metadata: read* |
| Bitbucket | `POST/PUT /2.0/repositories/{ws}/{repo}/hooks` | app password: *Webhooks*, *Repositories: read* |
| GitLab | `POST/PUT /projects/:id/hooks` | token con `api` (Maintainer del proyecto) |
| Jira Cloud | `POST/PUT /rest/webhooks/1.0/webhook` con `project in (KEYS)` | **administrador de Jira**; si responde 403 la API devuelve URL, eventos y JQL para crearlo a mano |
| Linear | — | crear el webhook a mano en Settings → API |

---

## 2. Crear una integración

```http
POST /api/v1/integrations
Authorization: Bearer <API key MagiHub>

{ "provider": "github", "project_id": "shop", "repository": "acme/shop" }
{ "provider": "jira", "project_id": "shop", "task_project_keys": ["MAG"], "base_url": "https://empresa.atlassian.net" }
```

Respuesta (201, `IntegrationCreated`): `integration_id` (`int_` + 16 hex), `webhook_url`
(`${PUBLIC_API_URL}/api/v1/webhooks/{provider}/{integration_id}`; sin `PUBLIC_API_URL` se usa el origen
de la petición) y `webhook_secret` (32 bytes hex) **una sola vez**. Si se pierde:
`POST /integrations/:id/rotate-secret` devuelve uno nuevo (y hay que actualizarlo en el proveedor).

- `repository` acepta `org/repo` o la URL del repo; debe coincidir con el `repository` que reporta la
  extensión (la comparación con el payload no distingue mayúsculas).
- `GET /integrations` lista sin secretos; `DELETE /integrations/:id` deshabilita (los datos ya
  proyectados se conservan; el webhook pasa a responder 404).

### Secreto en reposo

El secreto HMAC vive solo en la fila `IntLookup` (`PK = INT#<id>`), nunca en la fila `Integration` ni en
logs ni respuestas (salvo la única vez al crear/rotar). DynamoDB lo cifra en reposo con la cifrado por
defecto (clave propiedad de AWS). **Endurecimiento** recomendado para producción:

1. Tabla con **KMS CMK** propia (`encryption: CUSTOMER_MANAGED`) y política de clave restringida a la
   Lambda de la API; o
2. Mover el secreto a **Secrets Manager** (`magicode/<env>/integrations/<id>/webhook`) y cachearlo en
   memoria en la Lambda — mismo patrón que las credenciales de proveedor (sección 7).

---

## 3. Configurar cada proveedor

### GitHub (principal)
Repo → **Settings → Webhooks → Add webhook**:
- *Payload URL*: `webhook_url`
- *Content type*: `application/json` (obligatorio: la firma se calcula sobre el cuerpo crudo)
- *Secret*: `webhook_secret`
- Eventos: **Pushes, Branch or tag creation, Branch or tag deletion, Pull requests, Deployment statuses**
  (`push, create, delete, pull_request, deployment_status`).

Firma: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256>`; delivery id `X-GitHub-Delivery`.

### Bitbucket Cloud
Repository settings → **Webhooks → Add webhook**: URL, *Secret* = `webhook_secret`, triggers
**Repository: Push** y **Pull request: Created, Updated, Merged, Declined**.
Firma: `X-Hub-Signature: sha256=<hex>`; delivery id `X-Request-UUID`; evento `X-Event-Key`.

### GitLab (opcional)
Settings → **Webhooks**: URL, *Secret token* = `webhook_secret`, triggers **Push events, Tag push
events, Merge request events, Deployment events**. GitLab no firma: compara `X-Gitlab-Token` con el
secreto (en tiempo constante). Delivery id `X-Gitlab-Event-UUID`.

### Jira Cloud (principal)
**Configuración → Sistema → WebHooks → Crear un WebHook** (requiere administrador):
- URL: `webhook_url`; *Secret*: `webhook_secret`
- Eventos: **Issue: created, updated, deleted**
- Filtro JQL: `project = MAG` (o `project in (MAG, OPS)`)

Firma: `X-Hub-Signature: sha256=<hex>`; delivery id `X-Atlassian-Webhook-Identifier`.
Story points: campo `JIRA_STORY_POINTS_FIELD` (por defecto `customfield_10016`).
`statusCategory.key`: `new → todo`, `indeterminate → in_progress`, `done → done`.

### Linear (opcional)
Settings → **API → Webhooks**: URL, recurso **Issues**. Firma `Linear-Signature: <hex>`.
`state.type`: `backlog|unstarted|triage → todo`, `started → in_progress`, `completed|canceled → done`.

### Respuestas del endpoint `POST /api/v1/webhooks/:provider/:integrationId`

| código | cuándo |
|---|---|
| 200 `{processed, kinds}` | evento procesado |
| 200 `{ping}` / `{test}` | ping del proveedor / entrega de prueba de Jira |
| 200 `{duplicate}` | delivery id ya recibido (dedupe 30 días) |
| 200 `{ignored:"self"}` | eco de nuestro propio write-back (anti-bucle) |
| 202 `{ignored, reason}` | evento no soportado, otro repositorio u otro proyecto Jira |
| 400 | JSON inválido, proveedor de la URL ≠ proveedor de la integración |
| 401 | firma ausente o inválida |
| 404 | integración inexistente o deshabilitada |
| 413 | cuerpo > 1 MB |

El procesamiento es síncrono (responde en < 2 s típicamente). Si la proyección falla se libera el
dedupe y se responde 5xx para que el proveedor reintente.

---

## 4. Reglas de enlace

Las claves se extraen con `extractTaskKeys` (regex `PROYECTO-123`, sin distinguir mayúsculas):

| origen | regla |
|---|---|
| Rama | `feature/MAG-123-login`, `fix/mag-123` → `MAG-123` |
| Commit | claves en el mensaje + las de la rama (el mensaje **no** se guarda) |
| Trailers | `MagiCode-Task: MAG-124` añade la tarea; `MagiCode-Session: <session_id>` enlaza el commit con la sesión del IDE |
| PR | claves del título + de la rama origen |
| Despliegue | tareas del commit desplegado + de los PR cuyo `merge_sha`/`head_sha` coincide + de `ref` |

- Si el proyecto tiene Jira/Linear configurado, solo se aceptan claves con sus prefijos
  (`task_project_keys`); si no, se descartan falsos positivos conocidos (`UTF-8`, `SHA-256`, `ISO-8601`…).
- A las ramas largas (`main`, `master`, `develop`, `release/*`…) solo se les asocian las claves de su
  nombre, no las de cada commit.
- `push` → el `Commit` del IDE queda `verified_remote: true` (+ `remote_pushed_at`, `remote_branch`); si
  el IDE nunca lo reportó se crea un commit mínimo `remote_only` (`commit_source: git-remote`, 0 líneas IA).
- Tag → solo marca `verified_remote` en una `Reference` existente (nunca crea "versiones demo").
- PR fusionado → `Branch.merged_into`; un PR fusionado no vuelve a abierto por entregas desordenadas.
- **Solo `deployment_status = success`** es evidencia de despliegue (`source: deployment-evidence`,
  `provenance: real`); un `inactive` posterior no borra la evidencia (`latest_state` lo registra).
- Tareas: entregas desordenadas no pisan una versión más nueva (`source_updated_at`).

---

## 5. Aislamiento multitenant

- Los webhooks **no** traen API key: el tenant sale **siempre** de `IntLookup` (por el id de la URL),
  nunca del payload. La autenticidad la da la firma HMAC con el secreto de esa integración.
- Aunque la firma sea válida, solo se aceptan eventos del `repository` / `task_project_keys`
  configurados (un webhook de organización no puede escribir en otro repo).
- Las rutas con Bearer usan `tenant_id` del contexto; todas las claves Dynamo empiezan por `T#<tenant>`.

---

## 6. Qué se guarda y retención

Solo campos normalizados — **nunca** payloads completos, mensajes de commit, código ni diffs.

| entidad | campos |
|---|---|
| `Branch` | repo, rama, head_sha, task_keys, commit_shas, merged_into, deleted, last_activity_at |
| `Commit` (remoto) | verified_remote, remote_pushed_at, remote_branch, conteos de archivos, autor (login), session_id del trailer, task_keys |
| `PullRequest` | número, estado, ramas, head/merge sha, URL, task_keys, fechas |
| `Deployment` | id, sha, ref, entorno, estado, URL de evidencia |
| `Task` | clave, resumen, tipo, estado, categoría, responsable (nombre), story points, URL |
| `TaskLink` | enlaces tarea ↔ rama/sesión/commit/PR/despliegue |
| `WebhookDelivery` | delivery id, tipos de evento — **TTL 30 días** |
| `IntHealth` / buckets | contadores y fechas — buckets con **TTL 3 días** |
| `IntTestRun` | pasos de la prueba — **TTL 30 días** |
| `OutboxAction` / `ActionIdem` | auditoría del write-back / idempotencia (**TTL 7 días** en `ActionIdem`) |

---

## 7. Write-back al gestor de tareas (Jira primero)

```
Dashboard (manual) ─┐
                    ├─► OutboxAction (pending) ─► DynamoDB Stream ─► Lambda task-sync ─► API Jira
Regla automática ───┘        ▲                                              │
                             └──────── sent / failed / reintentos ◄─────────┘
```

### Configuración
1. Crear un **API token** de Atlassian (id.atlassian.com → Security → API tokens) para una cuenta de
   servicio con permisos en el proyecto: **Browse projects, Transition issues, Add comments, Edit
   issues, Link issues** (y *Administer Jira* solo si se quiere registrar el webhook automáticamente).
2. `PUT /integrations/:id/credentials` con
   `{ "provider": "jira", "site_url": "https://empresa.atlassian.net", "email": "bot@empresa.com", "api_token": "…", "field_ids": { "magicode_tokens": "customfield_10100" } }`.
   Se verifica con `GET /rest/api/3/myself`, se guarda en **Secrets Manager**
   (`magicode/<APP_ENV>/integrations/<id>`), se registra `service_account_id` (anti-bucle) y, la primera
   vez, se siembran las reglas por defecto. Respuesta 204: las credenciales nunca se devuelven.
   Para integraciones git el mismo endpoint acepta `GitProviderCredentials` (token de GitHub/GitLab o
   app password de Bitbucket) y se verifica con `GET repo` + `GET hooks`.

### Acciones
`POST /tasks/:taskKey/actions` con `{ action, idempotency_key }` → 202 (`OutboxAction` pending) o 200
si la clave ya se usó (devuelve la original). Tipos: `transition` (por nombre de estado — sin
mayúsculas ni acentos — o id; error claro con los estados disponibles), `comment` (markdown →
Atlassian Document Format: párrafos, **negrita**, `código`, enlaces, listas, bloques de código),
`update_fields` (etiquetas, story points y campos de métricas con `field_ids`), `remote_link`
(idempotente por `globalId = magicode:<relación>:<url>`), `assign`.
`GET /tasks/:taskKey/actions` = auditoría (más reciente primero). `GET /tasks/:taskKey/transitions` =
transiciones disponibles ahora (consulta en vivo).

### Reglas automáticas
`GET/POST /integrations/:id/rules`, `PUT/DELETE /integrations/:id/rules/:ruleId`. Disparadores:
`pr.opened`, `pr.merged`, `deployment.success`, `reference.marked` (los emite el webhook) y
`commit.linked`, `session.started` (los emite la ingesta del IDE). Condiciones `when`: `environment`,
`target_branch`, `from_status_category`. Plantillas: `{{task_key}} {{sha}} {{commit_url}}
{{repository}} {{pr_url}} {{environment}} {{tokens}} {{effective_lines}} {{criticality}}
{{dashboard_url}}`. `{{commit_url}}` se arma desde el `remote_url` del commit (GitHub/Bitbucket/GitLab);
si no se conoce, la acción se registra como `skipped` con `last_error: "commit_url desconocido"` en vez
de publicar un enlace roto. Idempotencia: `idempotency_key = <rule_id>:<tarea>|<hecho>` — el mismo
hecho nunca encola dos veces la misma regla.

Reglas por defecto: enlazar commits con líneas IA (activa), PR abierto → «En revisión» y despliegue en
producción → «Hecho» (desactivadas).

### Entrega, reintentos y auditoría
- `pending → sending → sent | skipped | failed`. 429/5xx/red: hasta 3 intentos en la invocación
  (respetando `Retry-After`, máx. 5 s) y luego vuelve a `pending` y se reintenta vía stream
  (`reportBatchItemFailures`), hasta **5 intentos**. 4xx (salvo 429) ⇒ `failed` definitivo.
- `last_error` es un resumen (sin secretos). Un `sending` huérfano (> 2 min) se puede re-tomar.
- Tras cada acción se escribe la propiedad de entidad `magicode.last_action = {action_id, at}`.
- Una transición actualiza también la `Task` local (su webhook se ignora por anti-bucle).

### Anti-bucle
Un `jira:issue_updated` cuyo actor (`user.accountId`) es la cuenta de servicio y cuyo changelog solo
toca campos que gestiona MagiCode (estado, resolución, etiquetas, responsable, story points, campos de
métricas) se responde `200 {ignored:"self"}`. Si la misma cuenta cambió otros campos, se procesa. La
etiqueta `magicode-healthcheck` se reconoce como prueba (sección 1), no como eco.

---

## 8. Rutas

| método | ruta (prefijo `/api/v1`) | auth |
|---|---|---|
| POST | `/webhooks/:provider/:integrationId` | firma HMAC (sin Bearer) |
| GET/POST | `/integrations` | Bearer |
| DELETE | `/integrations/:id` | Bearer |
| POST | `/integrations/:id/rotate-secret` | Bearer |
| PUT | `/integrations/:id/credentials` | Bearer |
| GET/POST, PUT/DELETE | `/integrations/:id/rules`, `/integrations/:id/rules/:ruleId` | Bearer |
| GET | `/integrations/:id/health?refresh=true` | Bearer |
| POST | `/integrations/:id/register-webhook` | Bearer |
| POST, GET | `/integrations/:id/test`, `/integrations/:id/tests/:testId` | Bearer |
| GET | `/projects/:projectId/readiness` | Bearer |
| GET | `/repositories?project_id`, `/repositories/{org%2Frepo}/readiness` | Bearer |
| GET | `/tasks?project_id&status_category`, `/tasks/:taskKey` | Bearer |
| GET/POST, GET | `/tasks/:taskKey/actions`, `/tasks/:taskKey/transitions` | Bearer |
| GET | `/branches?project_id&repository` | Bearer |
| GET | `/pull-requests?project_id&repository&state` (totales en `meta`) | Bearer |

`GET /tasks` agrega por tarea: ramas, sesiones, commits, PRs, tokens (`estimated`: atribución por
enlace sesión ↔ tarea; `simulated` si viene del mock), líneas aceptadas/efectivas y `deployed`.
Tareas vistas en ramas pero sin webhook de Jira aparecen como `status: "untracked"`.

## 9. Configuración

| variable | uso |
|---|---|
| `PUBLIC_API_URL` | base de `webhook_url` (si falta, origen de la petición) |
| `JIRA_STORY_POINTS_FIELD` | campo de story points (default `customfield_10016`) |
| `DASHBOARD_URL` | `{{dashboard_url}}` = `<DASHBOARD_URL>/tasks/<clave>` |
| `APP_ENV` | prefijo del secreto `magicode/<APP_ENV>/integrations/<id>` |

IAM: API → `secretsmanager:CreateSecret/PutSecretValue/GetSecretValue/TagResource` sobre
`magicode/<env>/integrations/*`; task-sync → `GetSecretValue`. El CORS del HTTP API debe permitir
`PUT` y `DELETE` para credenciales, reglas y baja de integraciones.

## 10. Limitaciones

- GitHub manda hasta 2048 commits por push; se proyectan los primeros 200. Bitbucket no informa
  archivos por commit (conteos en 0) y su `merge_commit` usa SHA corto (se compara por prefijo).
- El cruce PR ↔ líneas IA usa rama origen + head + merge commit, no los ancestros reales ⇒ `estimated`.
- Un despliegue enlaza las tareas del SHA desplegado y de los PR con ese merge, no de todos los
  ancestros.
- Tokens por tarea: si una sesión toca varias tareas, las peticiones sin `task_key` se atribuyen a
  todas las tareas enlazadas a la sesión.
- Linear: sin registro automático del webhook ni ping; write-back sin etiquetas.
- El registro del webhook en Jira exige administrador; la verificación de entregas por API solo existe
  en GitHub (`provider_last_response`).
