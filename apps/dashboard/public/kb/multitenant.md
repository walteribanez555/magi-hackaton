# Multitenant y jerarquía de entidades

## Qué es

Todo dato de MagiCode pertenece a un **tenant** (la organización en MagiHub) y se enlaza en una jerarquía que permite ver la productividad a cualquier nivel: tenant → proyecto → tarea → rama → sesión → cambio → commit → PR → despliegue.

```
Tenant ─┬─ Project ─┬─ Repository (GitHub/Bitbucket, vía webhook)
        │           ├─ Task (Jira, vía webhook)  ← clave "MAG-123"
        │           └─ Session (IDE) ── Change ── Commit ── Reference / Deployment
        └─ Integration (una por proveedor + proyecto; secreto HMAC propio)

Branch     = rama del repo; se enlaza a Task(s) por la clave en su nombre y a Sessions por el `branch` del evento.
Commit     = se enlaza a Task(s) por la clave en el mensaje y por la rama.
PR         = rama origen → base; tareas por título y rama.
Deployment = evidencia REAL de despliegue (GitHub deployment_status) → etapa "deployed".
```

## Cómo se calcula

Cómo se determina cada eslabón:

| nivel         | identificador                     | cómo se obtiene / enlaza                                                                 |
|---------------|-----------------------------------|------------------------------------------------------------------------------------------|
| Tenant        | `tenant_id`                       | Se **deriva** de la API key (`GET /v1/keys/self` en MagiHub). El cuerpo del evento nunca trae `tenant_id`; si lo trae, se ignora. |
| Key           | `key_id`                          | Id de la key en MagiHub; el backend guarda solo `key_id` y una huella `sha256[:12]`, nunca la key. |
| Project       | `project_id`                      | Lo envía la extensión en cada evento (`magicode-demo`).                                  |
| Repository    | `repository`                      | `org/repo` o ruta lógica del repo local; en webhooks, el nombre completo del proveedor.  |
| Task          | `task_key`                        | Explícita en el evento o inferida con `extractTaskKeys` de la rama, el mensaje del commit, el trailer `MagiCode-Task:` o el título del PR. Formato `^[A-Z][A-Z0-9]{1,9}-\d{1,7}$`. |
| Branch        | `branch`                          | Rama activa al emitir el evento; en webhooks, la rama del push o del PR.                 |
| Session       | `session_id`                      | Generado por la extensión al abrir sesión (`session.started`).                           |
| Change        | `change_id`                       | Uno por propuesta de la IA (`code.proposed` → `code.accepted`/`code.rejected`).           |
| Commit        | `sha`                             | `git.committed` desde el IDE (con `change_ids`) o `repo.push` por webhook. El trailer `MagiCode-Session: <session_id>` enlaza el commit remoto con la sesión. |
| PR            | `repository` + `number`           | Webhook `repo.pull_request`; se enlaza por `source_branch` y `title_task_keys`.          |
| Deployment    | `deployment_id` + `sha`           | Webhook `repo.deployment` (GitHub `deployment_status`) o `reference.marked{kind=deployment}`. |
| Integration   | `integration_id`                  | Creada con `POST /integrations`; la URL del webhook lleva el id y de ahí sale el tenant. |

Almacenamiento: tabla única DynamoDB con claves que empiezan siempre por `T#{tenant}`, de modo que una consulta nunca cruza tenants. Ejemplos: sesión `T#{t}#S#{session}` / `META`; tarea `T#{t}#TASK#{key}` / `META`; enlaces de tarea `T#{t}#TASK#{key}` / `L#{kind}#{id}` con `kind ∈ branch | session | commit | pr | deployment`, que permiten reconstruir todo lo de una tarea con una sola consulta.

Filtros del resumen (`ProductivitySummary.scope`): `tenant_id` y `key_id` siempre; opcionales `project_id`, `repository`, `session_id`, `task_key`, `branch`, y la ventana `from`–`to`.

## Fuente y procedencia

