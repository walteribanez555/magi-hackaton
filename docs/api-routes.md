# API de MagiCode — rutas

**Base (dev, desplegada):** `https://a5fo4490y4.execute-api.us-east-1.amazonaws.com/api/v1`
**MagiHub (adaptador Bedrock, Function URL 120 s):** output `MagiHubUrl` del stack (`https://<id>.lambda-url.us-east-1.on.aws`) — base URL única para API y extensión.
**MagiHub (HTTP API previo, tope 30 s):** `https://hn1x6jivok.execute-api.us-east-1.amazonaws.com`
**Dashboard:** `https://d3p2li8klypbhy.cloudfront.net`

- **Modo demo sin login (dev):** sin header `Authorization` la API actúa con la key de demo
  (`x-magicode-demo: true` en la respuesta). En otros entornos: `Authorization: Bearer <MagiHub API key>`.
- **Respuesta:** `{ "data": …, "meta"?: … }`. Error: `{ "statusCode", "message", "code"? }`.
- **Filtros comunes (GET):** `project_id`, `repository`, `session_id`, `task_key`, `branch`, `from`, `to` (ISO).
- **Filtros por repositorio / developer / autor de PR** (summary, timeline, sessions, changes, commits,
  tasks, branches, pull-requests; se combinan con AND entre sí y con los anteriores):
  - `repository` — repositorio exacto (`org/repo`).
  - `developer` — `git config user.email` del IDE (sin distinguir mayúsculas). Sesiones de ese developer
    ⇒ todo lo derivado de ellas (peticiones, cambios, commits, imputación de tokens). En tasks/branches/PR:
    los que tienen sesiones del developer (PR: su rama origen).
  - `pr_author` — login del autor del PR en GitHub/Bitbucket/GitLab (sin distinguir mayúsculas). PRs de ese
    autor ⇒ sus ramas origen ⇒ sesiones y commits en esas ramas (o su head/merge) y sus tareas. `/pull-requests`
    filtra directamente por `author_login`.
  - Opciones para los desplegables: `GET /productivity/filters`.

## Salud e identidad

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/health` | Estado del servicio (sin auth) |
| GET | `/whoami` | Tenant y key (id + huella, nunca la key) |

## Productividad

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/productivity/events` | Ingesta de eventos del IDE (1 o `{events:[…]}` hasta 25) → 202 |
| GET | `/productivity/summary` | Embudo, tokens, aristas, conteos, avisos (`?refresh=true` fuerza sync de uso) |
| GET | `/productivity/timeline` | Serie por `bucket=hour\|day` |
| GET | `/productivity/projects` | Proyectos y repositorios (filas Project ∪ sesiones IDE recientes de la key ∪ integraciones) |
| GET | `/productivity/filters` | `?project_id` → `FilterOptions`: `repositories[]` (sesiones + integraciones + PRs), `developers[]` (`id` = email, `name`, `sessions`), `pr_authors[]` (`login`, `pull_requests`), ordenados |
| GET | `/productivity/sessions` | Sesiones |
| GET | `/productivity/sessions/:sessionId` | Sesión + sus cambios |
| GET | `/productivity/changes` | Cambios con aristas y puntuaciones |
| GET | `/productivity/commits` | Commits con automatización IA, `developer`, `verified_remote`, `remote_branch`, `remote_pushed_at`, `remote_only`. Conocidos solo por el push: `session_id: null` y `automation.*: null` (desconocido, no 0 %) |

## Consumo MagiHub

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/usage` | Consumo por key + ventana (`granularity=request\|hour\|day`) |
| POST | `/usage/sync` | Fuerza lectura a MagiHub y guarda snapshot |

## Tareas, ramas, PR

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/tasks` | Tareas (Jira) con tokens, líneas, PRs, despliegue |
| GET | `/tasks/:taskKey` | Detalle + trazabilidad |
| GET | `/tasks/:taskKey/transitions` | Transiciones disponibles en Jira (en vivo) |
| GET | `/tasks/:taskKey/actions` | Auditoría de acciones enviadas a Jira |
| POST | `/tasks/:taskKey/actions` | Encolar acción (transición, comentario, campos, enlace, asignar) → 202 |
| GET | `/branches` | Ramas y sus tareas (con `project_id`: sin ramas/commits ingeridos bajo la integración de otro proyecto) |
| GET | `/pull-requests` | PRs con `author_login` (`meta`: abiertos/fusionados/cerrados, tras `repository`/`developer`/`pr_author` y antes de `state`) |

