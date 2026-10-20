#!/usr/bin/env python3
"""
Pipeline de (re)entrenamiento del scoring MagiCode — mismo patrón que
walteribanez555/fraud-detector (ml/train.py):

  dataset → XGBoost (binary:logistic) → evaluación → si el AUC mejora al del endpoint actual
  → model.tar.gz a S3 → SageMaker Serverless `magicode-<env>-<name>` (create/update) →
  actualiza el entorno de la Lambda de la API.

Modelos (packages/contracts/src/scoring.ts):
  survival — P(cambio IA aceptado llega a la versión de referencia / despliegue)
  rework   — P(el cambio requiere retrabajo en ≤ 14 días) → base de la criticidad

Uso local (sin AWS):
  python generate_synthetic.py && python train.py
  python train.py --data data/real.csv --trained-on real
Dentro del Processing Job (lo lanza infra/lambda/ml-retrain-trigger.ts):
  python3 train.py --deploy

Variables de entorno
--------------------
ENVIRONMENT                   entorno (dev/staging/prod) → endpoint magicode-<env>-<name> (default: dev)
ML_BUCKET                     bucket S3 de datasets/modelos (obligatorio con --deploy)
SAGEMAKER_EXECUTION_ROLE_ARN  rol que asume SageMaker para servir el modelo (obligatorio con --deploy)
TABLE_NAME                    tabla DynamoDB para el dataset REAL (export_dataset.py)
DATASET_SOURCE                auto | dynamodb | s3 | synthetic   (default: auto)
S3_DATASET_KEY                CSV en ML_BUCKET si DATASET_SOURCE=s3
MIN_REAL_ROWS                 mínimo de filas reales etiquetadas; si no, cae a sintético (default: 1000)
MIN_AUC                       AUC mínimo para desplegar (default: 0.65)
FORCE_DEPLOY                  despliega aunque el AUC no mejore (default: false)
LAMBDA_FUNCTION_NAME          Lambda de la API a la que se le actualiza SCORING_TRAINED_ON/SCORING_MODEL_VERSION
XGBOOST_INFERENCE_IMAGE_URI   imagen de inferencia (default: sagemaker-xgboost:1.7-1 de la región)
SERVERLESS_MEMORY_MB          memoria del endpoint serverless (default: 1024)
SERVERLESS_MAX_CONCURRENCY    concurrencia máxima (default: 5)
AWS_DEFAULT_REGION            región (default: us-east-1)
"""

from __future__ import annotations  # el contenedor sklearn 1.2-1 trae Python 3.9

import argparse
import json
import logging
import os
import shutil
import sys
import tarfile
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# ── SageMaker Processing Job: instalar lo que no trae el contenedor sklearn ─────────
# Igual que fraud-detector: el contenedor sklearn ya trae pandas, numpy, scikit-learn y
# boto3; xgboost NO. Se fija 1.7.6 para que el artefacto lo cargue la imagen de inferencia
# sagemaker-xgboost:1.7-1 (y porque xgboost 2.x exige pandas ≥ 1.5).
if os.getenv('IS_SAGEMAKER_JOB'):
    import subprocess
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'xgboost==1.7.6', '-q'])

import numpy as np
import pandas as pd
import xgboost
from sklearn.metrics import average_precision_score, brier_score_loss, log_loss, roc_auc_score
from sklearn.model_selection import StratifiedGroupKFold, train_test_split
from xgboost import XGBClassifier

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import heuristic  # noqa: E402
from features import FEATURES, validate_frame  # noqa: E402

logging.basicConfig(level=logging.INFO, format='%(asctime)s  %(levelname)-8s  %(message)s', datefmt='%H:%M:%S')
log = logging.getLogger(__name__)

