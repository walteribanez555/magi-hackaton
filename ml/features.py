"""
Features de scoring MagiCode — espejo en Python de apps/api/src/modules/scoring/scoring.features.ts.

El ORDEN de columnas sale de ml/features.json, generado desde @magicode/contracts
(SCORING_FEATURES) con `node scripts/export-scoring-features.mjs`. Nunca se escribe a mano:
el contenedor XGBoost de SageMaker recibe CSV SIN cabecera, así que el orden ES el contrato.

Definiciones (idénticas en TS):
  accepted_added_lines        líneas agregadas no vacías aceptadas
  accepted_deleted_lines      líneas borradas aceptadas
  files_count                 nº de archivos del cambio
  importance_score            dimensions.importance.score (0..1)
  redundancy_score            dimensions.redundancy.score (0..1)
  mechanical_share            dimensions.automation.mechanical_share (0..1)
  effective_lines             dimensions.effective_lines
  edited_before_accept_ratio  edited_before_accept / (accepted_as_is + edited_before_accept); 0 si no hay datos
  core_tier_share             Σ added en archivos tier core / Σ added
  test_tier_share             Σ added en archivos tier test / Σ added
  logic_kind_share            by_kind.logic / importance.lines
  test_kind_share             by_kind.test  / importance.lines
  tokens_total                tokens de la petición IA que originó el cambio
  tokens_per_effective_line   tokens_total / max(effective_lines, 1)
  regenerations               nº de regeneraciones de la petición (cadena `regenerates`)
  latency_ms                  latencia de la petición IA
  session_acceptance_rate     aceptados / propuestos en la sesión al momento del cambio (0..1); 0.6 si falta
  has_task                    1 si el cambio tiene task_key
  task_is_bug                 1 si la tarea es de tipo Bug
  branch_is_default           1 si la rama es la default (main/master/develop/trunk)
  hour_of_day                 hora UTC (0..23) de occurred_at
"""

from __future__ import annotations  # train.py corre en Python 3.9 dentro del contenedor sklearn

import json
import math
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional

HERE = Path(__file__).resolve().parent
FEATURES_JSON = HERE / 'features.json'


def _load_features_spec() -> dict:
    with open(FEATURES_JSON, encoding='utf-8') as f:
        return json.load(f)


_SPEC = _load_features_spec()

# Orden fijo de columnas (= SCORING_FEATURES de contracts).
FEATURES: List[str] = list(_SPEC['features'])
CRITICALITY_THRESHOLDS: Dict[str, float] = dict(_SPEC['criticality_thresholds'])

# Pesos por defecto de las aristas (espejo de packages/contracts/src/dimensions.ts).
KIND_WEIGHTS: Dict[str, float] = {
    'logic': 1.0, 'declaration': 0.8, 'test': 0.7, 'config': 0.4,
    'comment': 0.2, 'import': 0.1, 'trivial': 0.0,
}
KINDS: List[str] = list(KIND_WEIGHTS)
MECHANICAL_KINDS = {'import', 'trivial'}
TIER_WEIGHTS: Dict[str, float] = {
    'core': 1.0, 'test': 0.9, 'infra': 0.7, 'docs': 0.3, 'generated': 0.0,
}
TIERS: List[str] = list(TIER_WEIGHTS)

DEFAULT_BRANCHES = {'main', 'master', 'develop', 'trunk'}
NEUTRAL_ACCEPTANCE = 0.6  # imputación si falta session_acceptance_rate (igual en TS)
BUG_TYPES = {'bug', 'defect', 'incident', 'hotfix'}


# ── Tier de archivo (espejo de fileTier en packages/metrics/src/classify.ts) ─────────

_LOCKFILES = {
    'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock',
    'cargo.lock', 'poetry.lock', 'pipfile.lock', 'uv.lock', 'gemfile.lock', 'composer.lock', 'go.sum',
    'flake.lock', 'packages.lock.json', 'podfile.lock', 'mix.lock', 'pubspec.lock',
}
_GENERATED_DIRS = re.compile(
    r'(^|/)(dist|build|out|coverage|node_modules|\.next|\.nuxt|\.turbo|target/(debug|release)|__generated__|generated)/')
