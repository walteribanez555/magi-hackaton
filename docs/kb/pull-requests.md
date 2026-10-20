# Pull requests

## Qué es

Los **pull requests** (PR) son la etapa de revisión e integración entre el commit y la versión de referencia. MagiCode los conoce por [webhooks](webhooks.md) del repositorio (GitHub `pull_request`, Bitbucket `pullrequest:*`) y los cruza con los commits para saber cuánto del PR vino de la IA.

## Cómo se calcula

**Total de PR y estados.** Hay dos lugares con conteos de PR, con alcances distintos:

| dónde                                          | qué cuenta                                                                                         |
|------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| `ProductivitySummary.counts.pull_requests`     | PR del proyecto con **actividad** en la ventana `from`–`to` (último evento recibido en la ventana). Con `?repository` solo ese repo; con `?task_key` solo los PR enlazados a la tarea (`PR.task_keys`, por título/rama); con `?branch` solo los que salen de esa rama (`source_branch`). |
| `ProductivitySummary.counts.pull_requests_merged` | de esos, los que están en estado `merged`.                                                       |
| `GET /api/v1/pull-requests` → `meta.total`     | **histórico**: todos los PR conocidos del proyecto/repositorio, sin ventana de tiempo (`meta` es `PullRequestTotals`). |
| `meta.open`, `meta.merged`, `meta.closed`      | por estado; se calculan **antes** de aplicar el filtro `?state=`.                                   |
| `TaskListItem.pull_requests[]`                 | PR enlazados a la tarea (`number`, `state`, `url`).                                                 |

Regla para no confundirlos: `counts.pull_requests` responde "¿cuántos PR se movieron en esta ventana?" y `meta.total` "¿cuántos PR tiene el proyecto?". Un PR abierto hace un mes sin eventos nuevos cuenta en `meta.total` pero no en `counts.pull_requests` de esta semana. Ambos están documentados en los comentarios de `packages/contracts/src/summary.ts` (`counts.pull_requests`) e `integrations.ts` (`PullRequestTotals`).

Estado (`state`):

- `open`: abierto (incluye borradores).
- `merged`: fusionado (`merged = true` en GitHub; `fulfilled`/`MERGED` en Bitbucket). Es monótono: una entrega desordenada no lo devuelve a `open`.
- `closed`: cerrado sin fusionar (`DECLINED`/`SUPERSEDED` en Bitbucket).

**PR con líneas IA y % IA por PR.** Cada `PullRequestListItem` trae un bloque `ai`:

```
commits del PR      = commits de la rama origen (rama del IDE o del push) + el commit head + el merge commit
ai.commits          = nº de esos commits
ai.commits_with_ai  = de ellos, cuántos tienen ai_matched_lines > 0
ai.ai_matched_lines = Σ automation.ai_matched_lines
ai.commit_added_lines = Σ automation.commit_added_lines
ai.contains_ai_lines  = ai_matched_lines > 0
PR con líneas IA    = meta.with_ai_lines = nº de PR con contains_ai_lines
% IA del PR         = ai.ai_matched_lines / ai.commit_added_lines    (no es un campo: lo calcula el dashboard; null si el denominador es 0)
```

Los commits que llegaron solo por webhook (el IDE nunca los reportó) tienen `automation` en cero: suman al conteo de commits, pero no a las líneas.

**Lead time.** No es un campo del contrato. Se puede derivar como `merged_at − opened_at` de `PullRequestListItem`, con dos salvedades: ambos son la **hora de recepción** del webhook en MagiCode (no la del proveedor), y `opened_at` es la primera entrega recibida del PR (si la integración se configuró con el PR ya abierto, el lead time sale más corto). El lead time desde el primer commit o desde la primera sesión hasta el merge no está disponible en el MVP.

## Fuente y procedencia