# ── Configuración ──────────────────────────────────────────────────────────────────
REGION        = os.getenv('AWS_DEFAULT_REGION', 'us-east-1')
ENVIRONMENT   = os.getenv('ENVIRONMENT', 'dev')
BUCKET        = os.getenv('ML_BUCKET', '')
SM_ROLE_ARN   = os.getenv('SAGEMAKER_EXECUTION_ROLE_ARN', '')
TABLE_NAME    = os.getenv('TABLE_NAME', '')
DATASET_SRC   = os.getenv('DATASET_SOURCE', 'auto')
DATASET_KEY   = os.getenv('S3_DATASET_KEY', f'scoring/{ENVIRONMENT}/dataset/real.csv')
MIN_REAL_ROWS = int(os.getenv('MIN_REAL_ROWS', '1000'))
MIN_AUC       = float(os.getenv('MIN_AUC', '0.65'))
FORCE_DEPLOY  = os.getenv('FORCE_DEPLOY', 'false').lower() == 'true'
LAMBDA_FN     = os.getenv('LAMBDA_FUNCTION_NAME', '')
SL_MEMORY_MB  = int(os.getenv('SERVERLESS_MEMORY_MB', '1024'))
SL_MAX_CONC   = int(os.getenv('SERVERLESS_MAX_CONCURRENCY', '5'))
S3_PREFIX     = f'scoring/{ENVIRONMENT}'

MODELS = ['survival', 'rework']
MIN_LABELED = 200  # por debajo, el AUC del test no significa nada
GROUP_COLS = ['session_id', 'session_idx']  # se agrupa por sesión: evita fuga entre splits
API_SCORING_DIR = HERE.parent / 'apps' / 'api' / 'src' / 'modules' / 'scoring'


def endpoint_name(model: str) -> str:
    return f'magicode-{ENVIRONMENT}-{model}'


# ── Dataset ────────────────────────────────────────────────────────────────────────

def load_dataset(args) -> Tuple[pd.DataFrame, str]:
    """Devuelve (df, trained_on) con trained_on ∈ {'real', 'synthetic'}."""
    src = args.source
    if args.data:
        log.info('Dataset CSV: %s (trained_on=%s)', args.data, args.trained_on)
        return pd.read_csv(args.data), args.trained_on

    if src in ('auto', 'dynamodb') and TABLE_NAME:
        from export_dataset import build_dataset, scan_entities
        try:
            df = build_dataset(scan_entities(TABLE_NAME, REGION))
        except Exception as e:  # noqa: BLE001 — en auto, sin acceso a Dynamo se sigue con sintético
            if src == 'dynamodb':
                raise
            log.warning('No se pudo leer DynamoDB (%s) → dataset SINTÉTICO', e)
            df = None
        if df is not None and (len(df) >= MIN_REAL_ROWS or src == 'dynamodb'):
            return df, 'real'
        if df is not None:
            log.warning('Solo %d filas reales etiquetadas (< MIN_REAL_ROWS=%d) → dataset SINTÉTICO',
                        len(df), MIN_REAL_ROWS)

    if src == 's3':
        import boto3
        log.info('Descargando s3://%s/%s', BUCKET, DATASET_KEY)
        with tempfile.NamedTemporaryFile(suffix='.csv') as tmp:
            boto3.client('s3', region_name=REGION).download_file(BUCKET, DATASET_KEY, tmp.name)
            return pd.read_csv(tmp.name), 'real'

    from generate_synthetic import generate
    log.warning('⚠ Entrenando con datos SIMULADOS (generate_synthetic.py, %d filas)', args.rows)
    return generate(args.rows, args.seed), 'synthetic'