_GENERATED_FILES = re.compile(
    r'(\.g\.[^/]+|\.generated\.[^/]+|\.min\.(js|css)|\.map|\.snap|\.pb\.go|_pb2\.pyi?|\.d\.ts\.map|_generated\.\w+)$')
_TEST_FILES = re.compile(
    r'(\.(test|spec)\.[^/]+|_test\.(go|py|rb|exs?)|_spec\.rb|(^|/)test_[^/]+\.py|Tests?\.(cs|java|kt|swift))$')
_TEST_DIRS = re.compile(r'(^|/)(tests?|__tests__|__mocks__|spec|specs|e2e|cypress|playwright|testdata|fixtures)/')
_INFRA = re.compile(
    r'(^|/)(infra|infrastructure|terraform|deploy|deployment|k8s|kubernetes|helm|charts|ansible|\.github|\.gitlab'
    r'|\.circleci|\.buildkite)/|(^|/)(dockerfile[^/]*|containerfile|docker-compose[^/]*\.ya?ml|compose\.ya?ml'
    r'|jenkinsfile|\.gitlab-ci\.yml|azure-pipelines\.yml|buildspec\.ya?ml|serverless\.ya?ml|template\.ya?ml'
    r'|samconfig\.toml|cdk\.json|procfile|vercel\.json|netlify\.toml|fly\.toml)$|\.(tf|tfvars|hcl)$')
_DOCS = re.compile(
    r'(^|/)(docs?|documentation)/|\.(md|mdx|markdown|rst|adoc|txt)$'
    r'|(^|/)(readme|changelog|license|contributing|authors|notice)(\.[^/]*)?$')


def file_tier(path: str) -> str:
    """Tier por ruta. Precedencia generated → test → infra → docs → core (igual que TS)."""
    p = re.sub(r'^\./', '', path.replace('\\', '/'))
    lower = p.lower()
    base = lower.rsplit('/', 1)[-1]
    if (base in _LOCKFILES or _GENERATED_DIRS.search(lower) or _GENERATED_FILES.search(lower)
            or re.search(r'(^|/)__snapshots__/', lower)):
        return 'generated'
    if _TEST_FILES.search(p) or _TEST_FILES.search(lower) or _TEST_DIRS.search(lower):
        return 'test'
    if _INFRA.search(lower):
        return 'infra'
    if _DOCS.search(lower):
        return 'docs'
    return 'core'


# ── Construcción del vector ─────────────────────────────────────────────────────────

def _num(v: Any, default: float = 0.0) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if math.isfinite(f) else default


def _ratio(num: float, den: float) -> float:
    return num / den if den > 0 else 0.0


def _clamp01(x: float) -> float:
    return min(1.0, max(0.0, x))


def tier_shares(files: Iterable[Mapping[str, Any]]) -> Dict[str, float]:
    """% de líneas agregadas por tier (ponderado por `added`)."""
    totals = {t: 0.0 for t in TIERS}
    for f in files:
        totals[file_tier(str(f.get('path', '')))] += _num(f.get('added'))
    s = sum(totals.values())
    return {t: _ratio(v, s) for t, v in totals.items()}


def hour_of_day(iso: Optional[str]) -> int:
    if not iso:
        return 12
    try:
        dt = datetime.fromisoformat(str(iso).replace('Z', '+00:00'))
    except ValueError:
        return 12
    if dt.utcoffset() is not None:
        dt = dt - dt.utcoffset()  # a UTC
    return dt.hour


def change_files(change: Mapping[str, Any]) -> List[Mapping[str, Any]]:
    """Archivos del cambio: payload code.accepted (`files`) o ítem Change (`accepted_files`)."""
    return list(change.get('files') or change.get('accepted_files') or [])


def change_time(change: Mapping[str, Any]) -> Optional[str]:
    """Momento de aceptación: `occurred_at` (evento) o `accepted_at`/`first_seen_at` (ítem Change)."""
    return change.get('occurred_at') or change.get('accepted_at') or change.get('first_seen_at')


