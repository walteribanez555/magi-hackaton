# Tokens consumidos y su desglose

## Qué es

Los **tokens** son el costo de inferencia que MagiHub mide para una API key en un intervalo. Son el numerador de todos los KPIs de eficiencia. Se imputan **completos**: incluyen rechazos, errores y regeneraciones, porque son el costo real de producir lo que sobrevive.

## Cómo se calcula

`ProductivitySummary.tokens` (`TokenBreakdown`):

| campo                        | definición                                                                                  |
|------------------------------|---------------------------------------------------------------------------------------------|
| `total`                      | Fuente de verdad: API de consumo de MagiHub (`GET /v1/usage?from&to&granularity`) para la key y la ventana. |
| `reported_by_requests`       | Σ `usage.total_tokens` devuelto en cada respuesta de Smart Auto (`ai.request.completed.payload.usage`). |
| `unreconciled`               | `total − reported_by_requests`.                                                             |
| `on_accepted`                | Σ tokens de las peticiones con ≥ 1 cambio aceptado (estado `accepted`, `committed` o `in_reference`). |
| `on_rejected`                | Σ tokens de las peticiones **sin** cambio aceptado que **no** son regeneración redundante: rechazos, errores, cancelaciones, exploración. |
| `on_redundant_regenerations` | Σ tokens de las peticiones **no aceptadas** cuyo `output_hash` repite el de una petición **anterior** de la misma sesión. |
| `on_mechanical`              | `on_accepted × mechanical_share` (tokens proporcionales a líneas automatizables sin LLM).   |
| `cost_usd`                   | Σ `cost_usd` de los registros de consumo, solo si MagiHub lo expone y la vista es de toda la key; si no, `null`. |

Cálculo de `total` según el alcance y la granularidad del consumo:

| caso                                                        | `total`                                                             | procedencia |
|-------------------------------------------------------------|---------------------------------------------------------------------|-------------|
| Vista de toda la key (sin filtros)                          | Σ `usage.total_tokens` de todos los registros de la ventana         | `real`      |
| Vista filtrada, granularidad `request`                      | Σ de los registros cuyo `request_id` pertenece a las peticiones del alcance; las peticiones aún sin registro (retraso de ingesta) suman su `usage` reportado | `real` (`estimated` si hubo que completar) |
| Vista filtrada, granularidad `hour`/`day`                   | por ventana: `tokens_ventana × (reportado_alcance / reportado_key)`, redondeado | `estimated` |
| Sin API de consumo o sin registros en la ventana con peticiones reportadas | `reported_by_requests` (con nota)                     | `estimated` |

Tokens de cada petición: si hay un registro de consumo con su `request_id` (granularidad `request`) se usa ese valor (atribución exacta); si no, el `usage` de la respuesta.

Relaciones:

```
on_accepted + on_redundant_regenerations + on_rejected = Σ tokens por petición   (PARTICIÓN)
Σ tokens por petición + unreconciled ≈ total
on_mechanical ⊂ on_accepted                               (vista transversal, no se suma)
```

Cada petición cae en un solo grupo, por prioridad: con cambio aceptado → `on_accepted`; si no, con `output_hash` repetido → `on_redundant_regenerations`; el resto → `on_rejected`. `dimensions.redundancy.redundant_regenerations` sigue contando **todas** las peticiones con `output_hash` repetido (aceptadas o no).

**Regla única de imputación** (`allocateUsage` en `productivity.metrics.ts`): el `total` del resumen, `SessionListItem.tokens` y `TaskListItem.tokens` usan la misma tabla de arriba con el alcance de cada uno (las peticiones de la sesión, de la tarea o del filtro). Por eso una sesión en una key con consumo por hora sale `estimated` (prorrateada) aunque cada respuesta haya reportado su `usage`, y con el mock sale `simulated`.

Otros lugares donde aparecen tokens:

- `SessionListItem.tokens`: API de consumo imputada a las peticiones de la sesión (regla única de arriba).
- `ChangeListItem.tokens`: tokens de su petición; si una petición produjo `n` cambios, se reparten `tokens / n` (con nota).
- `TaskListItem.tokens`: API de consumo (snapshots guardados de cada key) imputada a las peticiones de las sesiones enlazadas que son de la tarea o no tienen tarea; sin snapshots, Σ reportado `estimated`. Ver [tareas y ramas](tareas-y-ramas.md).
- `by_model[].tokens`: Σ tokens por modelo que eligió Smart Auto (`model` del evento; `unknown` si no se expone).
- `TimelinePoint.tokens`: por bucket de hora/día; en vista de toda la key sale de los registros de consumo, si no, de las peticiones.

## Fuente y procedencia

