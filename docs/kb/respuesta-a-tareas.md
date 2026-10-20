# Respuesta a tareas (write-back al gestor de tareas)

## Qué es

La **respuesta a tareas** es el camino de vuelta: MagiCode no solo lee Jira (por [webhooks](webhooks.md)), también puede **escribir** en la tarea — transicionarla de estado, comentar, actualizar campos (incluidas métricas MagiCode), añadir enlaces remotos a commits, PRs o despliegues y asignarla. Las acciones se lanzan a mano desde el dashboard o automáticamente con **reglas** disparadas por eventos del IDE y del repositorio.

## Cómo se calcula

Arquitectura (outbox transaccional):

```
Dashboard (manual) ─┐
                    ├─► OutboxAction (DynamoDB, status=pending) ─► Stream ─► task-sync Lambda ─► API Jira
Regla automática ───┘        ▲                                                     │
(pr.merged, deploy…)         └──────────── resultado / reintentos / auditoría ◄────┘
```

1. **Encolar**: la acción se guarda como `OutboxAction` con `status = pending` **antes** de llamar al proveedor; si Jira falla o no responde, la acción no se pierde.
2. **Disparar**: el stream de DynamoDB (filtro `entity = OutboxAction ∧ status = pending`) invoca la Lambda `task-sync`.
3. **Ejecutar**: `task-sync` lee las credenciales de Secrets Manager, llama a la API del proveedor y actualiza la fila: `sending` → `sent` (con `result`), `skipped` o `failed` (con `last_error` y `attempts`). Errores 429/5xx/red/timeout se reintentan con backoff exponencial (respetando `Retry-After`); los 4xx son permanentes. Tras una `transition` se actualiza también la fila `Task` local con el estado resultante (el webhook de vuelta se ignora).

Tipos de acción (`TaskActionKind`):

| `kind`          | qué hace                                                                    | campos                                                                 |
|-----------------|------------------------------------------------------------------------------|-------------------------------------------------------------------------|
| `transition`    | Mueve la tarea a otro estado, con comentario opcional.                       | `to_status` (nombre, p. ej. "En revisión") o `transition_id`; `comment` (≤ 4 000) |
| `comment`       | Agrega un comentario.                                                        | `body_markdown` (≤ 8 000)                                               |
| `update_fields` | Cambia campos (al menos uno).                                                | `story_points`, `labels_add`, `labels_remove`, `magicode_tokens`, `magicode_effective_lines`, `magicode_criticality` (`low`/`medium`/`high`/`critical`) |
| `remote_link`   | Añade un enlace remoto a la tarea.                                           | `url`, `title`, `relation` ∈ `commit`, `pull_request`, `deployment`, `dashboard` |
| `assign`        | Asigna o desasigna.                                                          | `assignee_account_id` (o `null` para desasignar)                        |

Estados del outbox (`OutboxStatus`): `pending` (encolada) → `sending` (en curso) → `sent` (aplicada) | `failed` (error tras reintentos; ver `last_error`) | `skipped` (no se ejecutó porque no aplicaba).

**Manual vs. reglas** (`OutboxAction.origin`):

- Manual: `POST /api/v1/tasks/{taskKey}/actions` con `TaskActionRequest {action, idempotency_key}` → `202` con la `OutboxAction`. `origin = {type: "manual", key_id}` (la huella de la key de quien la lanzó). Para elegir el estado destino, `GET /api/v1/tasks/{taskKey}/transitions` consulta en vivo las transiciones disponibles (`AvailableTransition {id, name, to_status, to_category}`).
- Regla: `AutomationRule {name, enabled, trigger, when, action}` por integración. `origin = {type: "rule", rule_id, trigger_ref}`. Se gestionan con `GET/POST /api/v1/integrations/{id}/rules` y `PUT/DELETE /api/v1/integrations/{id}/rules/{ruleId}`.

Disparadores (`RuleTrigger`):

| trigger              | cuándo                                                       |
|----------------------|--------------------------------------------------------------|
| `session.started`    | primera sesión MagiCode en la rama de la tarea               |
| `commit.linked`      | commit con líneas IA enlazado a la tarea                     |
| `pr.opened`          | PR abierto desde una rama de la tarea                        |
| `pr.merged`          | PR fusionado                                                 |
| `reference.marked`   | la tarea entra en la versión de referencia (demo)            |
| `deployment.success` | evidencia real de despliegue                                 |

Condiciones (`when`, todas opcionales): `environment` (p. ej. solo `production` en `deployment.success`), `target_branch` (p. ej. solo hacia `main` en `pr.merged`), `from_status_category` (`todo`/`in_progress`/`done`: solo si la tarea está en esa categoría).

