"""Dataset sintético: forma, rangos y que respete los supuestos generativos documentados."""
import numpy as np
import pytest

from features import FEATURES
from generate_synthetic import generate
import heuristic


@pytest.fixture(scope='module')
def df():
    return generate(rows=6000, seed=7)


def test_shape_columns_and_provenance(df):
    assert len(df) == 6000
    assert list(df.columns[: len(FEATURES)]) == FEATURES
    assert {'survival', 'rework', 'session_idx'} <= set(df.columns)
    assert df.attrs['provenance'] == 'simulated'
    assert not df[FEATURES].isna().any().any()


def test_ranges(df):
    for c in ['importance_score', 'redundancy_score', 'mechanical_share', 'edited_before_accept_ratio',
              'core_tier_share', 'test_tier_share', 'logic_kind_share', 'test_kind_share',
              'session_acceptance_rate']:
        assert df[c].between(0, 1).all(), c
    assert (df['core_tier_share'] + df['test_tier_share'] <= 1 + 1e-6).all()
    assert df['hour_of_day'].between(0, 23).all()
    assert (df['task_is_bug'] <= df['has_task']).all()
    assert (df['effective_lines'] <= df['accepted_added_lines']).all()


def test_base_rates_are_plausible(df):
    assert 0.45 < df['survival'].mean() < 0.75
    assert 0.12 < df['rework'].mean() < 0.35


def test_deterministic_by_seed():
    a, b = generate(rows=300, seed=1), generate(rows=300, seed=1)
    assert a.equals(b)


def _rate(df, mask, label):
    return df.loc[mask, label].mean()


def test_redundancy_and_mechanical_lower_survival(df):
    hi = df['redundancy_score'] > df['redundancy_score'].quantile(0.8)
    lo = df['redundancy_score'] < df['redundancy_score'].quantile(0.2)
    assert _rate(df, hi, 'survival') < _rate(df, lo, 'survival') - 0.08
    mhi = df['mechanical_share'] > df['mechanical_share'].quantile(0.8)
    mlo = df['mechanical_share'] < df['mechanical_share'].quantile(0.2)
    assert _rate(df, mhi, 'survival') < _rate(df, mlo, 'survival')


def test_bug_tasks_raise_rework(df):
    assert _rate(df, df['task_is_bug'] == 1, 'rework') > _rate(df, df['task_is_bug'] == 0, 'rework') + 0.05


def test_large_untested_core_raises_rework(df):
    large_untested_core = (df['accepted_added_lines'] > 80) & (df['test_tier_share'] == 0) & \
        (df['core_tier_share'] > 0.8)
    small = df['accepted_added_lines'] < 15
    assert _rate(df, large_untested_core, 'rework') > _rate(df, small, 'rework') + 0.1


def test_heuristic_is_informative_but_not_perfect(df):
    """Latente + ruido + 5 % de etiquetas invertidas ⇒ techo de AUC realista (< 0.85)."""
    from sklearn.metrics import roc_auc_score
    rows = df[FEATURES].to_dict('records')
    for label in ['survival', 'rework']:
        p = np.array([heuristic.predict(label, r) for r in rows])
        auc = roc_auc_score(df[label], p)
        assert 0.62 < auc < 0.85, (label, auc)
