# API de MagiCode — rutas

**Base (dev, desplegada):** `https://a5fo4490y4.execute-api.us-east-1.amazonaws.com/api/v1`
**MagiHub simulado (mock):** `https://hn1x6jivok.execute-api.us-east-1.amazonaws.com`
**Dashboard:** `https://d3p2li8klypbhy.cloudfront.net`

- **Modo demo sin login (dev):** sin header `Authorization` la API actúa con la key de demo
  (`x-magicode-demo: true` en la respuesta). En otros entornos: `Authorization: Bearer <MagiHub API key>`.
- **Respuesta:** `{ "data": …, "meta"?: … }`. Error: `{ "statusCode", "message", "code"? }`.
- **Filtros comunes (GET):** `project_id`, `repository`, `session_id`, `task_key`, `branch`, `from`, `to` (ISO).

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
| GET | `/productivity/projects` | Proyectos y repositorios |
| GET | `/productivity/sessions` | Sesiones |
| GET | `/productivity/sessions/:sessionId` | Sesión + sus cambios |
| GET | `/productivity/changes` | Cambios con aristas y puntuaciones |
| GET | `/productivity/commits` | Commits con automatización IA |

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
| GET | `/branches` | Ramas y sus tareas |
| GET | `/pull-requests` | PRs (`meta`: abiertos/fusionados/cerrados) |

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

## MagiHub simulado (mock)

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI-compatible, `model: "smart-auto"` |
| GET | `/v1/keys/self` | Identidad de la key (`mh_demo_*` válidas) |
| GET | `/v1/usage` | Consumo por key (`from`, `to`, `granularity`) |

Probar rápido:

```bash
API=https://a5fo4490y4.execute-api.us-east-1.amazonaws.com/api/v1
curl -s $API/health
curl -s "$API/productivity/summary?project_id=magicode-demo"
```

Contratos (tipos exactos): `packages/contracts/src/api.ts` y vecinos. Modelo de métricas: `docs/metrics-model.md`.
