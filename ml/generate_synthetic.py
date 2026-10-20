#!/usr/bin/env python3
"""
Dataset SINTÉTICO (SIMULATED) de cambios IA aceptados con etiquetas survival / rework.

⚠ SIMULADO: no proviene de ningún repositorio real. Sirve para (a) probar la tubería
completa de entrenamiento/deploy y (b) arrancar con un modelo razonable mientras no hay
historia real. Todo modelo entrenado con esto se etiqueta `trained_on=synthetic` y la API
reporta sus puntuaciones con provenance='simulated'.

Supuestos generativos (documentados; los coeficientes viven en heuristic_weights.json):

  Estructura
  - Sesiones de 1 + Poisson(7) cambios; cada sesión tiene un dev con habilidad latente
    s ~ N(0,1) (NO observable: el modelo no la ve → techo de AUC realista).
  - session_acceptance_rate ~ Beta con media sigmoid(0.45 + 0.6·s).
  - 60 % de sesiones con tarea Jira; 25 % de esas son Bug. 30 % trabaja en la rama default.
  - Hora UTC: mezcla 10 h / 15 h (σ≈2 h) + 7 % nocturno.
  - Archivos por cambio: 1 + Poisson(0.9). Tier por archivo: core 55 %, test 17 %, infra 8 %,
    docs 10 %, generated 10 %. Líneas por archivo ~ LogNormal(2.3, 1.0) (generated: (3.5, 1.2)).
  - Mezcla de kinds por archivo ~ Dirichlet con α dependiente del tier (core: mucho logic;
    test: mucho test; infra: config; docs: comment; generated: config/trivial).
  - importance, mechanical_share, logic/test share y effective_lines se calculan con las
    MISMAS definiciones que @magicode/metrics (pesos kind × tier de dimensions.ts).
  - Redundancia: Beta(1.2, 9) (≈12 %); 12 % de los cambios son "copy-paste" Beta(4, 3);
    regenerar sube la redundancia. Regeneraciones ~ Poisson(0.35, +0.3 si s < −0.5).
  - Editado antes de aceptar: P = sigmoid(−0.8 + 0.4·s); si edita, ratio ~ Beta(2, 4).
  - Tokens: prompt ~ LogNormal(ln 2500, 0.6); completion ≈ 12·líneas + 150; ×(1+regeneraciones).
    Latencia ≈ 600 ms + 15 ms/token de completion.

  Etiquetas (logit = heurística determinista + latente + ruido)
  - survival: ↓ redundancia y ↓ mecánico (lo duplicado/boilerplate se descarta o se reescribe
    antes del tag); ↑ core, ↑ logic, ↑ editado antes de aceptar (el humano se involucró),
    ↑ tasa de aceptación de la sesión, ↑ tarea enlazada; ↓ regeneraciones.
    z = h_survival(x) + 0.35·s + N(0, 0.6)
  - rework: ↑ core + logic + editado (código que importa → se toca de nuevo), ↑ tamaño, y
    sobre todo ↑ "grande y sin tests en core"; ↑ tarea Bug; ↑ redundancia; ↓ mecánico;
    ↓ tests; ↑ nocturno. z = h_rework(x) − 0.30·s + N(0, 0.6)
  - Ruido de etiqueta: se invierte el 5 % de las etiquetas (configurable con --label-noise).

Uso:
  python generate_synthetic.py --rows 20000 --seed 42 --out data/synthetic.csv
"""

from __future__ import annotations

import argparse
import logging
import math
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from features import FEATURES, KIND_WEIGHTS, KINDS, MECHANICAL_KINDS, TIER_WEIGHTS, TIERS
from heuristic import logit as heuristic_logit

log = logging.getLogger(__name__)

TIER_PROBS = {'core': 0.55, 'test': 0.17, 'infra': 0.08, 'docs': 0.10, 'generated': 0.10}

