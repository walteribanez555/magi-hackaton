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
| `tokens`          | Σ `usage.total_tokens` (de las respuestas) de las peticiones de las sesiones enlazadas que son de esta tarea o no tienen tarea. `{value, provenance}`; `value = null` si no hay sesiones. |
| `accepted_lines`  | Σ `accepted_added_lines` de los cambios aceptados de esas sesiones (misma regla de pertenencia).    |
| `effective_lines` | Σ `effective_lines` de esos cambios, redondeado a 2 decimales.                                      |
| `deployed`        | `true` si algún despliegue enlazado tiene `state = success`.                                        |
| `updated_at`      | última actualización de la tarea en Jira (o del último enlace).                                     |

Las tareas que aparecen en ramas pero aún no llegaron por webhook también se listan ("untracked").

**`BranchListItem`** (`GET /api/v1/branches?project_id&repository`): `repository`, `branch`, `task_keys`, `sessions` (nº), `commits` (nº), `head_sha`, `merged_into` (rama destino cuando su PR se fusionó), `last_activity_at`.

**Resumen por tarea o rama**: `GET /api/v1/productivity/summary?task_key=MAG-123` o `?branch=…` devuelve el `ProductivitySummary` completo (embudo, aristas, tokens) filtrado; `counts.tasks` y `counts.tasks_done` cuentan las tareas del proyecto actualizadas en la ventana y las que están en `done`.

## Fuente y procedencia

- Datos de la tarea: Jira por webhook, `real`.
- `TaskListItem.tokens.provenance`: `estimated` (la atribución es por enlace sesión ↔ tarea, no por petición medida en MagiHub); `simulated` si alguna petición viene del mock.
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
  "tokens": { "value": 9400, "provenance": "estimated" },
  "accepted_lines": 64,
  "effective_lines": 30.64,
  "deployed": false
}
```

- `commits = 3`: `3f9c2e1` y `5a6b7c8` se enlazan por la clave de la rama del push (aunque el mensaje no la mencione); el merge commit `9d8e7f6`, por el mensaje por defecto de GitHub "Merge pull request #14 from org/feature/MAG-123-descuentos", que contiene la rama y por tanto la clave.
- `tokens = 9 400` (Σ por petición), no 9 520: el total de la API de consumo incluye 120 tokens no reconciliados que no se pueden atribuir a la tarea.
- Costo por punto: `9 400 / 5 = 1 880` tokens por punto de historia.

Rama: `{repository: "org/repo-demo", branch: "feature/MAG-123-descuentos", task_keys: ["MAG-123"], sessions: 1, commits: 2, head_sha: "5a6b7c8…", merged_into: "main"}`.

## Errores comunes / límites

- Una rama sin clave (`fix-descuentos`) no se enlaza a ninguna tarea; las sesiones en ella cuentan en el proyecto, pero no en la tarea.
- Una sesión enlazada a dos tareas suma sus peticiones sin tarea explícita a ambas: los tokens de tareas no se pueden sumar para obtener el total del proyecto.
- `TaskListItem.tokens` usa el `usage` de las respuestas, no la API de consumo de MagiHub; por eso no coincide con `ProductivitySummary.tokens.total` filtrado por la misma tarea.
- `TaskListItem.deployed` y la etapa `deployed` del embudo usan reglas distintas: la tarea se marca desplegada si el SHA desplegado es el merge commit de su PR; el embudo solo cuenta líneas si el SHA desplegado es el mismo commit de la sesión. Una tarea puede estar `deployed = true` con 0 líneas en la etapa `deployed`.
- Máximo 200 tareas por proyecto en el listado.

## Implementación

- Contrato: `packages/contracts/src/integrations.ts` (`TASK_KEY_RE`, `extractTaskKeys`, `TaskListItem`, `BranchListItem`), `packages/contracts/src/keys.ts` (`Task`, `TaskLink`, `Branch`).
- Enlaces desde webhooks: `apps/api/src/modules/webhooks/webhooks.projection.ts`; desde eventos del IDE: `apps/api/src/modules/productivity/productivity.projection.ts` (`eventTaskKeys`).
- Listado y detalle de tareas: `apps/api/src/modules/tasks/tasks.service.ts` (`aggregateTaskMetrics`, `buildTaskListItem`).
- Ramas: `apps/api/src/modules/branches/branches.service.ts` (`toBranchListItem`).
