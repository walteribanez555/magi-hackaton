# Puntuaciones (XGBoost): probabilidad de supervivencia y riesgo de retrabajo

## Qué es

Cada cambio aceptado recibe dos **puntuaciones** (`ChangeListItem.scores`, tipo `ChangeScores`) que estiman, antes de que ocurra, lo que el embudo solo puede medir después:

- `survival_probability`: P(el cambio IA aceptado llega a la versión de referencia o a despliegue).
- `rework_risk`: P(el cambio requiere retrabajo en ≤ 14 días). Es la base de la [criticidad](criticidad.md).

Las calcula un modelo **XGBoost** servido en **SageMaker Serverless**; si no hay endpoint, una **heurística determinista** (`heuristic:v1`) con la misma interfaz. Es el mismo patrón que `walteribanez555/fraud-detector`: `ml/train.py` → despliegue a SageMaker Serverless solo si el AUC mejora → la Lambda invoca el endpoint y cae a reglas si falla.

## Cómo se calcula

**1. Vector de features** (`SCORING_FEATURES`, 21 columnas; el orden es el contrato porque el contenedor XGBoost recibe CSV sin cabecera):

| feature                      | definición                                                                  |
|------------------------------|------------------------------------------------------------------------------|
| `accepted_added_lines`       | líneas agregadas no vacías aceptadas                                         |
| `accepted_deleted_lines`     | líneas borradas aceptadas                                                    |
| `files_count`                | nº de archivos del cambio                                                    |
| `importance_score`           | `dimensions.importance.score`                                                |
| `redundancy_score`           | `dimensions.redundancy.score`                                                |
| `mechanical_share`           | `dimensions.automation.mechanical_share`                                     |
| `effective_lines`            | `dimensions.effective_lines`                                                 |
| `edited_before_accept_ratio` | `edited_before_accept / (accepted_as_is + edited_before_accept)`; 0 sin datos |
| `core_tier_share`            | Σ `added` en archivos tier `core` / Σ `added`                                |
| `test_tier_share`            | Σ `added` en archivos tier `test` / Σ `added`                                |
| `logic_kind_share`           | `by_kind.logic / importance.lines`                                           |
| `test_kind_share`            | `by_kind.test / importance.lines`                                            |
| `tokens_total`               | tokens de la petición IA que originó el cambio más los de su cadena de regeneraciones |
| `tokens_per_effective_line`  | `tokens_total / max(effective_lines, 1)`                                     |
| `regenerations`              | nº de regeneraciones de la petición (cadena `regenerates`)                   |
| `latency_ms`                 | latencia de la petición IA                                                   |
| `session_acceptance_rate`    | aceptados / propuestos en la sesión al momento del cambio (0..1)             |
| `has_task`                   | 1 si el cambio tiene `task_key`                                              |
| `task_is_bug`                | 1 si la tarea es de tipo Bug (`bug`, `defect`, `incident`, `hotfix`)         |
| `branch_is_default`          | 1 si la rama es la default (`main`, `master`, `develop`, `trunk`)            |
| `hour_of_day`                | hora UTC (0..23) de `occurred_at`                                            |

**2. Etiquetas de entrenamiento** (con datos reales; las observaciones aún abiertas se excluyen, no se cuentan como 0):

- `survival = 1` si el cambio está `in_reference`/desplegado o su `commit_sha` está en una referencia (`included_shas`/`sha`) o en un Deployment `success`; `0` si pasaron 14 días sin llegar.
- `rework = 1` si otro cambio aceptado del mismo repositorio, posterior y dentro de 14 días, borra líneas en alguno de los mismos archivos, o si una tarea Bug creada/actualizada en esa ventana está enlazada a commits que tocan esos archivos; `0` si pasaron 14 días sin señal.

**3. Modelo** (`ml/train.py`): `XGBClassifier(objective=binary:logistic, n_estimators=1500, max_depth=3, learning_rate=0.03, subsample=0.8, colsample_bytree=0.8, min_child_weight=20, reg_alpha=0.1, reg_lambda=2.0, early_stopping_rounds=80)`. Split 70/15/15 estratificado y agrupado por sesión (no hay fuga entre cambios de la misma sesión). Sin `scale_pos_weight`: se necesitan probabilidades calibradas porque la criticidad usa el valor de `rework_risk`.