# α de Dirichlet por tier, en el orden de KINDS:
#                logic decl  test  config comment import trivial
KIND_ALPHA: Dict[str, List[float]] = {
    'core':      [5.0,  2.0,  0.2,  0.3,   1.0,    1.2,   2.0],
    'test':      [1.0,  0.8,  6.0,  0.2,   0.5,    1.0,   2.0],
    'infra':     [1.0,  0.5,  0.1,  5.0,   1.0,    0.3,   1.0],
    'docs':      [0.1,  0.1,  0.05, 0.3,   6.0,    0.05,  0.3],
    'generated': [1.0,  0.5,  0.1,  2.0,   0.2,    1.0,   2.0],
}
KW = np.array([KIND_WEIGHTS[k] for k in KINDS])
MECH_MASK = np.array([k in MECHANICAL_KINDS for k in KINDS])

SURVIVAL_SKILL = 0.35
REWORK_SKILL = -0.30
LATENT_NOISE_SD = 0.6
DEFAULT_LABEL_NOISE = 0.05


def _sigmoid(z):
    return 1.0 / (1.0 + np.exp(-z))


def _hour(rng: np.random.Generator) -> int:
    if rng.random() < 0.07:
        return int(rng.integers(0, 6)) if rng.random() < 0.7 else int(rng.integers(22, 24))
    center = 10 if rng.random() < 0.5 else 15
    return int(np.clip(round(rng.normal(center, 2.0)), 0, 23))


def _change(rng: np.random.Generator, skill: float, sess: dict) -> Dict[str, float]:
    """Un cambio aceptado → features (mismas definiciones que @magicode/metrics)."""
    n_files = int(min(15, 1 + rng.poisson(0.9)))
    tiers = rng.choice(TIERS, size=n_files, p=[TIER_PROBS[t] for t in TIERS])

    regen = int(min(6, rng.poisson(0.35 + (0.3 if skill < -0.5 else 0.0))))
    if rng.random() < 0.12:  # modo copy-paste
        redundancy = rng.beta(4, 3)
    else:
        redundancy = rng.beta(1.2, 9)
    redundancy = float(np.clip(redundancy + 0.03 * regen, 0, 1))

    added_total = 0.0
    imp_sum = mech_sum = logic_sum = test_sum = eff_sum = 0.0
    tier_lines = {t: 0.0 for t in TIERS}
    for tier in tiers:
        if tier == 'generated':
            lines = rng.lognormal(3.5, 1.2)
        else:
            lines = rng.lognormal(2.3, 1.0)
        lines = float(np.clip(round(lines), 1, 500))
        mix = rng.dirichlet(KIND_ALPHA[tier])
        tw = TIER_WEIGHTS[tier]
        imp_f = float((mix * KW).sum() * tw)
        mech_f = 1.0 if tier == 'generated' else float(mix[MECH_MASK].sum())
        eff_f = 0.0 if tier == 'generated' else float((mix * KW)[~MECH_MASK].sum() * tw)
        added_total += lines
        tier_lines[tier] += lines
        imp_sum += lines * imp_f
        mech_sum += lines * mech_f
        logic_sum += lines * mix[KINDS.index('logic')]
        test_sum += lines * mix[KINDS.index('test')]
        eff_sum += lines * eff_f * (1.0 - redundancy)

    deleted = 0.0 if rng.random() < 0.55 else float(round(added_total * rng.beta(1.2, 3)))
    p_edit = 1.0 / (1.0 + math.exp(-(-0.8 + 0.4 * skill)))
    edited_ratio = float(rng.beta(2, 4)) if rng.random() < p_edit else 0.0

    effective = round(eff_sum, 2)
    prompt = rng.lognormal(math.log(2500), 0.6)
    completion = 12 * added_total * rng.lognormal(0, 0.3) + 150
    tokens = float(round((prompt + completion) * (1 + regen)))
    latency = float(round(600 + completion * 15 * rng.lognormal(0, 0.25)))

    row = {
        'accepted_added_lines': added_total,
        'accepted_deleted_lines': deleted,
        'files_count': float(n_files),
        'importance_score': round(imp_sum / added_total, 4),
        'redundancy_score': round(redundancy, 4),
        'mechanical_share': round(mech_sum / added_total, 4),
        'effective_lines': effective,
        'edited_before_accept_ratio': round(edited_ratio, 4),
        'core_tier_share': round(tier_lines['core'] / added_total, 4),
        'test_tier_share': round(tier_lines['test'] / added_total, 4),
        'logic_kind_share': round(logic_sum / added_total, 4),
        'test_kind_share': round(test_sum / added_total, 4),
        'tokens_total': tokens,
        'tokens_per_effective_line': round(tokens / max(effective, 1.0), 2),
        'regenerations': float(regen),
        'latency_ms': latency,
        'session_acceptance_rate': round(sess['acceptance'], 4),
        'has_task': sess['has_task'],
        'task_is_bug': sess['task_is_bug'],
        'branch_is_default': sess['branch_is_default'],
        'hour_of_day': float(int(np.clip(sess['hour'] + rng.integers(-1, 2), 0, 23))),
    }
    return row


