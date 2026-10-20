# Procedencia (real / estimated / simulated) y atribución (exact / estimated)

## Qué es

- **Procedencia** (`provenance`): etiqueta que acompaña a **cada número** del dashboard e indica si se midió en la fuente (`real`), se derivó con una aproximación declarada (`estimated`) o es ficticio (`simulated`). Es el "límite de honestidad de datos" del reto: nunca mezclar métricas reales y simuladas sin identificarlas.
- **Atribución** (`attribution`): cómo se relacionaron los tokens de MagiHub con los cambios de código: por id de petición (`exact`) o por ventana de tiempo (`estimated`).

## Cómo se calcula

Cada cifra es un `Measured`:

```
{ value: number | null, provenance: real | estimated | simulated, source: DataSource, note?: string }
```

`value = null` significa "no calculable" (p. ej. denominador 0), nunca cero.

| procedencia | significado                                                                 | ejemplos                                                         |
|-------------|------------------------------------------------------------------------------|------------------------------------------------------------------|
| `real`      | Medido en la fuente.                                                         | `tokens.total` de la API de consumo; conteo de líneas aceptadas del IDE; SHA de Git. |
| `estimated` | Derivado con una aproximación declarada.                                     | Líneas en commit por coincidencia de hash; líneas efectivas; tokens prorrateados por hora; `on_mechanical`. |
| `simulated` | Generado por `services/magihub-mock` (`MAGIHUB_MODE=mock`) o por el seed de demo (`source: demo-seed`). | Tokens del mock; sesiones del seed; puntuaciones de un modelo entrenado con datos sintéticos. |

Fuentes (`DataSource`): `magihub-usage-api`, `magihub-response`, `ide-telemetry`, `git-local`, `git-remote`, `declared-reference`, `deployment-evidence`, `magihub-mock`, `demo-seed`.

Combinación: cuando un número combina varios, hereda la **peor** procedencia (`simulated` > `estimated` > `real`). `ProductivitySummary.overall_provenance` es la peor procedencia de todos los `Measured` del resumen.

Atribución (`ProductivitySummary.attribution`, también en `EventsResponse.attribution`):

| valor       | condición                                                                                                   |
|-------------|--------------------------------------------------------------------------------------------------------------|
| `exact`     | La API de consumo de MagiHub tiene granularidad `request` **y** todas las peticiones del alcance tienen un registro con su `request_id`. |
| `estimated` | En cualquier otro caso: consumo por hora/día, sin API de consumo, o alguna petición sin registro. Se relaciona por API key + sesión + ventana horaria. |

Reconciliación: `tokens.unreconciled = total − reported_by_requests`. Si ≠ 0, otra aplicación usó la key o hay retraso de ingesta; se muestra, no se oculta.

## Fuente y procedencia

Este artículo define las etiquetas; cada artículo de métrica indica cuál le corresponde. Resumen:

| métrica                                   | procedencia habitual                     |
|-------------------------------------------|------------------------------------------|
| `tokens.total` (vista de toda la key)     | `real`                                   |
| `tokens.total` (vista filtrada, hora/día) | `estimated`                              |
| `funnel[generated].lines`, `funnel[accepted].lines`        | `real`                                   |
| `funnel[committed / in_reference / deployed].lines` | `estimated`                        |
| todas las `effective_lines` y aristas     | `estimated`                              |
| `ChangeScores.provenance`                 | `estimated` (modelo entrenado con datos reales) o `simulated` (sintéticos) |
| cualquier dato con `MAGIHUB_MODE=mock` o `demo-seed` | `simulated`                   |

## Cómo interpretarlo

- `overall_provenance = real`: todas las cifras son mediciones. Es raro: las líneas efectivas siempre son `estimated`.
- `overall_provenance = estimated`: es el estado normal en producción. Los números son defendibles si se lee la nota (`note`) de cada cifra.
- `overall_provenance = simulated`: el resumen incluye datos de demo o del mock. No usar para decisiones; en una demo, decirlo explícitamente.
- `attribution = estimated`: los tokens por sesión, cambio o tarea son repartos. Para mejorarla, usar una **API key dedicada** a MagiCode (así nadie más consume en la misma ventana) y pedir a MagiHub consumo con granularidad `request`.
- "Desplegado" solo aparece con evidencia (`deployment-evidence`). Una rama `main`, un merge o un tag sin evidencia se muestran como "versión de referencia (demo)".

## Ejemplo

Sesión `demo-001` con key dedicada y consumo por hora (ver [ejemplo completo](ejemplo-demo-001.md)):

| cifra                                  | valor     | procedencia | fuente               |
|----------------------------------------|----------:|-------------|----------------------|
| `tokens.total` (toda la key)           |     9 520 | `real`      | `magihub-usage-api`  |
| `tokens.total` (filtro `session_id`)   |     9 520 | `estimated` | `magihub-usage-api`  |
| `tokens.reported_by_requests`          |     9 400 | `real`      | `magihub-response`   |
| `tokens.unreconciled` (toda la key)    |       120 | `real`      | `magihub-usage-api`  |
| `tokens.unreconciled` (filtro `session_id`) | 120 | `estimated` | `magihub-usage-api`  |
| `tokens.on_mechanical`                 |  1 739.06 | `estimated` | `magihub-response`   |
| `funnel[accepted].lines`               |        64 | `real`      | `ide-telemetry`      |
| `funnel[accepted].effective_lines`     |     30.64 | `estimated` | `ide-telemetry`      |
| `funnel[committed].lines`              |        43 | `estimated` | `git-local`          |
| `funnel[in_reference].lines`           |        41 | `estimated` | `declared-reference` |
| `funnel[deployed].lines`               |         0 | `estimated` | `deployment-evidence` (nota: sin evidencia) |
| `attribution`                          | `estimated` | –         | consumo por hora     |
| `overall_provenance`                   | `estimated` | –         | –                    |

Si la misma sesión se ejecuta con `MAGIHUB_MODE=mock`, todas las cifras de tokens pasan a `simulated` con fuente `magihub-mock`, y `overall_provenance = simulated`.

## Errores comunes / límites

- Mostrar un número sin su etiqueta. El dashboard debe pintar siempre la procedencia junto al valor.
- Tratar `null` como 0. `null` es "no calculable".
- Creer que `exact` implica que las líneas también son exactas: la atribución solo habla de tokens ↔ peticiones; la relación líneas ↔ commit sigue siendo `estimated`.
- `unreconciled` negativo en una ventana reciente suele ser retraso de ingesta (`ingestion_delay_minutes`), no un error.

## Implementación

- Esquema: `packages/contracts/src/provenance.ts` (`Provenance`, `DataSource`, `Measured`, `Attribution`).
- Cálculo: `apps/api/src/modules/productivity/productivity.metrics.ts` (`worst`, `attributionOf`, `computeTokens`).
- Mock: `services/magihub-mock`; adaptador real: `apps/api/src/modules/magihub/magihub.client.ts`.