**Plantillas** en los textos de la acción: `{{task_key}}`, `{{sha}}`, `{{pr_url}}`, `{{environment}}`, `{{tokens}}`, `{{effective_lines}}`, `{{criticality}}`, `{{dashboard_url}}`.

**Reglas por defecto** (`DEFAULT_RULES`, se crean al conectar Jira; desactivables):

| nombre                              | activa | trigger              | when                                  | acción |
|-------------------------------------|--------|----------------------|---------------------------------------|--------|
| Enlazar commits con líneas IA       | sí     | `commit.linked`      | –                                     | `remote_link` "Commit {{sha}} (MagiCode)", `relation = commit` |
| PR abierto → En revisión            | no     | `pr.opened`          | `from_status_category = in_progress`  | `transition` a "En revisión" + comentario "PR abierto: {{pr_url}}" |
| Despliegue en producción → Hecho    | no     | `deployment.success` | `environment = production`            | `transition` a "Hecho" + comentario "Desplegado {{sha}} en {{environment}}. Tokens MagiHub: {{tokens}} · líneas efectivas: {{effective_lines}}." |

**Idempotencia**: cada acción lleva `idempotency_key`; la fila `ActionIdem` (`T#{t}#IDEM#{idempotency_key}`, TTL 7 días) impide encolarla dos veces. En acciones manuales la clave la genera el dashboard (doble clic, reintento del navegador). En reglas es `{rule_id}:{trigger_ref}`, con `trigger_ref = {task_key}|{tipo}:{repo}:{id}` (`pr:org/repo:12`, `deploy:org/repo:987`, `ref:org/repo:v1.0`, `commit:org/repo:<sha>`): el mismo hecho nunca encola dos veces la misma regla para la misma tarea.

**Anti-bucle**: los cambios que hace MagiCode vuelven como webhook de Jira. Se ignoran si el actor es la cuenta de servicio de la integración o si el `action_id` coincide con la propiedad de entidad `magicode.last_action` del issue.

**Auditoría**: `GET /api/v1/tasks/{taskKey}/actions` devuelve todas las `OutboxAction` de la tarea (manuales y de reglas) con origen, estado, intentos, último error y resultado resumido del proveedor. Se guardan bajo la PK de la tarea (`T#{t}#TASK#{key}`, SK `ACT#{created_at}#{action_id}`), así que se leen junto con el resto de la tarea.

**Credenciales**: `PUT /api/v1/integrations/{id}/credentials` con `TaskProviderCredentials` (Jira: `site_url`, `email`, `api_token` y, opcionalmente, `field_ids` de los campos personalizados de métricas) → `204`. Se guardan en Secrets Manager (`magicode/<env>/integrations/<integration_id>`), nunca en DynamoDB ni en respuestas.

## Fuente y procedencia

- Las acciones no producen métricas del embudo: son operaciones auditadas. Su resultado (`result`, estado resultante) viene del proveedor y es `real`.
- Los valores que se escriben en Jira (`{{tokens}}`, `{{effective_lines}}`, `magicode_criticality`) heredan la procedencia de su métrica de origen ([tokens](tokens.md), [líneas efectivas](lineas-efectivas.md), [criticidad](criticidad.md)). En Jira la etiqueta de procedencia se pierde: conviene que el texto lo diga (p. ej. "líneas efectivas (estimadas)").

## Cómo interpretarlo

- `failed` con `last_error` de permisos (401/403): la cuenta de servicio no tiene el permiso de Jira necesario (tabla abajo) o el token expiró.
- `failed` en una `transition`: el estado destino no está disponible desde el estado actual del flujo de Jira. Usar `GET …/transitions` para ver las opciones reales.
- `skipped`: la acción no aplicaba en el momento de ejecutarse; no es un error.
- Muchas acciones `pending` antiguas: el stream o la Lambda `task-sync` no están procesando.

Permisos de Jira necesarios para la cuenta de servicio (permisos de proyecto de Jira Cloud):

| acción                      | permiso                                   |
|-----------------------------|-------------------------------------------|
| leer tarea y transiciones   | Browse Projects                           |
| `transition`                | Transition Issues                         |
| `comment` (y comentario de transición) | Add Comments                   |
| `update_fields`, propiedad `magicode.last_action` | Edit Issues (los campos deben estar en la pantalla de edición del tipo de issue) |
| `remote_link`               | Link Issues                               |
| `assign`                    | Assign Issues (el destinatario necesita Assignable User) |
| registrar el webhook        | Administer Jira (permiso global; solo para configurar, no para la cuenta de servicio) |

Recomendación: usar una **cuenta de servicio dedicada** (no la de una persona): así el anti-bucle por actor es fiable y la auditoría de Jira muestra claramente qué hizo MagiCode.

## Ejemplo