def generate(rows: int = 20_000, seed: int = 42, label_noise: float = DEFAULT_LABEL_NOISE) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    records: List[Dict[str, float]] = []
    session_idx = 0
    while len(records) < rows:
        skill = float(rng.normal())
        mean_acc = 1.0 / (1.0 + math.exp(-(0.45 + 0.6 * skill)))
        has_task = 1.0 if rng.random() < 0.6 else 0.0
        sess = {
            'acceptance': float(rng.beta(mean_acc * 8, (1 - mean_acc) * 8)),
            'has_task': has_task,
            'task_is_bug': 1.0 if (has_task and rng.random() < 0.25) else 0.0,
            'branch_is_default': 1.0 if rng.random() < 0.3 else 0.0,
            'hour': _hour(rng),
        }
        for _ in range(1 + rng.poisson(7)):
            if len(records) >= rows:
                break
            f = _change(rng, skill, sess)
            z_s = heuristic_logit('survival', f) + SURVIVAL_SKILL * skill + rng.normal(0, LATENT_NOISE_SD)
            z_r = heuristic_logit('rework', f) + REWORK_SKILL * skill + rng.normal(0, LATENT_NOISE_SD)
            y_s = int(rng.random() < _sigmoid(z_s))
            y_r = int(rng.random() < _sigmoid(z_r))
            # Ruido de etiqueta: errores de linaje git / tareas mal enlazadas
            if rng.random() < label_noise:
                y_s = 1 - y_s
            if rng.random() < label_noise:
                y_r = 1 - y_r
            records.append({**f, 'survival': y_s, 'rework': y_r, 'session_idx': session_idx})
        session_idx += 1

    df = pd.DataFrame.from_records(records)
    df = df[FEATURES + ['survival', 'rework', 'session_idx']]
    df.attrs['provenance'] = 'simulated'
    return df


def main(argv: Optional[List[str]] = None) -> None:
    logging.basicConfig(level=logging.INFO, format='%(asctime)s  %(levelname)-8s  %(message)s', datefmt='%H:%M:%S')
    ap = argparse.ArgumentParser(description='Genera el dataset SINTÉTICO (SIMULATED) de scoring MagiCode')
    ap.add_argument('--rows', type=int, default=20_000)
    ap.add_argument('--seed', type=int, default=42)
    ap.add_argument('--label-noise', type=float, default=DEFAULT_LABEL_NOISE)
    ap.add_argument('--out', default=str(Path(__file__).resolve().parent / 'data' / 'synthetic.csv'))
    args = ap.parse_args(argv)

    df = generate(args.rows, args.seed, args.label_noise)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(out, index=False)
    log.info('SIMULATED dataset → %s  (%d filas, survival=%.1f%%, rework=%.1f%%)',
             out, len(df), 100 * df['survival'].mean(), 100 * df['rework'].mean())


if __name__ == '__main__':
    main()