def split(df: pd.DataFrame, label: str, seed: int):
    """Split estratificado 70/15/15; si hay columna de sesión, además AGRUPADO por sesión."""
    d = df.dropna(subset=[label]).reset_index(drop=True)
    y = d[label].astype(int).values
    group_col = next((c for c in GROUP_COLS if c in d.columns), None)
    if group_col is None:
        idx = np.arange(len(d))
        tmp, test = train_test_split(idx, test_size=0.15, stratify=y, random_state=seed)
        train, val = train_test_split(tmp, test_size=0.1765, stratify=y[tmp], random_state=seed)
    else:
        groups = d[group_col].astype(str).values
        sgk = StratifiedGroupKFold(n_splits=7, shuffle=True, random_state=seed)   # ≈ 14 % test
        tmp, test = next(sgk.split(d, y, groups))
        sgk2 = StratifiedGroupKFold(n_splits=6, shuffle=True, random_state=seed)  # ≈ 14 % val
        tr_i, va_i = next(sgk2.split(d.iloc[tmp], y[tmp], groups[tmp]))
        train, val = tmp[tr_i], tmp[va_i]
    X = d[FEATURES].astype(float)
    return (X.iloc[train], y[train]), (X.iloc[val], y[val]), (X.iloc[test], y[test]), group_col


# ── Entrenamiento ──────────────────────────────────────────────────────────────────

def train_model(X_train, y_train, X_val, y_val, seed: int) -> XGBClassifier:
    # Sin scale_pos_weight (a diferencia de fraud-detector): necesitamos probabilidades
    # CALIBRADAS porque la criticidad usa el valor de rework_risk, no solo el ranking.
    model = XGBClassifier(
        objective='binary:logistic',
        n_estimators=1500,
        max_depth=3,             # árboles poco profundos: 21 features tabulares, señal suave
        learning_rate=0.03,
        subsample=0.8,
        colsample_bytree=0.8,
        min_child_weight=20,
        reg_alpha=0.1,
        reg_lambda=2.0,
        eval_metric=['logloss', 'auc'],  # early stopping sobre el ÚLTIMO (auc)
        early_stopping_rounds=80,
        random_state=seed,
        n_jobs=-1,
    )
    model.fit(X_train, y_train, eval_set=[(X_val, y_val)], verbose=200)
    log.info('Best iteration: %d  |  Val AUC: %.4f', model.best_iteration, model.best_score)
    return model


# ── Evaluación ─────────────────────────────────────────────────────────────────────

def calibration_table(y, p, bins: int = 10) -> Tuple[List[dict], float]:
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(p, edges[1:-1]), 0, bins - 1)
    table, ece = [], 0.0
    for b in range(bins):
        m = idx == b
        if not m.any():
            continue
        mp, my = float(p[m].mean()), float(y[m].mean())
        ece += m.mean() * abs(mp - my)
        table.append({'bin': f'{edges[b]:.1f}-{edges[b + 1]:.1f}', 'n': int(m.sum()),
                      'mean_predicted': round(mp, 4), 'observed_rate': round(my, 4)})
    return table, float(ece)


def evaluate(name: str, model: XGBClassifier, X_test, y_test) -> dict:
    p = model.predict_proba(X_test)[:, 1]
    h = np.array([heuristic.predict(name, r) for r in X_test.to_dict('records')])
    calib, ece = calibration_table(y_test, p)
    m = {
        'auc': float(roc_auc_score(y_test, p)),
        'pr_auc': float(average_precision_score(y_test, p)),
        'logloss': float(log_loss(y_test, p)),
        'brier': float(brier_score_loss(y_test, p)),
        'ece': ece,
        'base_rate': float(np.mean(y_test)),
        'heuristic_auc': float(roc_auc_score(y_test, h)),
        'heuristic_logloss': float(log_loss(y_test, np.clip(h, 1e-6, 1 - 1e-6))),
        'n_test': int(len(y_test)),
        'calibration': calib,
    }
    log.info('[%s] Test AUC %.4f | PR-AUC %.4f | logloss %.4f | Brier %.4f | ECE %.4f | heurística AUC %.4f',
             name, m['auc'], m['pr_auc'], m['logloss'], m['brier'], m['ece'], m['heuristic_auc'])
    return m


