# Líneas efectivas

## Qué es

Las **líneas efectivas** son el denominador "honesto" de la productividad: las líneas aceptadas ponderadas por su [importancia](importancia.md), quitando las [redundantes](redundancia.md) y las [mecánicas](automatizacion.md). Responden a "¿cuánto código con contenido nuevo produjo la IA?", no a "¿cuántas líneas se tocaron?".

## Cómo se calcula

```
effective_lines =      Σ        peso(kind) × peso(tier)
                 líneas aceptadas
                 ∧ ¬redundante
                 ∧ ¬mecánica
```

- Una línea es redundante si dispara cualquier señal de redundancia (`intra_change`, `repeated_in_session`, `existing_in_repo`).
- Una línea es mecánica si `kind ∈ {import, trivial}` o `tier = generated`.
- No hay doble descuento: una línea redundante **y** mecánica se excluye una sola vez.
- En una línea repetida dentro del cambio, la primera aparición cuenta (si no es redundante por otra señal) y las siguientes valen 0.
- Es un número real (no entero), redondeado a 4 decimales.

Por etapa del [embudo](embudo.md):

| etapa          | campo de origen                                                   |
|----------------|--------------------------------------------------------------------|
| `generated`    | no aplica: `code.proposed` no trae dimensiones → `value = null`    |
| `accepted`     | Σ `code.accepted.payload.dimensions.effective_lines`              |
| `committed`    | Σ `git.committed.payload.automation.effective_lines` (pesos efectivos de las líneas IA que casaron en el commit) |
| `in_reference` | `reference.marked.payload.surviving_effective_lines`               |
| `deployed`     | líneas efectivas de la referencia cuyo SHA tiene evidencia de despliegue |

Se muestran en `ProductivitySummary.funnel[].effective_lines`, `ChangeListItem.effective_lines`, `SessionListItem.effective_lines`, `TaskListItem.effective_lines` y `TimelinePoint.effective_lines`.

## Fuente y procedencia

- Fuente: `ide-telemetry` (etapa aceptada) y cruce con Git (`git-local`/`git-remote`, `declared-reference`).
- Procedencia: siempre `estimated`. Combina tres heurísticas declaradas (clase de línea, coincidencia por hash, regla de mecánico). En datos de demo, `simulated`.

## Cómo interpretarlo

- `effective_lines / accepted_added_lines` es la "densidad" del cambio:
  - > 0.60: cambio denso en lógica nueva.
  - 0.30 – 0.60: rango típico.
  - < 0.30: mucho boilerplate, duplicación o archivos de bajo peso. Las líneas brutas exageran el aporte.
- Comparar la caída entre etapas: si `effective_lines` cae más que `lines` de `accepted` a `committed`, el humano está descartando precisamente la lógica (lo valioso) y conservando el relleno.
- Es la base de [tokens por 100 líneas efectivas](tokens-por-100-lineas.md), el KPI principal.

## Ejemplo

Sesión `demo-001` (ver [ejemplo completo](ejemplo-demo-001.md)).

`chg-1` (42 líneas, `weighted_lines = 23.03`):

```
peso de líneas mecánicas: 3 imports core × 0.1 + 1 import test × 0.09 + 10 triviales × 0 = 0.39
peso de líneas redundantes no mecánicas: 2.ª aparición de la guarda (logic core) 1.0
                                         + lógica ya existente en el repo (logic core) 1.0 = 2.00
(el import ya existente en el repo es mecánico: ya estaba descontado)
effective_lines = 23.03 − 0.39 − 2.00 = 20.64
```

`chg-4` (22 líneas, `weighted_lines = 12.10`): `12.10 − 0.10 (import) − 2.00 (2 lógicas repetidas en la sesión) = 10.00`.

| etapa          | líneas | líneas efectivas | densidad |
|----------------|-------:|-----------------:|---------:|
| `accepted`     |     48 |            30.64 |   0.6383 |
| `committed`    |     43 |            27.44 |        – |
| `in_reference` |     41 |            25.44 |        – |

De `accepted` a `committed` se pierden 4 líneas IA no triviales (3 de lógica de peso 1.0 y 1 comentario de 0.2): `30.64 − 3.20 = 27.44`. En la revisión del PR #14 se reescriben 2 líneas de lógica más: `27.44 − 2.00 = 25.44` en el tag `demo-v0.1`.

La densidad (`effective_lines / lines`) se muestra en `accepted`, sobre líneas no triviales como todo el [embudo](embudo.md): `30.64 / 48 = 0.6383`.

## Errores comunes / límites

- No sumar líneas efectivas de etapas distintas: cada etapa es un subconjunto de la anterior.
- `funnel[accepted].lines` cuenta todas las líneas no vacías (con triviales); `funnel[committed].lines` e `in_reference` cuentan hashes únicos no triviales. `effective_lines` no sufre esta diferencia (las triviales pesan 0), pero el cociente `effective_lines / lines` sí.
- Cambiar los pesos del proyecto cambia este número de forma retroactiva solo para eventos nuevos: los eventos ya ingeridos traen el valor calculado en el IDE.
- No mide corrección: una línea efectiva puede contener un bug. Ver [criticidad](criticidad.md).

## Implementación

- Esquema: `packages/contracts/src/dimensions.ts` (`ChangeDimensions.effective_lines`, `CommitAutomation.effective_lines`), `packages/contracts/src/events.ts` (`ReferenceMarked.surviving_effective_lines`).
- Cálculo: `packages/metrics/src/analyze.ts` (`effectiveWeights`), `packages/metrics/src/commit.ts` (`matchCommit`, `computeSurvival`).
- Agregación por etapa: `apps/api/src/modules/productivity/productivity.metrics.ts`.