- `tenant_id` y `key_id`: `real`, validados contra MagiHub en cada petición autenticada.
- Enlaces por clave de tarea en ramas, mensajes y títulos: deterministas pero heurísticos (dependen de la convención de nombres). Un enlace ausente no se inventa.
- Entidades que llegan por webhook: `real` (vienen firmadas por el proveedor).

## Cómo interpretarlo

- Una vista **sin filtros** es "toda la key": los tokens salen directos de la API de consumo (`real`). Una vista **filtrada** (por proyecto, tarea, rama o sesión) necesita repartir el consumo si MagiHub no da granularidad por petición: sus tokens pueden ser `estimated` (ver [tokens](tokens.md)).
- Si una tarea muestra 0 sesiones pero tiene commits, la rama o los commits mencionan la clave pero la extensión no la detectó (rama sin clave o sesión iniciada en otra rama).
- Usar una API key por equipo o por proyecto simplifica la atribución.

## Ejemplo

```
tenant  acme                (derivado de la key; key_id k_7f3a9c, huella 1c9e0b7a4d2f)
└ project  magicode-demo    repository org/repo-demo
  └ task  MAG-123 "Descuentos por volumen en el carrito" (Story, 5 puntos)
    └ branch  feature/MAG-123-descuentos   (clave extraída del nombre)
      └ session  demo-001   2026-10-20 14:00–15:10 UTC
        ├ change  chg-1 (aceptado)  chg-2 (rechazado)  chg-3 (rechazado)  chg-4 (aceptado)
        └ commit  3f9c2e1  "MAG-123 …" + trailer MagiCode-Session: demo-001
          └ PR  #14  feature/MAG-123-descuentos → main  (merged, merge_sha 9d8e7f6)
            └ reference  demo-v0.1 @ 9d8e7f6  (kind demo-reference; sin despliegue)
```

Consulta `GET /api/v1/tasks/MAG-123`: lee `T#acme#TASK#MAG-123` y sus enlaces `L#branch#feature/MAG-123-descuentos`, `L#session#demo-001`, `L#commit#3f9c2e1…` y `L#pr#org/repo-demo:14` (los enlaces de PR y despliegue usan `{repository}:{number}` y `{repository}:{deployment_id}`).

## Errores comunes / límites

- Enviar `tenant_id` desde el editor no tiene efecto: el backend no confía en él.
- Si dos tenants usan el mismo nombre de repositorio, no colisionan: la clave incluye el tenant.
- Una sesión pertenece a una sola rama (la del `session.started`); si el desarrollador cambia de rama sin cerrar sesión, los eventos siguientes llevan su propio `branch`, pero la sesión conserva la inicial en `SessionListItem.branch`.
- `extractTaskKeys` convierte el texto a mayúsculas: `feature/mag-123-login` produce `MAG-123`. `extractTaskKeys` acepta cualquier patrón `AA-1`: `UTF-8`, `SHA-256` o `ISO-8601` en un mensaje de commit casan con la expresión regular. Al proyectar webhooks se filtran: si el proyecto tiene una integración Jira/Linear, solo se aceptan claves con sus prefijos (`task_project_keys`, p. ej. `MAG`); si no, se descartan prefijos de ruido conocidos (`UTF`, `SHA`, `ISO`, `RFC`, `HTTP`, `CVE`…). Los eventos `task.*` de prefijos ajenos a la integración se rechazan (`202`, fuera de alcance).
- GitLab y Linear están en el contrato, pero el reto solo exige un proveedor Git; el flujo probado es GitHub/Bitbucket + Jira.

## Implementación

- Contrato de jerarquía y claves de tarea: `packages/contracts/src/integrations.ts` (`TASK_KEY_RE`, `extractTaskKeys`, `TaskListItem`, `BranchListItem`).
- Diseño de tabla: `packages/contracts/src/keys.ts` (`ENTITY`, `keys`).
- Autenticación y derivación de tenant: `apps/api/src/common/middlewares/auth.middleware.ts`, `apps/api/src/modules/magihub/magihub.client.ts`.
- Rutas: `packages/contracts/src/api.ts` (`ROUTES`).