def feature_importance(model: XGBClassifier, X_train: pd.DataFrame, X_test: pd.DataFrame) -> List[dict]:
    """Gain normalizado + mediana/escala de train + dirección (Spearman feature↔predicción)."""
    gain = model.get_booster().get_score(importance_type='gain')
    total = sum(gain.values()) or 1.0
    p = pd.Series(model.predict_proba(X_test)[:, 1], index=X_test.index)
    out = []
    for f in FEATURES:
        col = X_train[f]
        q25, q50, q75 = (float(v) for v in col.quantile([0.25, 0.5, 0.75]))
        scale = (q75 - q25) or float(col.std()) or 1.0
        rho = X_test[f].rank().corr(p.rank())
        out.append({
            'feature': f,
            'gain': round(gain.get(f, 0.0) / total, 6),
            'median': round(q50, 6),
            'scale': round(scale, 6),
            'direction': 'up' if (rho if rho == rho else 0.0) >= 0 else 'down',  # rho==rho: no NaN
        })
    out.sort(key=lambda r: -r['gain'])
    return out


# ── Artefactos locales ─────────────────────────────────────────────────────────────

def save_local(name: str, model: XGBClassifier, metrics: dict, importance: List[dict],
               out_dir: Path, trained_on: str, version: str) -> Path:
    d = out_dir / name
    d.mkdir(parents=True, exist_ok=True)
    booster = model.get_booster()
    # El contenedor recibe CSV sin cabecera → el artefacto NO lleva nombres de features
    # (si los lleva, la validación de nombres de XGBoost puede rechazar la predicción).
    booster.feature_names = None
    booster.feature_types = None
    model_path = d / 'xgboost-model'
    if xgboost.__version__.startswith('1.'):
        booster.save_model(str(model_path))  # 1.7 (Processing Job): formato nativo de la imagen 1.7-1
    else:
        # 2.x: JSON explícito (más portable que el UBJSON por defecto); el nombre sin extensión
        # es el que espera el contenedor → se guarda como .json y se renombra.
        tmp = d / 'xgboost-model.json'
        booster.save_model(str(tmp))
        tmp.replace(model_path)
    _selfcheck(model_path, model, metrics)

    (d / 'metrics.json').write_text(json.dumps({**metrics, 'model': name, 'trained_on': trained_on,
                                                'model_version': version, 'features': FEATURES,
                                                'feature_importance': importance}, indent=2))
    (d / 'model_card.md').write_text(model_card(name, metrics, importance, trained_on, version))
    log.info('[%s] artefactos → %s', name, d)
    return model_path


def _selfcheck(model_path: Path, model: XGBClassifier, metrics: dict) -> None:
    """Carga el artefacto como lo hace el contenedor (Booster + DMatrix sin nombres) y compara."""
    b = xgboost.Booster()
    b.load_model(str(model_path))
    rng = np.random.default_rng(0)
    x = rng.random((3, len(FEATURES))) * 10
    got = b.predict(xgboost.DMatrix(x))
    ref = model.get_booster().predict(xgboost.DMatrix(x))
    if not np.allclose(got, ref, atol=1e-6):
        raise RuntimeError('El artefacto guardado no reproduce las predicciones del modelo')