- Conteos y estados: `git-remote` (webhook firmado), `real`.
- Bloque `ai`: `estimated`. El cruce es por rama y SHA, no recorre los ancestros reales del merge; y las líneas IA vienen de la coincidencia por hash del [embudo](embudo.md).
- Lead time derivado: `estimated` (horas de recepción).

## Cómo interpretarlo

- `meta.with_ai_lines / meta.total`: adopción de MagiCode en los PR del proyecto.
- % IA del PR > 0.70: el PR es mayoritariamente IA; conviene cruzarlo con la [criticidad](criticidad.md) de sus cambios antes de aprobarlo.
- `counts.pull_requests_merged / counts.pull_requests` bajo con mucha actividad: PR que se abren y quedan sin integrar (o se cierran sin fusionar).
- Un PR `merged` no es "desplegado": solo una evidencia de despliegue lleva a la etapa `deployed`. Pero si se despliega a producción su **merge commit** (o su head), los commits de su rama origen cuentan como desplegados (ver [embudo](embudo.md)).
- Lead time creciente en PR con alto % IA puede indicar que la revisión del código generado es costosa.

## Ejemplo

PR **#14** de `org/repo-demo`, rama `feature/MAG-123-descuentos` → `main`, título "MAG-123: descuentos por volumen" (ver [ejemplo completo](ejemplo-demo-001.md)).

| commit    | origen                      | `commit_added_lines` | `ai_matched_lines` |
|-----------|-----------------------------|---------------------:|-------------------:|
| `3f9c2e1` | IDE (`git.committed`)       |                   55 |                 43 |
| `5a6b7c8` | solo webhook (ajustes de revisión, head del PR) |   0 |                  0 |
| `9d8e7f6` | solo webhook (merge commit) |                    0 |                  0 |

```
ai.commits = 3     ai.commits_with_ai = 1     ai.ai_matched_lines = 43     ai.commit_added_lines = 55
contains_ai_lines = true
% IA del PR = 43 / 55 = 0.7818
opened_at = 2026-10-20T15:08Z     merged_at = 2026-10-21T10:30Z     lead time ≈ 19 h 22 min
```

En el resumen del proyecto con ventana 2026-10-20 → 2026-10-21: `counts.pull_requests = 1`, `counts.pull_requests_merged = 1`. En `GET /pull-requests`: `meta = {total: 1, open: 0, merged: 1, closed: 0, with_ai_lines: 1}`.

Nota: las 2 líneas IA que se reescribieron en `5a6b7c8` no se ven en el bloque `ai` (ese commit es solo remoto); se ven en la caída de `committed` (43) a `in_reference` (41) del embudo.

## Errores comunes / límites

- Comparar `counts.pull_requests` (ventana por actividad) con `meta.total` (sin ventana): no miden lo mismo.
- Un PR con commits de varias ramas (rebase, cherry-pick) o un squash merge puede quedar mal cruzado: el cruce no recorre la historia real.
- Bitbucket envía SHAs cortos en el merge commit; se comparan por prefijo (mínimo 7 caracteres).
- No hay métricas de revisión (comentarios, aprobaciones, revisores) en el MVP.
- `ChangeListItem` no tiene número de PR: el enlace cambio → PR se hace por la rama (`branch`) o por la tarea.

## Implementación

- Contrato del evento: `packages/contracts/src/integrations.ts` (`repo.pull_request` en `NormalizedWebhookEvent`); conteos en `packages/contracts/src/summary.ts` (`counts.pull_requests`, `counts.pull_requests_merged`). `PullRequestListItem` y `PullRequestTotals` (schemas zod) en `packages/contracts/src/integrations.ts`.
- Proyección del webhook: `apps/api/src/modules/webhooks/webhooks.projection.ts` (`pullRequest`).
- Listado y cruce con commits: `apps/api/src/modules/pull-requests/pull-requests.service.ts` (`prCommits`, `toPullRequestListItem`, `totalsOf`).
- Conteos del resumen: `apps/api/src/modules/productivity/productivity.service.ts` (`externalCounts`, `filterPullRequests`).