Dataset: real (exportado de DynamoDB) si hay ≥ `MIN_REAL_ROWS` (1 000) filas etiquetadas; si no, sintético (`ml/generate_synthetic.py`, que usa la heurística + factores latentes + ruido).

**4. Despliegue** (regla de fraud-detector + guardas): se despliega si `AUC ≥ MIN_AUC` (0.65) **y** mejora al endpoint actual; con datos reales, además debe superar el AUC de la heurística; un modelo real nunca se reemplaza por uno sintético. Endpoint `magicode-<env>-<survival|rework>` en SageMaker Serverless (1 024 MB, concurrencia 5); la Lambda de la API recibe `SCORING_TRAINED_ON` y `SCORING_MODEL_VERSION`.

**5. Fallback `heuristic:v1`** (pesos en `ml/heuristic_weights.json`, misma fórmula en Python y TypeScript): `p = sigmoid(intercept + Σ coef × término)`.

| término (derivado)    | definición                                                         | survival | rework |
|-----------------------|--------------------------------------------------------------------|---------:|-------:|
| intercepto            |                                                                     |    0.35  |  −2.3  |
| `redundancy_score`    |                                                                     |   −2.4   |   0.6  |
| `mechanical_share`    |                                                                     |   −1.8   |  −1.2  |
| `importance_score`    |                                                                     |    0.6   |    –   |
| `core_tier_share`     |                                                                     |    0.9   |   0.6  |
| `test_tier_share`     |                                                                     |     –    |  −0.7  |
| `logic_kind_share`    |                                                                     |    0.9   |   0.6  |
| `edited_before_accept_ratio` |                                                             |    0.8   |   0.5  |
| `acceptance_centered` | `session_acceptance_rate − 0.6`                                     |    1.5   |  −1.0  |
| `has_task`            |                                                                     |    0.35  |    –   |
| `task_is_bug`         |                                                                     |     –    |   1.0  |
| `branch_is_default`   |                                                                     |    0.3   |    –   |
| `log_regen`           | `ln(1 + regenerations)`                                             |   −0.45  |   0.3  |
| `log_added`           | `ln(1 + accepted_added_lines) − ln(21)` (0 en un cambio de 20 líneas) | −0.15  |  0.45  |
| `large_untested_core` | `core_tier_share × big × (1 − test_tier_share)²`, `big = clamp01((ln(1+added) − ln(41)) / 1.5)` | – | 1.6 |
| `late_night`          | 1 si `hour_of_day ≥ 22` o `≤ 5` (UTC)                               |     –    |  0.35  |

**6. Inferencia en la API**: la Lambda envía el vector como CSV sin cabecera a los dos endpoints (`SCORING_SURVIVAL_ENDPOINT`, `SCORING_REWORK_ENDPOINT`) con un presupuesto de 300 ms (`SCORING_TIMEOUT_MS`). Ante cualquier error, endpoint ausente o timeout se usa la heurística para **ambos** scores (todo o nada: nunca un `model_version` mixto) y se abre un circuit breaker de 60 s (`SCORING_COOLDOWN_MS`) durante el cual no se reintenta SageMaker.

**7. Salida** (`ChangeScores`, valores redondeados a 4 decimales): `survival_probability`, `rework_risk`, `criticality`, `criticality_score`, `model_version` (`xgboost:<versión>` o `heuristic:v1`), `provenance`, `top_factors` (hasta 5 `{feature, direction: up|down}`).

`top_factors` explica `rework_risk` (la base de la criticidad):