def model_card(name: str, m: dict, importance: List[dict], trained_on: str, version: str) -> str:
    purpose = {
        'survival': 'P(un cambio IA aceptado llega a la versión de referencia / despliegue)',
        'rework': 'P(el cambio requiere retrabajo en ≤ 14 días: líneas reescritas/borradas o Bug enlazado)',
    }[name]
    warn = ('> ⚠ **SIMULATED** — entrenado con `generate_synthetic.py`. Las métricas miden qué tan bien '
            'el modelo recupera los supuestos generativos, NO su desempeño en repos reales. La API '
            'marca sus puntuaciones con `provenance: "simulated"`.\n') if trained_on == 'synthetic' else ''
    top = '\n'.join(f'| {r["feature"]} | {r["gain"]:.3f} | {r["direction"]} |' for r in importance[:10])
    return f"""# Model card — `{name}` ({version})

{warn}
- **Objetivo:** {purpose}
- **Algoritmo:** XGBoost `binary:logistic` (xgboost {xgboost.__version__}), early stopping por AUC.
- **Datos:** `{trained_on}` · test n={m['n_test']} · tasa base {m['base_rate']:.3f}
- **Features:** {len(FEATURES)} en el orden de `SCORING_FEATURES` (ml/features.json).
- **Endpoint:** `{endpoint_name(name)}` (SageMaker Serverless, CSV sin cabecera).

## Métricas (test)

| métrica | modelo | heurística v1 |
|---|---|---|
| AUC-ROC | {m['auc']:.4f} | {m['heuristic_auc']:.4f} |
| PR-AUC | {m['pr_auc']:.4f} | – |
| logloss | {m['logloss']:.4f} | {m['heuristic_logloss']:.4f} |
| Brier | {m['brier']:.4f} | – |
| ECE (10 bins) | {m['ece']:.4f} | – |

## Top features (gain normalizado)

| feature | gain | dirección |
|---|---|---|
{top}

## Limitaciones

- Las etiquetas reales dependen del linaje por hash de líneas (aproximado) y de enlaces Jira.
- Cambios con < 14 días se excluyen (censurados): el modelo ve el pasado con retraso.
- `top_factors` en la API es una aproximación gain × desviación de la mediana, no SHAP.
"""


def export_api_artifacts(results: Dict[str, dict], trained_on: str, version: str,
                         out_dir: Path, api_dir: Optional[Path]) -> dict:
    """feature-importance.json (+ copia de heuristic-weights.json) para la API."""
    payload = {
        '$comment': 'GENERADO por ml/train.py — tabla estática de importancia (gain) para top_factors. No editar.',
        'model_version': version,
        'trained_on': trained_on,
        'xgboost_version': xgboost.__version__,
        'features': FEATURES,
        'models': {n: {'auc': round(r['metrics']['auc'], 4), 'features': r['importance']} for n, r in results.items()},
    }
    text = json.dumps(payload, indent=2, ensure_ascii=False) + '\n'
    (out_dir / 'feature-importance.json').write_text(text)
    if api_dir and api_dir.is_dir():
        (api_dir / 'feature-importance.json').write_text(text)
        weights = json.loads((HERE / 'heuristic_weights.json').read_text())
        weights['$comment'] = 'GENERADO por ml/train.py desde ml/heuristic_weights.json. ' + weights['$comment']
        (api_dir / 'heuristic-weights.json').write_text(json.dumps(weights, indent=2, ensure_ascii=False) + '\n')
        log.info('API → %s/{feature-importance,heuristic-weights}.json', api_dir)
    return payload


# ── Metadata del endpoint actual (S3) ───────────────────────────────────────────────

def get_current_metadata(s3, name: str) -> Optional[dict]:
    key = f'{S3_PREFIX}/{name}/metadata.json'
    try:
        return json.loads(s3.get_object(Bucket=BUCKET, Key=key)['Body'].read())
    except s3.exceptions.NoSuchKey:
        return None
    except Exception as e:  # noqa: BLE001
        log.warning('No se pudo leer %s: %s', key, e)
        return None