## Integraciones (repositorio y tareas: ambos obligatorios)

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/integrations` | Lista (sin secretos) |
| POST | `/integrations` | Crear (GitHub/Bitbucket/GitLab o Jira/Linear) → URL de webhook + secreto **una vez** |
| DELETE | `/integrations/:id` | Desactivar |
| POST | `/integrations/:id/rotate-secret` | Nuevo secreto |
| PUT | `/integrations/:id/credentials` | Credenciales del proveedor (Secrets Manager) → 204 |
| POST | `/integrations/:id/register-webhook` | Crea/actualiza el webhook en el proveedor |
| GET | `/integrations/:id/health` | Comprobaciones (`?refresh=true` consulta al proveedor) |
| POST | `/integrations/:id/test` | Prueba de ida y vuelta (`mode: auto\|manual`) → 202 |
| GET | `/integrations/:id/tests/:testId` | Estado de la prueba |
| GET / POST | `/integrations/:id/rules` | Reglas automáticas hacia Jira |
| PUT / DELETE | `/integrations/:id/rules/:ruleId` | Editar / borrar regla |
| GET | `/projects/:projectId/readiness` | ¿Proyecto listo? (todos sus repos) |
| GET | `/repositories` | Lista para el desplegable |
| GET | `/repositories/:repository/readiness` | Conjunto de claves del repo (`org%2Frepo`) |

## Webhooks (sin Bearer; firma HMAC por integración)

| Método | Ruta | Proveedor |
|---|---|---|
| POST | `/webhooks/github/:integrationId` | `X-Hub-Signature-256` |
| POST | `/webhooks/bitbucket/:integrationId` | `X-Hub-Signature` |
| POST | `/webhooks/gitlab/:integrationId` | `X-Gitlab-Token` |
| POST | `/webhooks/jira/:integrationId` | `X-Hub-Signature` |
| POST | `/webhooks/linear/:integrationId` | `Linear-Signature` |

## MagiHub (adaptador `services/magihub-mock`)

Base URL = output `MagiHubUrl` (Lambda Function URL, timeout 120 s; el HTTP API corta a 30 s).
`MAGIHUB_PROVIDER=bedrock` (default en el stack, `-c magihubProvider=bedrock|mock`) hace
inferencia **real** con Amazon Bedrock; `mock` es el simulador determinista. Auth en ambos:
`Authorization: Bearer mh_demo_*`.

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI-compatible, `model: "smart-auto"`. Bedrock: Smart Auto elige modelo rápido (prompt < 1500 chars sin señales de refactor/arquitectura/varios archivos) o fuerte; `id` = `x-request-id` = `req_<requestId Bedrock>`, `model` = modelo enrutado, `usage` = tokens de Bedrock (+`cached_tokens`), header `x-magihub-provider: bedrock` |
| GET | `/v1/keys/self` | Identidad de la key (`mh_demo_*` válidas) |
| GET | `/v1/usage` | Consumo por key (`from`, `to`, `granularity`). Bedrock: `simulated: false`, tokens reales y `cost_usd` según tabla de precios (omitido si el modelo no tiene precio) |

La API (`MAGIHUB_MODE=bedrock`) etiqueta esos tokens como reales con origen `bedrock`.
Detalle de routing, precios y variables: `services/magihub-mock/README.md`.

```bash
MH=<MagiHubUrl>
curl -si $MH/v1/chat/completions -H 'Authorization: Bearer mh_demo_walter' -H 'content-type: application/json' \
  -d '{"model":"smart-auto","messages":[{"role":"user","content":"Función TS isPalindrome con test Vitest"}]}'
curl -s "$MH/v1/usage?from=$(date -u -v-1H +%FT%TZ)&granularity=request" -H 'Authorization: Bearer mh_demo_walter'
```

Probar rápido:

```bash
API=https://a5fo4490y4.execute-api.us-east-1.amazonaws.com/api/v1
curl -s $API/health
curl -s "$API/productivity/summary?project_id=magicode-demo"
```

Contratos (tipos exactos): `packages/contracts/src/api.ts` y vecinos. Modelo de métricas: `docs/metrics-model.md`.