- Heurística: contribuciones exactas al logit (peso × término), ordenadas por valor absoluto; `direction = up` si empuja el riesgo hacia arriba. Los términos derivados se nombran por su feature (`acceptance_centered` → `session_acceptance_rate`, `log_added` → `accepted_added_lines`, `log_regen` → `regenerations`, `late_night` → `hour_of_day`), salvo `large_untested_core`, que conserva su nombre.
- XGBoost: gain normalizado × |desviación de la feature respecto a su mediana de entrenamiento| (tabla estática `feature-importance.json`); la dirección combina el signo de la desviación con la dirección monótona aprendida. Es una aproximación, no SHAP.

## Fuente y procedencia

- `provenance = estimated`: modelo entrenado con datos reales.
- `provenance = simulated`: modelo entrenado con datos sintéticos (`trained_on: synthetic`). Es el estado actual del MVP: el modelo `20261020-203004` se entrenó con datos sintéticos.
- `heuristic:v1` (fallback): `provenance = estimated` (estimación declarada con pesos fijos).
- `scores = null` hasta que se calculan.

## Cómo interpretarlo

| `survival_probability` | lectura                                                                                       |
|------------------------|-----------------------------------------------------------------------------------------------|
| ≥ 0.80                 | Muy probable que llegue a la versión de referencia tal cual.                                  |
| 0.50 – 0.80            | Probable, con ajustes.                                                                         |
| < 0.50                 | Más probable que se descarte o reescriba: candidato a revisar antes del commit.               |

| `rework_risk` | lectura                                                                                                  |
|---------------|-----------------------------------------------------------------------------------------------------------|
| < 0.20        | Bajo (la tasa base del entrenamiento sintético es 0.21).                                                  |
| 0.20 – 0.50   | Atención: revisar `top_factors` (cambio grande en `core` sin tests, tarea Bug, muchas regeneraciones).    |
| > 0.50        | Alto: es más probable que no que el código se reescriba en 14 días. Pedir revisión y tests.               |

- Supervivencia alta y retrabajo alto no se contradicen: un cambio grande en `main` suele llegar a la versión (sobrevive) y aun así necesitar correcciones.
- Usar `top_factors` para la acción: `test_tier_share` `down` en retrabajo significa "agregar tests reduce el riesgo"; `redundancy_score` `down` en supervivencia significa "la duplicación reduce la probabilidad de sobrevivir".
- Las probabilidades son útiles para priorizar revisiones, no para juzgar personas.

Calidad actual (test, datos sintéticos): survival AUC 0.7227 (heurística 0.7295), rework AUC 0.7026 (heurística 0.7000), ECE 0.027 y 0.015. Con datos sintéticos el XGBoost no puede superar con claridad a la heurística, porque la heurística es el proceso que generó los datos.

## Ejemplo

Sesión `demo-001`, sin endpoint SageMaker (`model_version = heuristic:v1`). Ver [ejemplo completo](ejemplo-demo-001.md).

Features de `chg-1`: `accepted_added_lines 42`, `importance_score 0.5483`, `redundancy_score 0.0938`, `mechanical_share 0.3333`, `effective_lines 20.64`, `edited_before_accept_ratio 0`, `core_tier_share 30/42 = 0.7143`, `test_tier_share 12/42 = 0.2857`, `logic_kind_share 14/42 = 0.3333`, `test_kind_share 8/42 = 0.1905`, `tokens_total 2 400`, `tokens_per_effective_line 2 400 / 20.64 = 116.28`, `regenerations 0`, `latency_ms 4 200`, `session_acceptance_rate 1.0` (1 aceptado de 1 propuesto), `has_task 1`, `task_is_bug 0`, `branch_is_default 0`, `hour_of_day 14`.

```
survival: logit = 0.35 − 2.4×0.0938 − 1.8×0.3333 + 0.6×0.5483 + 0.9×0.7143 + 0.9×0.3333
                  + 1.5×(1.0 − 0.6) + 0.35 − 0.15×0.7167 = 1.6393
          survival_probability = sigmoid(1.6393) = 0.8374
          (log_added = ln 43 − ln 21 = 0.7167)
rework:   big = clamp01((ln 43 − ln 41) / 1.5) = 0.0317
          large_untested_core = 0.7143 × 0.0317 × (1 − 0.2857)² = 0.0116
          logit = −2.3 + 0.6×0.7143 + 0.6×0.3333 + 0.45×0.7167 + 1.6×0.0116 + 0.6×0.0938
                  − 1.2×0.3333 − 0.7×0.2857 − 1.0×(1.0 − 0.6) = −2.2741
          rework_risk = sigmoid(−2.2741) = 0.0933
```