def decide_deploy(new_auc: float, trained_on: str, current: Optional[dict],
                  heuristic_auc: Optional[float] = None) -> Tuple[bool, str]:
    """Regla de fraud-detector (AUC ≥ MIN_AUC y mejora al endpoint actual) + dos guardas:
    no reemplazar un modelo real por uno sintético, y con datos reales exigir superar a la
    heurística (si no, el fallback de la API es mejor que el modelo). Con datos sintéticos la
    heurística ES el proceso generativo, así que esa comparación no aplica."""
    if FORCE_DEPLOY:
        return True, 'FORCE_DEPLOY=true'
    if new_auc < MIN_AUC:
        return False, f'AUC {new_auc:.4f} < MIN_AUC {MIN_AUC}'
    if trained_on == 'real' and heuristic_auc is not None and new_auc <= heuristic_auc:
        return False, f'AUC {new_auc:.4f} no supera a la heurística ({heuristic_auc:.4f})'
    if current is None:
        return True, 'no hay endpoint previo'
    cur_on, cur_auc = current.get('trained_on', 'synthetic'), float(current.get('auc_test', 0))
    if cur_on == 'real' and trained_on == 'synthetic':
        return False, 'el endpoint actual está entrenado con datos reales; no se reemplaza por sintético'
    if cur_on == 'synthetic' and trained_on == 'real':
        return True, 'primer modelo con datos reales (AUC no comparable con el sintético)'
    if new_auc > cur_auc:
        return True, f'AUC {new_auc:.4f} > actual {cur_auc:.4f}'
    return False, f'AUC {new_auc:.4f} no mejora al actual {cur_auc:.4f}'


def package_and_upload(s3, name: str, model_path: Path, version: str) -> str:
    prefix = f'{S3_PREFIX}/{name}/{version}'
    with tempfile.TemporaryDirectory() as tmp:
        tar_path = Path(tmp) / 'model.tar.gz'
        with tarfile.open(tar_path, 'w:gz') as tar:
            tar.add(str(model_path), arcname='xgboost-model')
        s3.upload_file(str(tar_path), BUCKET, f'{prefix}/model.tar.gz')
    for f in ('metrics.json', 'model_card.md'):
        s3.upload_file(str(model_path.parent / f), BUCKET, f'{prefix}/{f}')
    uri = f's3://{BUCKET}/{prefix}/model.tar.gz'
    log.info('[%s] modelo subido: %s', name, uri)
    return uri


def inference_image() -> str:
    override = os.getenv('XGBOOST_INFERENCE_IMAGE_URI')
    if override:
        return override
    if not xgboost.__version__.startswith('1.7'):
        raise RuntimeError(
            f'xgboost {xgboost.__version__} local ≠ imagen sagemaker-xgboost:1.7-1. Despliega desde el '
            'Processing Job (instala 1.7.6) o define XGBOOST_INFERENCE_IMAGE_URI con una imagen compatible.')
    # 683313688378 = cuenta de imágenes SageMaker en us-east-1 (igual que fraud-detector);
    # en otras regiones la cuenta cambia → usar XGBOOST_INFERENCE_IMAGE_URI.
    return f'683313688378.dkr.ecr.{REGION}.amazonaws.com/sagemaker-xgboost:1.7-1'


def deploy_endpoint(sm, name: str, s3_model_uri: str, version: str) -> None:
    ep = endpoint_name(name)
    model_name = f'{ep}-{version}'
    config_name = f'{ep}-config-{version}'
    sm.create_model(
        ModelName=model_name,
        PrimaryContainer={'Image': inference_image(), 'ModelDataUrl': s3_model_uri},
        ExecutionRoleArn=SM_ROLE_ARN,
    )
    sm.create_endpoint_config(
        EndpointConfigName=config_name,
        ProductionVariants=[{
            'VariantName': 'AllTraffic',
            'ModelName': model_name,
            'ServerlessConfig': {'MemorySizeInMB': SL_MEMORY_MB, 'MaxConcurrency': SL_MAX_CONC},
        }],
    )
    try:
        sm.describe_endpoint(EndpointName=ep)
        sm.update_endpoint(EndpointName=ep, EndpointConfigName=config_name)
        log.info('[%s] endpoint actualizado: %s', name, ep)
    except sm.exceptions.ClientError as e:
        if 'Could not find endpoint' not in str(e):
            raise
        sm.create_endpoint(EndpointName=ep, EndpointConfigName=config_name)
        log.info('[%s] endpoint creado: %s', name, ep)

    log.info('[%s] esperando InService…', name)
    while True:
        status = sm.describe_endpoint(EndpointName=ep)['EndpointStatus']
        if status == 'InService':
            break
        if status in ('Failed', 'RollingBack', 'OutOfService'):
            raise RuntimeError(f'Endpoint {ep} falló: {status}')
        time.sleep(20)
    log.info('[%s] endpoint listo: %s', name, ep)


