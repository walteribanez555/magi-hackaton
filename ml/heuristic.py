"""
Heurística determinista 'heuristic:v1' — espejo en Python de
apps/api/src/modules/scoring/scoring.heuristic.ts.

Sirve para tres cosas:
  1. generate_synthetic.py la usa como PARTE DETERMINISTA del proceso generativo
     (luego suma un factor latente "habilidad del dev" + ruido + ruido de etiqueta).
  2. train.py la usa como BASELINE: el XGBoost debe igualarla o superarla en AUC.
  3. La API la usa como FALLBACK cuando no hay endpoint SageMaker (misma fórmula, en TS).

Los pesos viven en ml/heuristic_weights.json (una sola fuente de verdad).
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Dict, Mapping

HERE = Path(__file__).resolve().parent
WEIGHTS_JSON = HERE / 'heuristic_weights.json'

with open(WEIGHTS_JSON, encoding='utf-8') as _f:
    WEIGHTS = json.load(_f)

VERSION: str = WEIGHTS['version']
LN21 = math.log(21.0)
LN41 = math.log(41.0)


def _clamp01(x: float) -> float:
    return min(1.0, max(0.0, x))


def sigmoid(z: float) -> float:
    if z >= 0:
        return 1.0 / (1.0 + math.exp(-z))
    e = math.exp(z)
    return e / (1.0 + e)


def terms(f: Mapping[str, float]) -> Dict[str, float]:
    """Términos derivados del vector de features (documentados en heuristic_weights.json)."""
    added = max(0.0, float(f['accepted_added_lines']))
    log1p_added = math.log1p(added)
    big = _clamp01((log1p_added - LN41) / 1.5)
    test_share = float(f['test_tier_share'])
    hour = int(f['hour_of_day'])
    return {
        'redundancy_score': float(f['redundancy_score']),
        'mechanical_share': float(f['mechanical_share']),
        'importance_score': float(f['importance_score']),
        'core_tier_share': float(f['core_tier_share']),
        'test_tier_share': test_share,
        'logic_kind_share': float(f['logic_kind_share']),
        'edited_before_accept_ratio': float(f['edited_before_accept_ratio']),
        'has_task': float(f['has_task']),
        'task_is_bug': float(f['task_is_bug']),
        'branch_is_default': float(f['branch_is_default']),
        'acceptance_centered': float(f['session_acceptance_rate']) - 0.6,
        'log_added': log1p_added - LN21,
        'log_regen': math.log1p(max(0.0, float(f['regenerations']))),
        'large_untested_core': float(f['core_tier_share']) * big * (1.0 - test_share) ** 2,
        'late_night': 1.0 if (hour >= 22 or hour <= 5) else 0.0,
    }


def logit(model: str, f: Mapping[str, float]) -> float:
    w = WEIGHTS[model]
    t = terms(f)
    return float(w['intercept']) + sum(float(c) * t[k] for k, c in w['coef'].items())


def predict(model: str, f: Mapping[str, float]) -> float:
    return sigmoid(logit(model, f))


def criticality_score(rework_risk: float, importance_score: float, tier_weight: float) -> float:
    """rework_risk^0.7 × exposure^0.3, exposure = 0.5·importance + 0.5·tier_weight (0..1)."""
    c = WEIGHTS['criticality']
    exposure = _clamp01(c['importance_weight'] * importance_score + c['tier_weight'] * tier_weight)
    return _clamp01(_clamp01(rework_risk) ** c['rework_exponent'] * exposure ** c['exposure_exponent'])


def criticality_level(score: float, thresholds: Mapping[str, float]) -> str:
    level = 'low'
    for name, th in sorted(thresholds.items(), key=lambda kv: kv[1]):
        if score >= th:
            level = name
    return level
