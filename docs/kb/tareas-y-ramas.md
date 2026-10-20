# Tareas y ramas

## Qué es

Una **tarea** es el trabajo de negocio en el gestor (Jira, clave `MAG-123`); una **rama** es donde se programa (`feature/MAG-123-descuentos`). MagiCode enlaza ambas con sesiones, commits, PR y despliegues para responder "¿cuántos tokens y cuánto código IA costó esta tarea?". En sentido inverso, puede escribir en la tarea (transiciones, comentarios, métricas): ver [respuesta a tareas](respuesta-a-tareas.md).

## Cómo se calcula

**Enlace por clave.** La clave de tarea (`^[A-Z][A-Z0-9]{1,9}-\d{1,7}$`) se extrae con `extractTaskKeys` (insensible a mayúsculas) de:

- el nombre de la rama (`feature/mag-123-descuentos` → `MAG-123`),
- el `task_key` explícito de los eventos del IDE o el inferido de su `branch`,
- el mensaje del commit y el trailer `MagiCode-Task:`,
- el título y la rama origen del PR,
- el `ref` de un despliegue y los PR cuyo `merge_sha`/`head_sha` coincide con el SHA desplegado.

Cada enlace se guarda como `TaskLink` (`kind ∈ branch | session | commit | pr | deployment`) bajo la PK de la tarea. Si el proyecto tiene integración Jira, solo cuentan las claves con sus prefijos (`task_project_keys`).

**`TaskListItem`** (`GET /api/v1/tasks?project_id&status_category`):

| campo             | definición                                                                                         |
|-------------------|-----------------------------------------------------------------------------------------------------|
| `task_key`, `title`, `status`, `status_category`, `assignee`, `story_points`, `url` | del webhook de Jira (`task.upserted`). Sin webhook: `title = task_key`, `status = "untracked"`, `status_category = "todo"`. |
| `branches`        | ramas enlazadas.                                                                                    |
| `sessions`        | nº de sesiones enlazadas.                                                                           |
| `commits`         | nº de commits enlazados (únicos por SHA).                                                           |
| `pull_requests[]` | `{number, state, url}` de los PR enlazados.                                                         |
| `tokens`          | Consumo de la API de MagiHub imputado a las peticiones de las sesiones enlazadas que son de esta tarea o no tienen tarea, con la **misma regla** que el resumen (ver regla de imputación abajo). `{value, provenance}`; `value = null` si no hay sesiones. |
| `accepted_lines`  | Σ líneas **no triviales** aceptadas (`importance.lines − by_kind.trivial`, unidad del [embudo](embudo.md)) de esas sesiones (misma regla de pertenencia). |
| `effective_lines` | Σ `effective_lines` de esos cambios, redondeado a 2 decimales.                                      |
| `deployed`        | `true` si algún commit enlazado tiene un Deployment `success` **a producción** (`DEPLOY_PRODUCTION_ENVIRONMENTS`, por defecto `production,prod`) de su SHA o del `merge_sha`/`head_sha` de un PR cuya rama origen (`Commit.branch`/`remote_branch`) contiene el commit. Misma regla que la etapa `deployed` del embudo. |
| `updated_at`      | última actualización de la tarea en Jira (o del último enlace).                                     |

Las tareas que aparecen en ramas pero aún no llegaron por webhook también se listan ("untracked").

**Regla de imputación de tokens** (`allocateTaskTokens` → `allocateUsage`, la misma del resumen): por cada key de las peticiones de la tarea se leen los snapshots ya guardados de la API de consumo (`UsageSnapshot`, sin llamar a MagiHub) entre el día de la primera petición y el fin del día de la última. Con granularidad `request` se suman los registros de sus `request_id` (`real`); con `hour`/`day` cada ventana se prorratea por `usage reportado de la tarea / usage reportado de la key` (`estimated`); sin snapshots se usa Σ `usage` reportado (`estimated`). Con el mock, `simulated`. Diferencias de alcance con `GET /productivity/summary?task_key=…`: la tarea suma **todas las keys** del tenant y todo el historial; el resumen, solo la key del caller y la ventana `[from, to]`. El resumen por tarea aplica la misma pertenencia (peticiones y cambios de la tarea o sin tarea; commits con esa clave o sin claves).

**Detalle** (`GET /api/v1/tasks/:taskKey`, schema `TaskDetail` en contracts): `TaskListItem` + `criticality` + `linked.{sessions, commits, branches, pull_requests, deployments}`. `linked.deployments` lista todos los entornos; `deployed` en cada fila es `true` solo para `success` a producción (un `success` en `staging` aparece con `deployed = false`). En `linked.commits`, `ai_matched_lines = null` si el commit es "solo remoto" (el push llegó y el IDE nunca lo reportó).

**`BranchListItem`** (`GET /api/v1/branches?project_id&repository`): `repository`, `branch`, `task_keys`, `sessions` (nº), `commits` (nº), `head_sha`, `merged_into` (rama destino cuando su PR se fusionó), `last_activity_at`.

**Resumen por tarea o rama**: `GET /api/v1/productivity/summary?task_key=MAG-123` o `?branch=…` devuelve el `ProductivitySummary` completo (embudo, aristas, tokens) filtrado. `counts.tasks` cuenta las claves distintas de Task de Jira/Linear actualizadas en la ventana **más** las enlazadas a las sesiones, cambios y commits del alcance (incluye las "untracked", como `GET /tasks`); con filtro de repositorio, sesión o rama solo cuentan las enlazadas. `counts.tasks_done`: las que tienen Task en `done`.