def update_lambda_env(lam, trained_on: str, version: str) -> None:
    """Como fraud-detector: la API lee la procedencia/versión de su entorno.
    Nota: un `cdk deploy` posterior reescribe el entorno → la API vuelve al default
    conservador (SCORING_TRAINED_ON=synthetic ⇒ provenance 'simulated')."""
    cfg = lam.get_function_configuration(FunctionName=LAMBDA_FN)
    env = cfg.get('Environment', {}).get('Variables', {})
    env['SCORING_TRAINED_ON'] = trained_on
    env['SCORING_MODEL_VERSION'] = version
    lam.update_function_configuration(FunctionName=LAMBDA_FN, Environment={'Variables': env})
    log.info('Lambda %s → SCORING_TRAINED_ON=%s SCORING_MODEL_VERSION=%s', LAMBDA_FN, trained_on, version)


def write_summary(results: Dict[str, dict], trained_on: str) -> None:
    lines = [f'## MagiCode scoring — reentrenamiento ({trained_on})', '',
             '| modelo | AUC | PR-AUC | logloss | heurística AUC | deploy |',
             '|---|---|---|---|---|---|']
    for n, r in results.items():
        m = r['metrics']
        lines.append(f"| {n} | **{m['auc']:.4f}** | {m['pr_auc']:.4f} | {m['logloss']:.4f} | "
                     f"{m['heuristic_auc']:.4f} | {'sí' if r.get('deployed') else 'no'} — {r.get('reason', 'sin --deploy')} |")
    text = '\n'.join(lines) + '\n'
    log.info('\n%s', text)
    path = os.getenv('GITHUB_STEP_SUMMARY', '')
    if path:
        with open(path, 'a') as f:
            f.write(text)


# ── Main ───────────────────────────────────────────────────────────────────────────

