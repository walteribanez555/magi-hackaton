# Limitaciones declaradas

## Qué es

Lista de lo que las métricas **no** garantizan, con su efecto en los números. El reto exige "honestidad de límites": cada limitación indica qué cifra afecta y cómo se ve en el dashboard.

## Cómo se calcula

No aplica. Cada fila remite a la fórmula del artículo correspondiente.

## Fuente y procedencia

Las cifras afectadas por estas limitaciones se publican como `estimated` (o `simulated` si vienen del mock o del seed). Ninguna se presenta como `real`.

## Cómo interpretarlo

| # | limitación | efecto | dónde se ve |
|---|------------|--------|-------------|
| 1 | Coincidencia por hash de línea normalizada | Líneas movidas, renombradas o reformateadas más allá de espacios no casan (subestima commit/supervivencia); líneas genéricas (`return null;`) pueden casar de más. | `committed`, `in_reference`, `ai_share`, `existing_in_repo` |
| 2 | Clasificación de `kind` por regex, sin parser y sin estado entre líneas | Imports multilínea y comentarios de bloque pueden clasificarse como `logic`. | importancia, líneas efectivas, mecánicas |
| 3 | Todas las etapas cuentan líneas no triviales, pero `generated` estima las triviales de lo rechazado (proporción de lo aceptado en la sesión) y `accepted` cuenta repeticiones mientras Git cuenta hashes únicos | `generated` es `estimated` (cota superior si la sesión no aceptó nada); la retención puede quedar levemente bajo 1 aunque todo llegue. `committed` se topa por lo aceptado del alcance. | `funnel[].lines`, `funnel[].conversion` |
| 4 | Tier por ruta | Un archivo crítico con ruta atípica puede pesar como `docs` o `core` erróneamente. | importancia, criticidad |
| 5 | Atribución `estimated` si MagiHub no da consumo por petición | Tokens por sesión/cambio/tarea son repartos proporcionales. | `tokens.total` filtrado, `attribution` |
| 6 | `unreconciled` | Si otra app usa la key, el total incluye consumo ajeno. Usar key dedicada. | `tokens.unreconciled` |
| 7 | "Desplegado" solo con evidencia a producción: SHA del commit o merge/head del PR de su rama (`DEPLOY_PRODUCTION_ENVIRONMENTS`) | Un squash a otra rama sin PR registrado, o un despliegue a un entorno no listado, no cuentan. Embudo y tarea usan la misma regla. | `funnel[deployed]`, `TaskListItem.deployed` |
| 8 | `in_reference` solo cuenta commits en `included_shas`; por commit manda el tag más reciente que lo incluye | Si el IDE no informa `included_shas`, la etapa queda en 0; tags anteriores del mismo commit no se suman. | `funnel[in_reference]` |
| 9 | Cruce PR ↔ commits por rama y SHA, sin recorrer ancestros | Rebase, cherry-pick o squash pueden romper el cruce. | `PullRequestListItem.ai` |
| 10 | Horas de PR = horas de recepción del webhook | El lead time derivado es aproximado y puede salir corto si la integración se configuró con el PR abierto. | lead time |
| 11 | Puntuaciones entrenadas con datos sintéticos | `ChangeScores.provenance = simulated` con XGBoost; la heurística es `estimated`. AUC ≈ 0.70. | `scores` |
| 12 | Etiqueta de retrabajo incluye la iteración normal en la misma sesión | Sobrestima `rework_risk` aprendido con datos reales. | `rework_risk`, criticidad |
| 13 | `hour_of_day` en UTC | `late_night` no refleja la hora local. | `rework_risk` |
| 14 | Salt de hash por sesión | No se detecta redundancia entre sesiones. | `repeated_in_session` |
| 15 | `TaskListItem.tokens` usa el `usage` de las respuestas | No coincide con `tokens.total` filtrado por tarea (falta lo no reconciliado). | tareas |
| 16 | Webhooks de Bitbucket sin archivos por commit ni despliegues | `files_*` = 0; la etapa `deployed` requiere `reference.marked{kind=deployment}`. | commits remotos, `deployed` |
| 17 | `cost_usd` | `null` salvo que MagiHub exponga costo verificable, y solo en la vista de toda la key. | `tokens.cost_usd` |
| 18 | Ventanas recientes | La API de consumo puede tener retraso de ingesta (`ingestion_delay_minutes`); `unreconciled` puede ser negativo o el total caer al respaldo `estimated`. | `tokens.total` |

## Ejemplo

En la sesión `demo-001` (ver [ejemplo completo](ejemplo-demo-001.md)) la retención en Git es `43 / 48 = 0.8958`: de las 48 líneas no triviales aceptadas (47 hashes únicos, la guarda repetida cuenta una vez en Git) llegaron 43; la diferencia entre 48 y 47 es la limitación 3. Los 120 tokens no reconciliados son la limitación 6 (una llamada con `curl` usando la misma key).

## Errores comunes / límites

- Presentar el MVP como certificación de autoría por línea: el reto lo deja explícitamente fuera de alcance.
- Ocultar `unreconciled` o las etiquetas `estimated`: son parte del resultado.

## Implementación

Ver la sección "Implementación" de cada artículo enlazado; resumen de límites también en `docs/metrics-model.md` §6.