**Claves de tarea desde el IDE**: `eventTaskKeys` aplica el mismo filtro que los webhooks (`filterTaskKeys`): si el proyecto tiene Jira/Linear configurado, solo sus prefijos (`task_project_keys`); si no, se descartan prefijos de ruido (`UTF`, `ISO`, `SHA`, `HTTP`, `RFC`, `TLS`…). Una rama `fix/utf-8` no crea la tarea `UTF-8`.

## Fuente y procedencia

- Datos de la tarea: Jira por webhook, `real`.
- `TaskListItem.tokens.provenance`: `real` si todo se imputó por `request_id`; `estimated` con prorrateo por ventana o sin snapshots; `simulated` con el mock. La pertenencia es por enlace sesión ↔ tarea.
- `accepted_lines`: telemetría del IDE; `effective_lines`: `estimated`.

## Cómo interpretarlo

- `tokens / story_points`: costo IA por punto de historia. Útil como tendencia del equipo, no para comparar equipos con escalas de puntos distintas.
- `effective_lines / accepted_lines` bajo en una tarea: mucho boilerplate o duplicación en esa tarea.
- `sessions = 0` con `commits > 0`: se trabajó sin MagiCode o la rama no lleva la clave.
- `deployed = true` con `status_category ≠ done`: el código está en producción pero la tarea no se cerró. Es el caso que resuelve la regla "Despliegue en producción → Hecho" de [respuesta a tareas](respuesta-a-tareas.md).
- `status = "untracked"`: la clave aparece en ramas/commits, pero Jira no envió la tarea (falta integración o el prefijo no está configurado).

## Ejemplo

Tarea `MAG-123` "Descuentos por volumen en el carrito" (Story, 5 puntos) al final del ejemplo (ver [ejemplo completo](ejemplo-demo-001.md)):

```json
{
  "task_key": "MAG-123",
  "project_id": "magicode-demo",
  "title": "Descuentos por volumen en el carrito",
  "status": "Done",
  "status_category": "done",
  "story_points": 5,
  "branches": ["feature/MAG-123-descuentos"],
  "sessions": 1,
  "commits": 3,
  "pull_requests": [{ "number": 14, "state": "merged", "url": "https://github.com/org/repo-demo/pull/14" }],
  "tokens": { "value": 9520, "provenance": "estimated" },
  "accepted_lines": 48,
  "effective_lines": 30.64,
  "deployed": false
}
```

- `commits = 3`: `3f9c2e1` y `5a6b7c8` se enlazan por la clave de la rama del push (aunque el mensaje no la mencione); el merge commit `9d8e7f6`, por el mensaje por defecto de GitHub "Merge pull request #14 from org/feature/MAG-123-descuentos", que contiene la rama y por tanto la clave.
- `tokens = 9 520 estimated`: la key tiene consumo por hora; la única ventana (14:00–15:00, 9 520) se prorratea por el usage reportado de la tarea (9 400) sobre el de la key (9 400). Sin snapshots guardados de la key saldría el respaldo `9 400 estimated` (Σ por petición).
- `accepted_lines = 48`: `(42 − 10) + (22 − 6)` no triviales.
- `deployed = false`: no hay Deployment `success` a producción del commit ni del merge commit `9d8e7f6`.
- Costo por punto: `9 520 / 5 = 1 904` tokens por punto de historia.

Rama: `{repository: "org/repo-demo", branch: "feature/MAG-123-descuentos", task_keys: ["MAG-123"], sessions: 1, commits: 2, head_sha: "5a6b7c8…", merged_into: "main"}`.

## Errores comunes / límites

- Una rama sin clave (`fix-descuentos`) no se enlaza a ninguna tarea; las sesiones en ella cuentan en el proyecto, pero no en la tarea.
- Una sesión enlazada a dos tareas suma sus peticiones sin tarea explícita a ambas: los tokens de tareas no se pueden sumar para obtener el total del proyecto.
- `TaskListItem.tokens` y `ProductivitySummary.tokens.total?task_key` usan el mismo método, pero pueden diferir por alcance: la tarea suma todas las keys y todo el historial; el resumen, la key del caller y la ventana.
- `TaskListItem.deployed` exige un commit enlazado: un despliegue enlazado a la tarea solo por el nombre de la rama desplegada, sin commit de la tarea que case, no la marca desplegada (sí aparece en `linked.deployments`).
- Máximo 200 tareas por proyecto en el listado.

## Implementación

- Contrato: `packages/contracts/src/integrations.ts` (`TASK_KEY_RE`, `extractTaskKeys`, `TaskListItem`, `BranchListItem`), `packages/contracts/src/keys.ts` (`Task`, `TaskLink`, `Branch`).
- Enlaces desde webhooks: `apps/api/src/modules/webhooks/webhooks.projection.ts`; desde eventos del IDE: `apps/api/src/modules/productivity/productivity.projection.ts` (`eventTaskKeys`).
- Listado y detalle de tareas: `apps/api/src/modules/tasks/tasks.service.ts` (`aggregateTaskMetrics`, `allocateTaskTokens`, `deployedFor`, `buildTaskListItem`); regla de despliegue: `apps/api/src/common/utils/deployment-evidence.ts`; contrato `TaskDetail` en `packages/contracts/src/integrations.ts`.
- Ramas: `apps/api/src/modules/branches/branches.service.ts` (`toBranchListItem`).