def parse_args(argv: Optional[List[str]] = None):
    ap = argparse.ArgumentParser(description='Entrena (y opcionalmente despliega) los modelos de scoring')
    ap.add_argument('--data', help='CSV con FEATURES + survival + rework')
    ap.add_argument('--trained-on', choices=['synthetic', 'real'], default='synthetic',
                    help='procedencia del CSV de --data (default conservador: synthetic)')
    ap.add_argument('--source', choices=['auto', 'dynamodb', 's3', 'synthetic'], default=DATASET_SRC)
    ap.add_argument('--rows', type=int, default=20_000, help='filas sintéticas si no hay datos')
    ap.add_argument('--seed', type=int, default=42)
    ap.add_argument('--models', default=','.join(MODELS))
    ap.add_argument('--out-dir', default=str(HERE / 'model'))
    ap.add_argument('--api-dir', default=str(API_SCORING_DIR),
                    help='carpeta del módulo scoring de la API (se omite si no existe)')
    ap.add_argument('--no-api-export', action='store_true')
    ap.add_argument('--deploy', action='store_true', help='sube a S3 y crea/actualiza los endpoints')
    return ap.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> Dict[str, dict]:
    args = parse_args(argv)
    np.random.seed(args.seed)
    if args.deploy and (not BUCKET or not SM_ROLE_ARN):
        log.error('--deploy requiere ML_BUCKET y SAGEMAKER_EXECUTION_ROLE_ARN')
        sys.exit(1)

    # 1. Dataset
    df, trained_on = load_dataset(args)
    validate_frame(df)
    version = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    log.info('Dataset: %d filas · trained_on=%s · versión %s', len(df), trained_on, version)

    # 2-4. Split + entrenamiento + evaluación por modelo
    results: Dict[str, dict] = {}
    for name in [m.strip() for m in args.models.split(',') if m.strip()]:
        labeled = df[name].dropna()
        if len(labeled) < MIN_LABELED or labeled.nunique() < 2 or labeled.value_counts().min() < 20:
            log.warning('[%s] omitido: %d filas etiquetadas / clases %s (mínimo %d filas y 20 por clase)',
                        name, len(labeled), labeled.value_counts().to_dict(), MIN_LABELED)
            continue
        (Xtr, ytr), (Xva, yva), (Xte, yte), group_col = split(df, name, args.seed)
        log.info('[%s] split train=%d val=%d test=%d (agrupado por %s)', name, len(ytr), len(yva), len(yte),
                 group_col or '—')
        model = train_model(Xtr, ytr, Xva, yva, args.seed)
        metrics = evaluate(name, model, Xte, yte)
        metrics.update({'best_iteration': int(model.best_iteration), 'n_train': int(len(ytr)),
                        'n_val': int(len(yva)), 'xgboost_version': xgboost.__version__})
        importance = feature_importance(model, Xtr, Xte)
        model_path = save_local(name, model, metrics, importance, out_dir, trained_on, version)
        results[name] = {'metrics': metrics, 'importance': importance, 'model_path': model_path}

    # 5. Artefactos para la API (tabla estática de gain → top_factors)
    export_api_artifacts(results, trained_on, version, out_dir,
                         None if args.no_api_export else Path(args.api_dir))

    # 6. Deploy (igual que fraud-detector: solo si el AUC mejora al del endpoint actual)
    if args.deploy:
        import boto3
        s3 = boto3.client('s3', region_name=REGION)
        sm = boto3.client('sagemaker', region_name=REGION)
        s3.upload_file(str(out_dir / 'feature-importance.json'), BUCKET, f'{S3_PREFIX}/runs/{version}/feature-importance.json')
        deployed_any = False
        for name, r in results.items():
            current = get_current_metadata(s3, name)
            ok, reason = decide_deploy(r['metrics']['auc'], trained_on, current, r['metrics']['heuristic_auc'])
            r['reason'] = reason
            uri = package_and_upload(s3, name, r['model_path'], version)
            if not ok:
                log.info('[%s] deploy omitido — %s', name, reason)
                continue
            deploy_endpoint(sm, name, uri, version)
            meta = {'model': name, 'endpoint': endpoint_name(name), 'model_version': version,
                    'trained_on': trained_on, 'auc_test': r['metrics']['auc'],
                    'pr_auc_test': r['metrics']['pr_auc'], 'n_test': r['metrics']['n_test'],
                    's3_model_uri': uri, 'feature_columns': FEATURES,
                    'deployed_at': datetime.now(timezone.utc).isoformat()}
            # metadata.json = lo que sirve el endpoint HOY (solo se escribe tras desplegar)
            s3.put_object(Bucket=BUCKET, Key=f'{S3_PREFIX}/{name}/metadata.json',
                          Body=json.dumps(meta, indent=2).encode())
            r['deployed'] = True
            deployed_any = True

        if deployed_any and LAMBDA_FN:
            metas = [get_current_metadata(s3, n) or {} for n in MODELS]
            on = 'real' if all(m.get('trained_on') == 'real' for m in metas) else 'synthetic'
            ver = max((m.get('model_version', '') for m in metas), default=version)
            update_lambda_env(boto3.client('lambda', region_name=REGION), on, ver)

    write_summary(results, trained_on)
    if not args.deploy:
        log.info('Sin --deploy: nada se subió a AWS. Artefactos en %s', out_dir)
    log.info('Done.')
    return results


if __name__ == '__main__':
    main()