def build_feature_row(change: Mapping[str, Any], ctx: Optional[Mapping[str, Any]] = None) -> Dict[str, float]:
    """
    Vector de features de UN cambio aceptado. `change` acepta el payload de code.accepted
    (con `dimensions`) o un ítem Change aplanado (importance_score, redundancy_score…).
    `ctx` trae el contexto de sesión/petición (tokens_total, regenerations, latency_ms,
    session_acceptance_rate, task_type, default_branch).
    """
    ctx = ctx or {}
    files = change_files(change)
    dims = change.get('dimensions') or {}
    imp = dims.get('importance') or {}
    red = dims.get('redundancy') or {}
    aut = dims.get('automation') or {}
    by_kind = imp.get('by_kind') or change.get('by_kind') or {}

    added = _num(change.get('accepted_added_lines'), sum(_num(f.get('added')) for f in files))
    deleted = _num(change.get('accepted_deleted_lines'), sum(_num(f.get('deleted')) for f in files))
    lines = _num(imp.get('lines'), added)
    effective = _num(dims.get('effective_lines'), _num(change.get('effective_lines')))
    as_is = _num(aut.get('accepted_as_is'), _num(change.get('accepted_as_is')))
    edited = _num(aut.get('edited_before_accept'), _num(change.get('edited_before_accept')))
    shares = tier_shares(files)
    tokens = _num(ctx.get('tokens_total'), _num(change.get('tokens_total')))
    task_key = change.get('task_key') or ctx.get('task_key')
    task_type = str(ctx.get('task_type') or change.get('task_type') or '').strip().lower()
    branch = change.get('branch') or ctx.get('branch')
    default_branch = ctx.get('default_branch')
    is_default = (branch == default_branch) if (branch and default_branch) else (branch in DEFAULT_BRANCHES)

    row = {
        'accepted_added_lines': added,
        'accepted_deleted_lines': deleted,
        'files_count': float(len(files)),
        'importance_score': _clamp01(_num(imp.get('score'), _num(change.get('importance_score')))),
        'redundancy_score': _clamp01(_num(red.get('score'), _num(change.get('redundancy_score')))),
        'mechanical_share': _clamp01(_num(aut.get('mechanical_share'), _num(change.get('mechanical_share')))),
        'effective_lines': effective,
        'edited_before_accept_ratio': _clamp01(_ratio(edited, as_is + edited)),
        'core_tier_share': shares['core'],
        'test_tier_share': shares['test'],
        'logic_kind_share': _clamp01(_ratio(_num(by_kind.get('logic')), lines)),
        'test_kind_share': _clamp01(_ratio(_num(by_kind.get('test')), lines)),
        'tokens_total': tokens,
        'tokens_per_effective_line': tokens / max(effective, 1.0),
        'regenerations': _num(ctx.get('regenerations')),
        'latency_ms': _num(ctx.get('latency_ms')),
        # sin dato → 0.6 (≈ media poblacional): un 0 implícito castigaría la supervivencia
        'session_acceptance_rate': _clamp01(_num(ctx.get('session_acceptance_rate'), NEUTRAL_ACCEPTANCE)),
        'has_task': 1.0 if task_key else 0.0,
        'task_is_bug': 1.0 if (task_key and task_type in BUG_TYPES) else 0.0,
        'branch_is_default': 1.0 if is_default else 0.0,
        'hour_of_day': float(hour_of_day(change_time(change))),
    }
    missing = set(FEATURES) - set(row)
    if missing:  # contracts agregó una feature y nadie la implementó aquí
        raise KeyError(f'features sin implementar en build_feature_row: {sorted(missing)}')
    return {k: float(row[k]) for k in FEATURES}


def to_csv_row(row: Mapping[str, float]) -> str:
    """Fila CSV sin cabecera en el orden de FEATURES (formato del contenedor XGBoost)."""
    return ','.join(repr(float(row[k])) for k in FEATURES)


def validate_frame(df) -> None:
    """Falla si el DataFrame no trae exactamente las columnas del contrato (en cualquier orden)."""
    missing = [c for c in FEATURES if c not in df.columns]
    if missing:
        raise ValueError(f'faltan columnas de features: {missing}')
