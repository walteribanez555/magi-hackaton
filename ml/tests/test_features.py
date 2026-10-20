"""Features: orden del contrato, definiciones y paridad con TS."""
import json
import re
from pathlib import Path

import pytest

from features import FEATURES, build_feature_row, file_tier, hour_of_day, tier_shares, to_csv_row

ROOT = Path(__file__).resolve().parents[2]


def _accepted_change(**over):
    base = {
        'change_id': 'c1',
        'files': [
            {'path': 'src/app/total.ts', 'added': 30, 'deleted': 2},
            {'path': 'src/app/total.test.ts', 'added': 10, 'deleted': 0},
        ],
        'accepted_added_lines': 40,
        'accepted_deleted_lines': 2,
        'dimensions': {
            'importance': {'lines': 40, 'weighted_lines': 30, 'score': 0.75,
                           'by_kind': {'logic': 20, 'test': 8, 'import': 4, 'trivial': 8}},
            'redundancy': {'intra_change': 1, 'existing_in_repo': 1, 'repeated_in_session': 0,
                           'redundant_lines': 2, 'score': 0.0625},
            'automation': {'mechanical_lines': 12, 'mechanical_share': 0.3,
                           'accepted_as_is': 30, 'edited_before_accept': 10},
            'effective_lines': 25.5,
        },
        'branch': 'feature/MAG-1-total',
        'task_key': 'MAG-1',
        'occurred_at': '2026-10-20T23:15:00-03:00',
    }
    base.update(over)
    return base


def test_features_json_mirrors_contracts_scoring_ts():
    src = (ROOT / 'packages/contracts/src/scoring.ts').read_text()
    block = re.search(r'SCORING_FEATURES = \[(.*?)\] as const', src, re.S)
    assert block, 'no se encontró SCORING_FEATURES en contracts'
    ts_features = re.findall(r"'([a-z_]+)'", block.group(1))
    assert ts_features == FEATURES


def test_row_has_exact_contract_order_and_definitions():
    row = build_feature_row(_accepted_change(), {
        'tokens_total': 5100, 'regenerations': 1, 'latency_ms': 900,
        'session_acceptance_rate': 0.5, 'task_type': 'Bug',
    })
    assert list(row) == FEATURES
    assert row['accepted_added_lines'] == 40
    assert row['files_count'] == 2
    assert row['edited_before_accept_ratio'] == pytest.approx(10 / 40)
    assert row['core_tier_share'] == pytest.approx(30 / 40)
    assert row['test_tier_share'] == pytest.approx(10 / 40)
    assert row['logic_kind_share'] == pytest.approx(20 / 40)
    assert row['test_kind_share'] == pytest.approx(8 / 40)
    assert row['tokens_per_effective_line'] == pytest.approx(5100 / 25.5)
    assert row['has_task'] == 1 and row['task_is_bug'] == 1
    assert row['branch_is_default'] == 0
    assert row['hour_of_day'] == 2  # 23:15 -03:00 = 02:15 UTC


def test_flattened_change_item_and_defaults():
    item = {'files': [{'path': 'README.md', 'added': 5, 'deleted': 0}], 'accepted_added_lines': 5,
            'importance_score': 0.2, 'redundancy_score': 0.1, 'mechanical_share': 0, 'effective_lines': 0,
            'branch': 'main'}
    row = build_feature_row(item)
    assert row['importance_score'] == 0.2
    assert row['tokens_per_effective_line'] == 0  # sin tokens ni efectivas → 0/max(0,1)
    assert row['branch_is_default'] == 1
    assert row['has_task'] == 0 and row['task_is_bug'] == 0
    assert row['hour_of_day'] == 12  # sin occurred_at → mediodía
    assert row['session_acceptance_rate'] == 0.6  # imputación neutral (igual en TS)


def test_csv_row_is_headerless_in_order():
    row = build_feature_row(_accepted_change())
    parts = to_csv_row(row).split(',')
    assert len(parts) == len(FEATURES)
    assert float(parts[0]) == 40.0


@pytest.mark.parametrize('path,tier', [
    ('src/index.ts', 'core'),
    ('package-lock.json', 'generated'),
    ('dist/x.test.js', 'generated'),
    ('apps/api/src/__tests__/a.ts', 'test'),
    ('src/foo.spec.ts', 'test'),
    ('infra/lib/stack.ts', 'infra'),
    ('.github/PULL_REQUEST_TEMPLATE.md', 'infra'),
    ('Dockerfile', 'infra'),
    ('docs/metrics-model.md', 'docs'),
    ('README.md', 'docs'),
])
def test_file_tier_mirrors_metrics_package(path, tier):
    assert file_tier(path) == tier


def test_tier_shares_sum_to_one():
    s = tier_shares([{'path': 'src/a.ts', 'added': 3}, {'path': 'docs/a.md', 'added': 1}])
    assert sum(s.values()) == pytest.approx(1)
    assert s['core'] == pytest.approx(0.75)


def test_hour_of_day_handles_z_suffix_and_garbage():
    assert hour_of_day('2026-10-20T05:00:00Z') == 5
    assert hour_of_day('not-a-date') == 12


def test_api_heuristic_weights_copy_in_sync():
    api_copy = ROOT / 'apps/api/src/modules/scoring/heuristic-weights.json'
    if not api_copy.exists():
        pytest.skip('la API aún no tiene la copia (correr train.py)')
    src = json.loads((ROOT / 'ml/heuristic_weights.json').read_text())
    dst = json.loads(api_copy.read_text())
    src.pop('$comment'), dst.pop('$comment')
    assert src == dst, 'heuristic-weights.json de la API desactualizado: correr python ml/train.py'
