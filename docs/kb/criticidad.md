# Criticidad

## Qué es

La **criticidad** prioriza qué cambios IA aceptados conviene revisar primero. Combina la probabilidad de que el cambio necesite retrabajo (`rework_risk`) con su **exposición**: cuánto valor tiene y en qué tipo de archivo vive. Un cambio con riesgo alto en documentación es menos crítico que el mismo riesgo en código `core`.

## Cómo se calcula

```
tier_weight       = Σ share(tier) × peso(tier)                    (share por líneas agregadas; pesos de importancia)
exposure          = clamp01(0.5 × importance_score + 0.5 × tier_weight)
criticality_score = clamp01( rework_risk^0.7 × exposure^0.3 )
```

- `rework_risk` sale del modelo XGBoost o de la heurística `heuristic:v1` (ver [puntuaciones](puntuaciones-xgboost.md)).
- `importance_score` es la [importancia](importancia.md) del cambio.
- Pesos de tier: `core 1.0`, `test 0.9`, `infra 0.7`, `docs 0.3`, `generated 0`.
- Exponentes y pesos en `ml/heuristic_weights.json` → `criticality` (`rework_exponent 0.7`, `exposure_exponent 0.3`, `importance_weight 0.5`, `tier_weight 0.5`). El riesgo domina; la exposición modula.

Nivel (`criticality`) según `CRITICALITY_THRESHOLDS` (se asigna el nivel más alto cuyo umbral se alcanza, `score ≥ umbral`):

| nivel      | `criticality_score` |
|------------|---------------------|
| `low`      | 0 – < 0.35          |
| `medium`   | 0.35 – < 0.60       |
| `high`     | 0.60 – < 0.80       |
| `critical` | ≥ 0.80              |

Se publica en `ChangeListItem.scores.criticality` y `ChangeListItem.scores.criticality_score`; también puede escribirse en Jira (`magicode_criticality`, ver [respuesta a tareas](respuesta-a-tareas.md)).

## Fuente y procedencia

Hereda la procedencia de `ChangeScores.provenance`: `estimated` con la heurística `heuristic:v1` o con un XGBoost entrenado con datos reales; `simulated` con un XGBoost entrenado con datos sintéticos (el modelo actual del MVP). Nunca es `real`: es una predicción.

## Cómo interpretarlo

| nivel      | qué hacer                                                                                                        |
|------------|-------------------------------------------------------------------------------------------------------------------|
| `low`      | Revisión normal del PR.                                                                                           |
| `medium`   | Revisar con atención las líneas de lógica; comprobar que haya tests del comportamiento cambiado.                  |
| `high`     | Revisión explícita por otra persona antes del merge; agregar tests si `test_tier_share` es 0.                     |
| `critical` | Bloquear el merge hasta revisión y tests; típico de cambios grandes en `core`, sin tests, en tareas Bug, hechos directamente en la rama default o con muchas regeneraciones. |

- Cota práctica: como `exposure ≤ 1`, `criticality_score ≤ rework_risk^0.7`. Para llegar a `critical` (0.80) hace falta `rework_risk ≥ 0.80^(1/0.7) ≈ 0.73` con exposición máxima; para `high` (0.60), `rework_risk ≥ 0.48`.
- Con exposición baja (p. ej. un cambio solo en `docs` con importancia 0.2: exposure = 0.5×0.2 + 0.5×0.3 = 0.25), el factor `0.25^0.3 = 0.66` reduce el score un tercio.
- Mirar `top_factors` del riesgo para decidir la acción concreta.

## Ejemplo

Sesión `demo-001` (ver [ejemplo completo](ejemplo-demo-001.md)), puntuaciones de `heuristic:v1`:

`chg-1` — 30 líneas en `core`, 12 en `test`:

```
tier_weight       = (30/42)×1.0 + (12/42)×0.9 = 0.7143 + 0.2571 = 0.9714
exposure          = 0.5×0.5483 + 0.5×0.9714 = 0.7599
criticality_score = 0.0933^0.7 × 0.7599^0.3 = 0.1901 × 0.9209 = 0.1750   → low
```

`chg-4` — 22 líneas en `core`:

```
tier_weight = 1.0      exposure = 0.5×0.55 + 0.5×1.0 = 0.7750
criticality_score = 0.1748^0.7 × 0.7750^0.3 = 0.2732   → low
```

Contraejemplo (hipotético, fuera de la sesión de demo): un hotfix de 140 líneas en `core`, sin tests, en una tarea Bug, hecho directamente en `main` a las 23:00 UTC, con 3 regeneraciones, aceptación de sesión 0.30, `importance_score 0.74`, `redundancy_score 0.22`, `mechanical_share 0.12`, `logic_kind_share 0.60`, 25 % editado antes de aceptar:

```
rework_risk       = 0.9532
exposure          = 0.5×0.74 + 0.5×1.0 = 0.87
criticality_score = 0.9532^0.7 × 0.87^0.3 = 0.9670 × 0.9591 = 0.9274   → critical
```

El mismo cambio en una Story a las 15:00 UTC, con 90 líneas, 1 regeneración y aceptación 0.50 da `rework_risk = 0.6436` y `criticality_score = 0.7045` → `high`.

## Errores comunes / límites

- No es severidad de un bug ni impacto en negocio: es "probabilidad de retrabajo × exposición".
- Hereda los límites de la etiqueta de retrabajo (incluye la iteración normal en la misma sesión) y de los datos de entrenamiento (hoy sintéticos).
- El tier se infiere por ruta: un archivo crítico fuera de `src/` (p. ej. `scripts/billing.ts`) igualmente es `core`, pero uno en `docs/` con código ejecutable pesa 0.3.
- El contrato describe la criticidad como "rework_risk × importancia × tier del archivo"; la fórmula implementada es la media geométrica ponderada de arriba (con exposición = media de importancia y peso de tier). Este artículo documenta la implementada.

## Implementación

- Umbrales y esquema: `packages/contracts/src/scoring.ts` (`Criticality`, `CRITICALITY_THRESHOLDS`, `ChangeScores`).
- Fórmula y pesos: `ml/heuristic.py` (`criticality_score`, `criticality_level`), `ml/heuristic_weights.json` (`criticality`).
- API: `apps/api/src/modules/scoring/scoring.service.ts` (`criticalityFrom`; mismos exponentes y umbrales), `scoring.features.ts` (`tier_weight`).