Tarea `MAG-123` en estado "In Progress" (`status_category = in_progress`), rama `feature/MAG-123-descuentos`, sesión `demo-001` (ver [ejemplo completo](ejemplo-demo-001.md)). El equipo activó la regla "PR abierto → En revisión".

1. GitHub envía `pull_request` `opened` del **PR #14** (`feature/MAG-123-descuentos` → `main`, `url = https://github.com/org/repo-demo/pull/14`). El trigger `pr.opened` se enlaza a `MAG-123` por la rama y el título.
2. Se evalúa `when.from_status_category = in_progress`: se cumple.
3. Se renderiza la plantilla y se encola:

```json
{
  "action_id": "act-01",
  "task_key": "MAG-123",
  "provider": "jira",
  "action": {
    "kind": "transition",
    "to_status": "En revisión",
    "comment": "PR abierto: https://github.com/org/repo-demo/pull/14"
  },
  "origin": { "type": "rule", "rule_id": "rule-pr-opened", "trigger_ref": "MAG-123|pr:org/repo-demo:14" },
  "idempotency_key": "rule-pr-opened:MAG-123|pr:org/repo-demo:14",
  "status": "pending",
  "attempts": 0,
  "last_error": null,
  "result": null
}
```

4. `task-sync` ejecuta la transición y el comentario en Jira (el comentario se convierte a ADF), marca la propiedad `magicode.last_action = act-01`, deja `status = sent`, `attempts = 1`, y actualiza la tarea local a "En revisión".
5. Jira envía `jira:issue_updated` (estado "En revisión"). El actor es la cuenta de servicio: no dispara nada nuevo.
6. Si el PR se edita o GitHub reentrega el webhook, `rule-pr-opened:MAG-123|pr:org/repo-demo:14` ya existe en `ActionIdem`: no se encola de nuevo.

Acción manual equivalente desde el dashboard (comentario con métricas de la tarea):

```json
POST /api/v1/tasks/MAG-123/actions
{
  "action": { "kind": "comment", "body_markdown": "Sesión demo-001: 9 520 tokens MagiHub, 30.64 líneas efectivas (estimadas)." },
  "idempotency_key": "ui-7c2f9a10"
}
```

## Errores comunes / límites

- `to_status` por nombre depende del idioma y del flujo configurado en Jira ("En revisión" ≠ "In Review"). Con flujos personalizados, preferir `transition_id`.
- Jira Cloud (API v3) espera los comentarios en Atlassian Document Format. `body_markdown` se convierte con un subconjunto: párrafos, saltos de línea, **negrita**, `código`, enlaces `[texto](https://…)`, URLs sueltas, listas con viñetas y bloques de código. Encabezados, tablas, cursiva o listas numeradas llegan como texto plano.
- La regla por defecto "Enlazar commits con líneas IA" está **activa** y trae una URL de ejemplo (`https://example.invalid/{{sha}}`): sin editarla, cada commit con líneas IA añadiría a Jira un enlace roto y la lista de plantillas del contrato no incluye una URL de commit. La implementación propone `{{commit_url}}` y `{{repository}}` (aún no en el contrato); hasta entonces, editar la regla con la URL real (p. ej. `https://github.com/org/repo-demo/commit/{{sha}}`).
- `magicode_tokens`, `magicode_effective_lines` y `magicode_criticality` solo se escriben si la integración define sus `field_ids` (campos personalizados creados en Jira).
- Como el webhook de vuelta se ignora, el estado local de la tarea depende de que `task-sync` lo actualice tras la transición; si esa actualización falla, `TaskListItem.status` queda desactualizado hasta el siguiente cambio en Jira hecho por otra persona.
- Linear está en el contrato (`api_key`), pero el flujo probado es Jira.

## Implementación

- Contrato: `packages/contracts/src/writeback.ts` (`TaskAction`, `TaskActionRequest`, `OutboxStatus`, `OutboxAction`, `RuleTrigger`, `AutomationRule`, `DEFAULT_RULES`, `TaskProviderCredentials`, `AvailableTransition`).
- Rutas: `packages/contracts/src/api.ts` (`taskActions`, `taskTransitions`, `integrationCredentials`, `integrationRules`, `integrationRule`).
- Tabla: `packages/contracts/src/keys.ts` (`OutboxAction`, `ActionIdem`, `AutomationRule`).
- Lambda `task-sync`: `apps/api/src/modules/task-sync/` (`task-sync.types.ts` con `RuleContext`/`TriggerInput`/`ExecuteResult`, `jira.client.ts`, `adf.ts` Markdown → ADF, `provider-http.ts` reintentos). Encolado de reglas y endpoints `/tasks/:taskKey/actions`: en curso en el mismo módulo; infraestructura en `infra/lib/magicode-stack.ts`.