`chg-4` (22 líneas, todo `core`, 3 de 22 editadas, `session_acceptance_rate = 2/4 = 0.5`): `survival_probability = 0.7975`, `rework_risk = 0.1748`.

`top_factors` (riesgo de retrabajo) de `chg-1`: `core_tier_share` up (+0.43), `session_acceptance_rate` down (−0.40), `mechanical_share` down (−0.40), `accepted_added_lines` up (+0.32), `logic_kind_share` up (+0.20). De `chg-4`: `core_tier_share` up, `mechanical_share` down, `logic_kind_share` up, `session_acceptance_rate` up, `redundancy_score` up.

Ambos con [criticidad](criticidad.md) `low`, `provenance = estimated`.

Nota sobre la etiqueta real: si se entrenara con esta sesión, `chg-1` tendría `rework = 1`, porque `chg-4` borró 4 líneas de `src/pricing/discounts.ts` 36 minutos después. Ver límites.

## Errores comunes / límites

- Leer las puntuaciones como verdad: son probabilidades con AUC ≈ 0.70, y hoy entrenadas con datos sintéticos (`simulated`).
- La etiqueta `rework` cuenta como retrabajo cualquier borrado posterior en el mismo archivo, incluida la iteración normal dentro de la misma sesión (como `chg-1` → `chg-4`). Esto infla la tasa de retrabajo real hasta que se excluyan los cambios de la misma sesión o se use una señal explícita (`lines_rewritten_14d`, campo propuesto).
- `session_acceptance_rate` depende del momento: el primer cambio de una sesión tiene 1.0 o 0 según se acepte, lo que lo vuelve ruidoso en sesiones cortas.
- `hour_of_day` es UTC: `late_night` no refleja la hora local del desarrollador.
- `branch_is_default` compara contra `main/master/develop/trunk` salvo que se informe la rama default real.
- `top_factors` del XGBoost es una aproximación (gain × desviación de la mediana), no una atribución SHAP por predicción. `large_untested_core` puede aparecer como factor aunque no es una columna de `SCORING_FEATURES`.
- El contexto (`tokens_total`, `regenerations`, `latency_ms`, `session_acceptance_rate`, `task_type`) lo debe aportar quien invoca el scoring; si falta, esas features valen 0 y sesgan las puntuaciones (con `session_acceptance_rate = 0`, `acceptance_centered = −0.6`).

## Implementación

- Contrato: `packages/contracts/src/scoring.ts` (`SCORING_FEATURES`, `ScoringModel`, `ChangeScores`, `CRITICALITY_THRESHOLDS`).
- Features y etiquetas: `ml/features.py`, `ml/features.json` (generado desde contracts por `scripts/export-scoring-features.mjs`), `ml/labels.py`, `ml/export_dataset.py`.
- Heurística: `ml/heuristic.py`, `ml/heuristic_weights.json` (copiado a `apps/api/src/modules/scoring/heuristic-weights.json`).
- Entrenamiento y despliegue: `ml/train.py`, `ml/generate_synthetic.py`, `ml/model/{survival,rework}/` (`metrics.json`, `model_card.md`); documentación en `ml/README.md`.
- API: `apps/api/src/modules/scoring/scoring.service.ts` (`createScoringService`, `topFactors`, `criticalityFrom`, `onChangeAccepted`), `scoring.features.ts` (`buildFeatures`, `toCsvRow`), `scoring.heuristic.ts`, `heuristic-weights.json`, `feature-importance.json`. Enganche con la ingesta: `onChangeAccepted` en `apps/api/src/modules/productivity/productivity.service.ts` (hoy es un stub `TODO(scoring)`: hasta cablearlo, `ChangeListItem.scores` llega `null`).