- `total`: `magihub-usage-api`, `real`. Es lo que pide el reto: tokens medidos por MagiHub, no contados por el editor.
- `reported_by_requests`: `magihub-response`, `real`.
- Si el backend corre con `MAGIHUB_MODE=mock` (servicio `services/magihub-mock`), **todos** los tokens son `simulated` con fuente `magihub-mock`.
- `on_mechanical` siempre es como mínimo `estimated` (es un reparto proporcional).

## Cómo interpretarlo

- `unreconciled ≠ 0`: otro proceso usó la misma key en la ventana, o MagiHub tiene retraso de ingesta (`ingestion_delay_minutes`). Se muestra, no se oculta. Si es > 5 % del total en una ventana cerrada, usar una **API key dedicada** para MagiCode. Si es negativo, la ventana aún no está completa en la API de consumo.
- `on_rejected / total`:
  - < 0.25: poco desperdicio.
  - 0.25 – 0.50: exploración normal (preguntar, comparar alternativas).
  - > 0.50: más de la mitad de los tokens no produjo nada aceptado. Revisar prompts, contexto enviado y errores.
- `on_redundant_regenerations / total` > 0.10: se está pagando por pedir lo mismo varias veces.
- `on_mechanical / on_accepted` es exactamente `mechanical_share`: > 0.50 significa que la mitad de los tokens útiles fue a código automatizable (ver [automatización](automatizacion.md)).
- `cost_usd = null` no es cero: significa que MagiHub no expone un costo verificable para ese alcance.

## Ejemplo

Sesión `demo-001` con API key dedicada (ver [ejemplo completo](ejemplo-demo-001.md)). El consumo de MagiHub tiene granularidad `hour`.

| petición | estado | tokens | resultado                                       |
|----------|--------|-------:|-------------------------------------------------|
| req-101  | ok     |  2 400 | `chg-1` aceptado                                 |
| req-102  | ok     |  1 800 | `chg-2` rechazado                                |
| req-103  | ok     |  1 700 | regenera `req-102`, mismo `output_hash`; `chg-3` rechazado |
| req-104  | ok     |  2 900 | `chg-4` aceptado (3 líneas editadas)             |
| req-105  | error  |    600 | sin propuesta                                    |

```
reported_by_requests       = 2 400 + 1 800 + 1 700 + 2 900 + 600 = 9 400
total (API de consumo)     = 9 520
unreconciled               = 9 520 − 9 400 = 120
on_accepted                = 2 400 + 2 900 = 5 300
on_redundant_regenerations = 1 700                              (req-103, no aceptada)
on_rejected                = 1 800 + 600 = 2 400                (5 300 + 1 700 + 2 400 = 9 400 ✓)
on_mechanical              = 5 300 × 0.328125 = 1 739.0625 ≈ 1 739
cost_usd                   = null
```

Vista de toda la key: `total = 9 520` es `real`. Vista filtrada por `session_id = demo-001`: como la granularidad es `hour`, el total se prorratea; al ser la única sesión que usó la key, el reparto es 9 520 × (9 400 / 9 400) = 9 520, pero la procedencia pasa a `estimated`. En ambas vistas la [atribución](procedencia-y-atribucion.md) es `estimated`, porque el consumo no trae granularidad `request`.

Lectura: el 43 % de los tokens ((2 400 + 1 700) / 9 520) fue exploración o desperdicio, de los cuales 1 700 se gastaron en una regeneración idéntica. `SessionListItem.tokens` de `demo-001` = 9 520 `estimated` (mismo prorrateo que el resumen).

## Errores comunes / límites

- No usar `reported_by_requests` como total: el reto exige el dato de MagiHub. Solo se usa como respaldo, marcado `estimated`.
- `on_accepted + on_redundant_regenerations + on_rejected` suman el total por petición, no `total`: la diferencia es `unreconciled`.
- `on_redundant_regenerations` solo marca coincidencias exactas de `output_hash` (salida normalizada idéntica), no salidas "casi" iguales.
- El prorrateo por hora/día asume que el reparto del consumo dentro de cada ventana es proporcional al `usage` reportado.
- `cost_usd` por alcance filtrado no está disponible: MagiHub lo reporta por key.

## Implementación

- Esquema: `packages/contracts/src/summary.ts` (`TokenBreakdown`), `packages/contracts/src/magihub.ts` (`UsageRecord`, `UsageResponse`), `packages/contracts/src/events.ts` (`TokenUsage`, `AiRequestCompleted`).
- Cálculo: `apps/api/src/modules/productivity/productivity.metrics.ts` (`allocateUsage`, `computeTokens`, `resolveRequestTokens`, `redundantRegenerations`); tareas: `apps/api/src/modules/tasks/tasks.service.ts` (`allocateTaskTokens`).
- Lectura de consumo: `apps/api/src/modules/magihub/magihub.client.ts`, `apps/api/src/modules/usage/`.
