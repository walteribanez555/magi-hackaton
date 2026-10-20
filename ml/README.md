# MagiCode — scoring con XGBoost (`survival`, `rework` → criticidad)

Puntuaciones por cambio IA aceptado, con la misma arquitectura que
[walteribanez555/fraud-detector](https://github.com/walteribanez555/fraud-detector):
`ml/train.py` entrena XGBoost, **despliega a SageMaker Serverless solo si el AUC mejora** al del
endpoint actual (metadata en S3), y la Lambda de la API invoca el endpoint con CSV y **cae a una
heurística determinista** si no hay endpoint o falla.

> ⚠ **Los modelos actuales están entrenados con datos SIMULADOS** (`generate_synthetic.py`).
> Las métricas de abajo miden qué tan bien XGBoost recupera los supuestos del generador, **no**
> su desempeño en repositorios reales. Mientras `SCORING_TRAINED_ON` no sea `real`, la API marca
> las puntuaciones XGBoost con `provenance: "simulated"`.

## 1. Problema

Cada cambio IA aceptado en la extensión trae sus tres aristas deterministas (importancia,
redundancia, automatización — `docs/metrics-model.md`). Sobre eso se estiman dos probabilidades
(`packages/contracts/src/scoring.ts`):

| modelo     | pregunta                                                                                 | uso                     |
|------------|------------------------------------------------------------------------------------------|-------------------------|
| `survival` | P(el cambio aceptado llega a la versión de referencia / despliegue)                      | supervivencia esperada  |
| `rework`   | P(retrabajo en ≤ 14 días: líneas reescritas/borradas o tarea **Bug** en los mismos archivos) | base de la **criticidad** |

**Criticidad** (`ChangeScores.criticality`), combinando riesgo, importancia y tier del archivo:

```
tier_weight       = Σ share(tier) × DEFAULT_TIER_WEIGHTS[tier]      (core 1 · test .9 · infra .7 · docs .3 · generated 0)
exposure          = clamp01(0.5 × importance_score + 0.5 × tier_weight)
criticality_score = rework_risk^0.7 × exposure^0.3                 → low < .35 ≤ medium < .6 ≤ high < .8 ≤ critical
```

El exponente 0.7 hace que el riesgo domine; la exposición solo "apaga" lo que no importa
(docs/generados ⇒ exposición ≈ 0 ⇒ nunca crítico). En el dataset sintético con la heurística:
81 % low · 16 % medium · 2.5 % high · 0.3 % critical.

## 2. Features (orden fijo = columnas del modelo)

El orden sale de `SCORING_FEATURES` en contracts → `ml/features.json` (generado, nunca a mano):

```bash
npm run build -w @magicode/contracts && node scripts/export-scoring-features.mjs   # --check en CI
```

Definiciones idénticas en `ml/features.py` (Python) y `apps/api/src/modules/scoring/scoring.features.ts` (TS),
con un test de paridad numérica (mismo ítem → mismo vector y mismo score heurístico):

| feature | definición |
|---|---|
| `accepted_added_lines` / `accepted_deleted_lines` / `files_count` | conteos del cambio aceptado |
| `importance_score` / `redundancy_score` / `mechanical_share` / `effective_lines` | `dimensions` (las 3 aristas) |
| `edited_before_accept_ratio` | `edited_before_accept / (accepted_as_is + edited_before_accept)` |
| `core_tier_share` / `test_tier_share` | % de líneas agregadas en archivos tier core / test (`fileTier` de `@magicode/metrics`) |
| `logic_kind_share` / `test_kind_share` | `by_kind.logic / lines`, `by_kind.test / lines` |
| `tokens_total` | Σ `total_tokens` de la petición **y su cadena de regeneraciones** (imputación completa) |
| `tokens_per_effective_line` | `tokens_total / max(effective_lines, 1)` |
| `regenerations` / `latency_ms` | largo de la cadena `regenerates` / latencia de la petición |
| `session_acceptance_rate` | aceptados / propuestos en la sesión hasta este cambio (0.6 si falta) |
| `has_task` / `task_is_bug` | hay `task_key` / la tarea es Bug (`bug`, `defect`, `incident`, `hotfix`) |
| `branch_is_default` | rama = default declarada o `main/master/develop/trunk` |
| `hour_of_day` | hora **UTC** de aceptación |

## 3. Etiquetas con datos reales (`labels.py`, `export_dataset.py`)

`export_dataset.py` hace un **Scan paginado de DynamoDB** (`TABLE_NAME`) filtrado por `entity`
(`Change`, `AiRequest`, `Commit`, `Reference`, `Deployment`, `PullRequest`, `Task`, `TaskLink`, `Session`).
Se eligió Dynamo y no la réplica RDS porque el Processing Job corre fuera de la VPC (sin NAT) y
la RDS es privada; para tablas grandes conviene `ExportTableToPointInTime` a S3 (mismos ítems).

- **survival = 1** si el Change está `in_reference` (no existe un estado `deployed` en
  `ChangeListItem`), o trae `in_reference_at` / `deployed_at` / `reference_tags`, o su
  `commit_sha` está en `included_shas` de una Reference o tiene evidencia de despliegue: Deployment
  `success` **a producción** (`DEPLOY_PRODUCTION_ENVIRONMENTS`, por defecto `production,prod`) de
  su SHA o del `merge_sha`/`head_sha` de un PR cuya rama origen contiene el commit
  (`deployed_commit_shas`, misma regla que la API). **= 0** si pasaron 14 días sin llegar.
- **rework = 1** si hay señal explícita (`lines_rewritten_14d > 0`, ver propuestas), o un cambio
  aceptado posterior (≤ 14 días, mismo repo) que **viene de otra sesión o llega ≥ 24 h después**
  y **reescribe/borra líneas en los mismos archivos**, o una tarea **Bug** creada en esa ventana
  está enlazada (TaskLink `commit`) a commits que tocan esos archivos. La iteración dentro de la
  misma sesión (aceptar y ajustar al rato) **no** es retrabajo. **= 0** si pasaron 14 días sin señal.
- Filas dentro de la ventana sin señal positiva = **censuradas** (se excluyen; contarlas como 0
  sesgaría ambos modelos).
- El split es estratificado **y agrupado por sesión** (`StratifiedGroupKFold`): las features de
  sesión no se filtran entre train y test.

## 4. Datos sintéticos (`generate_synthetic.py`) — SIMULATED

~20k cambios en ~2.5k sesiones. Supuestos documentados en el docstring; los coeficientes viven en
`heuristic_weights.json` (fuente única para el generador **y** la heurística de la API):

- sesiones con un dev de **habilidad latente** no observable (techo de AUC realista);
- tiers por archivo (core 55 %, test 17 %, infra 8 %, docs 10 %, generated 10 %) y mezcla de kinds
  por Dirichlet según tier; importancia/mecánico/efectivas con las definiciones de `@magicode/metrics`;
- **survival** ↓ con redundancia y código mecánico; ↑ con core, logic, edición antes de aceptar,
  tasa de aceptación de la sesión y tarea enlazada; ↓ con regeneraciones;
- **rework** ↑ con core + logic + edición (lo que importa se vuelve a tocar), con el tamaño y sobre
  todo con **"grande y sin tests en core"**; ↑ tareas **Bug**, redundancia y horario nocturno;
  ↓ mecánico y tests;
- ruido latente N(0, 0.6) en el logit + **5 % de etiquetas invertidas** (errores de linaje/enlaces).

## 5. Entrenar y desplegar

```bash
cd ml
make setup            # venv .venv con requirements.txt (Python 3.11+, probado con 3.12)
make all              # features.json → dataset sintético → train → pytest
# equivalente:
python generate_synthetic.py --rows 20000 --out data/synthetic.csv
python train.py --data data/synthetic.csv --trained-on synthetic
python train.py --data data/real.csv --trained-on real          # CSV de export_dataset.py
```

macOS: xgboost necesita `libomp` (`brew install libomp`); sin él, el `Makefile` usa el libomp que
trae la wheel de scikit-learn vía `DYLD_FALLBACK_LIBRARY_PATH`.

Salidas de `train.py`: `model/<name>/xgboost-model` (sin nombres de features: el contenedor recibe
CSV sin cabecera) + `metrics.json` + `model_card.md`, y `model/feature-importance.json`, copiado a
`apps/api/src/modules/scoring/feature-importance.json` junto con `heuristic-weights.json`.

**Deploy** (igual que fraud-detector; lo hace el Processing Job, no CDK):

```bash
aws lambda invoke --function-name magicode-<env>-ml-retrain-trigger /dev/stdout
# overrides: --cli-binary-format raw-in-base64-out --payload '{"forceDeploy":true,"datasetSource":"synthetic"}'
```

`train.py --deploy` (variables en su docstring) por modelo: lee `scoring/<env>/<name>/metadata.json`
(lo que sirve HOY el endpoint) → decide → sube `model.tar.gz` → `create_model` →
`create_endpoint_config` (Serverless 1024 MB, concurrencia 5) → `create`/`update_endpoint`
`magicode-<env>-<name>` → espera `InService` → escribe `metadata.json` → actualiza
`SCORING_TRAINED_ON` / `SCORING_MODEL_VERSION` en la Lambda `magicode-<env>-api`.

Regla de deploy: `AUC ≥ MIN_AUC (0.65)` **y** mejora al endpoint actual (como fraud-detector), más:
un modelo **real** reemplaza a uno sintético aunque su AUC sea menor (no son comparables); uno
sintético **nunca** reemplaza a uno real; con datos reales el modelo debe **superar a la heurística**
(si no, el fallback es mejor). Diferencia con fraud-detector: `metadata.json` solo se escribe tras
desplegar (allí se escribía siempre y la comparación siguiente usaba un AUC no desplegado).

**Compatibilidad de versiones:** el Processing Job (contenedor sklearn 1.2-1) instala
`xgboost==1.7.6`, igual que fraud-detector, para servir con `sagemaker-xgboost:1.7-1`. Localmente se
usa 2.1.3; `--deploy` desde una máquina con 2.x se **rechaza** salvo que se defina
`XGBOOST_INFERENCE_IMAGE_URI` con una imagen compatible.

Infra: `infra/lib/ml-stack.ts` (`-c deployMl=true`; cron semanal con `-c mlRetrainSchedule=true`,
**deshabilitado por defecto**). Los endpoints no los crea ni borra CDK → limpieza manual:
`aws sagemaker delete-endpoint --endpoint-name magicode-<env>-survival` (ídem `rework`,
endpoint-configs y models `magicode-<env>-*`).

## 6. Costos (us-east-1, aproximados)

| pieza | costo |
|---|---|
| SageMaker Serverless Inference | **US$0 sin tráfico**; ≈ US$0.00002/s a 1 GB + US$0.016/GB procesado. 10k scorings/mes × 2 endpoints × ~50 ms ≈ **< US$0.05/mes** |
| Processing Job ml.t3.medium | ≈ US$0.05/h; una corrida ≈ 5–15 min (incluye esperar `InService`) ≈ **US$0.01** |
| S3 (código, modelos ~0.5 MB, metadata) | centavos |
| Lambda trigger | despreciable |

Cold start de Serverless: 1–5 s tras inactividad. Ver la nota del fallback.

## 7. Cómo puntúa la API (`apps/api/src/modules/scoring`)

- `scoringService.scoreChange({ change, ctx })` arma el vector (`scoring.features.ts`), invoca
  **en paralelo** `SCORING_SURVIVAL_ENDPOINT` y `SCORING_REWORK_ENDPOINT` (`text/csv`) con un
  presupuesto de **300 ms** (`SCORING_TIMEOUT_MS`) y AbortController.
- **Todo-o-nada**: cualquier error, timeout, respuesta fuera de 0..1, endpoint inexistente o SDK no
  disponible ⇒ ambos scores salen de `heuristic:v1` (`provenance: "estimated"`) y se abre un
  **circuit breaker** de 60 s (`SCORING_COOLDOWN_MS`) para no pagar el timeout en cada request.
- XGBoost ⇒ `model_version: "xgboost:<SCORING_MODEL_VERSION>"`, `provenance` `simulated` si
  `SCORING_TRAINED_ON` ≠ `real` (default conservador) o `estimated` si es `real`.
- `top_factors` (explican `rework_risk`): XGBoost ⇒ gain normalizado × |desviación robusta de la
  mediana de train| con la dirección monótona aprendida (tabla estática `feature-importance.json`;
  aproximación, no SHAP). Heurística ⇒ contribuciones exactas del logit.
- El SDK `@aws-sdk/client-sagemaker-runtime` **no** es dependencia: se carga con `require` perezoso
  del SDK v3 que trae el runtime Node 22 de Lambda (`require` respeta NODE_PATH →
  `/var/runtime/node_modules`; `import()` ESM no).
- ⚠ Con 300 ms, un endpoint **frío** casi siempre cae a la heurística. Si se quiere que el modelo
  sirva de verdad con poco tráfico: puntuar de forma asíncrona (stream/proyector) con
  `SCORING_TIMEOUT_MS=5000`, o Provisioned Concurrency en el endpoint (tiene costo fijo).

## 8. Métricas locales (dataset SINTÉTICO, seed 42, 20 000 filas)

Split agrupado por sesión: train ≈ 14.3k · val ≈ 2.9k · test ≈ 2.85k. xgboost 2.1.3,
`max_depth=3`, `learning_rate=0.03`, early stopping 80 rondas por AUC.

| modelo | tasa base | AUC-ROC | PR-AUC | logloss | Brier | ECE | best iter | heurística AUC / logloss |
|---|---|---|---|---|---|---|---|---|
| `survival` | 0.589 | **0.723** | 0.770 | 0.601 | 0.207 | 0.027 | 371 | 0.730 / 0.600 |
| `rework`   | 0.214 | **0.703** | 0.395 | 0.476 | 0.153 | 0.015 | 318 | 0.700 / 0.483 |

Lectura honesta:
- El techo es bajo **a propósito** (latente no observable + ruido + 5 % de etiquetas invertidas).
- XGBoost **empata** con la heurística: en datos sintéticos la heurística *es* la parte
  determinista del proceso generativo, así que no hay nada que la supere. El valor del XGBoost
  aparecerá (o no) con datos reales — por eso allí se exige superar a la heurística para desplegar.
- Bien calibrados (ECE < 0.03), lo que importa porque la criticidad usa el valor de `rework_risk`.
- Top gain — survival: `core_tier_share` ↑, `mechanical_share` ↓, `importance_score` ↑,
  `session_acceptance_rate` ↑, `redundancy_score` ↓. rework: `core_tier_share` ↑, `task_is_bug` ↑,
  `effective_lines` ↑, `accepted_added_lines` ↑, `test_tier_share` ↓.

## 9. Model card (resumen)

- **Uso previsto:** priorizar revisión de cambios IA (criticidad) y estimar supervivencia en el
  dashboard. **No** para evaluar personas: `session_acceptance_rate` es contexto, no una nota.
- **Datos:** hoy SIMULATED. Con datos reales: solo conteos/ratios/ids (sin código ni prompts).
- **Limitaciones:** linaje por hash de línea (aproximado); enlaces Jira incompletos subestiman
  rework; la ventana de 14 días retrasa las etiquetas; `top_factors` no es SHAP.
- Detalle por modelo: `model/<name>/model_card.md` (se sube a S3 junto a cada versión).

## 10. Tests

```bash
make test                                           # pytest: features, sintético, etiquetas, regla de deploy
cd ../apps/api && npx vitest run src/modules/scoring   # features, monotonía heurística, fallback
```

## 11. Propuestas para `@magicode/contracts` (no editado)

- `Change.lines_rewritten_14d` (o un evento `code.reworked`) para una etiqueta de rework directa.
- `ChangeScores.top_factors[].model: 'survival' | 'rework'` (hoy solo se explica `rework`).
- `ChangeScores.scored_at` y `ChangeScores.source: 'xgboost' | 'heuristic'` explícitos.
- Exponer `CRITICALITY_FORMULA` (exponentes/pesos) en contracts para que el dashboard la muestre.
