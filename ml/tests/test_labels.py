"""Etiquetas reales (labels.py), unión de entidades (export_dataset.build_dataset) y regla de deploy."""
from datetime import datetime, timezone

import pytest

from export_dataset import build_dataset, deployed_commit_shas
from labels import rework_label, survival_label

NOW = datetime(2026, 10, 20, tzinfo=timezone.utc)
OLD = '2026-09-01T10:00:00Z'      # > 14 días antes de NOW
RECENT = '2026-10-15T10:00:00Z'   # < 14 días antes de NOW


def ch(**kw):
    base = {'change_id': 'c1', 'status': 'committed', 'occurred_at': OLD, 'repository': 'org/r',
            'files': [{'path': 'src/a.ts', 'added': 10, 'deleted': 0}]}
    base.update(kw)
    return base


# ── survival ──────────────────────────────────────────────────────────────────────

def test_survival_positive_by_status_or_reference_or_deployment():
    assert survival_label(ch(status='in_reference'), set(), set(), NOW) == 1
    assert survival_label(ch(commit_sha='abc1234'), {'abc1234'}, set(), NOW) == 1
    assert survival_label(ch(commit_sha='abc1234'), set(), {'abc1234'}, NOW) == 1


def test_survival_negative_only_after_horizon_else_censored():
    assert survival_label(ch(commit_sha='zzz'), {'abc1234'}, set(), NOW) == 0
    assert survival_label(ch(occurred_at=RECENT), set(), set(), NOW) is None
    assert survival_label(ch(occurred_at=None), set(), set(), NOW) is None


# ── rework ────────────────────────────────────────────────────────────────────────

def test_rework_explicit_signal():
    assert rework_label(ch(lines_rewritten_14d=3), [], [], NOW) == 1
    assert rework_label(ch(rework=True), [], [], NOW) == 1


def test_rework_by_later_change_deleting_same_file_within_14_days():
    later = ch(change_id='c2', session_id='s2', occurred_at='2026-09-05T10:00:00Z',
               files=[{'path': 'src/a.ts', 'added': 2, 'deleted': 4}])
    assert rework_label(ch(), [later], [], NOW) == 1


def test_rework_ignores_other_files_out_of_window_and_self():
    other_file = ch(change_id='c2', occurred_at='2026-09-05T10:00:00Z',
                    files=[{'path': 'src/b.ts', 'added': 1, 'deleted': 9}])
    too_late = ch(change_id='c3', occurred_at='2026-09-20T10:00:00Z',
                  files=[{'path': 'src/a.ts', 'added': 1, 'deleted': 9}])
    itself = ch(files=[{'path': 'src/a.ts', 'added': 1, 'deleted': 9}])
    assert rework_label(ch(), [other_file, too_late, itself], [], NOW) == 0


def test_rework_by_bug_task_on_same_files():
    bug = {'type': 'Bug', 'created_at': '2026-09-03T00:00:00Z', 'paths': {'src/a.ts'}}
    story = {'type': 'Story', 'created_at': '2026-09-03T00:00:00Z', 'paths': {'src/a.ts'}}
    assert rework_label(ch(), [], [bug], NOW) == 1
    assert rework_label(ch(), [], [story], NOW) == 0


def test_rework_censored_when_window_not_elapsed():
    assert rework_label(ch(occurred_at=RECENT), [], [], NOW) is None


# ── unión de entidades ───────────────────────────────────────────────────────────

def test_build_dataset_joins_entities():
    items = {
        'Change': [
            ch(change_id='p0', session_id='s1', status='rejected', occurred_at='2026-08-31T09:00:00Z'),
            ch(change_id='c1', session_id='s1', ai_request_id='r2', task_key='MAG-1',
               importance_score=0.8, redundancy_score=0.1, mechanical_share=0.2, effective_lines=8),
            ch(change_id='c2', session_id='s1', status='accepted', occurred_at='2026-09-04T10:00:00Z',
               files=[{'path': 'src/a.ts', 'added': 1, 'deleted': 5}]),
        ],
        'AiRequest': [
            {'ai_request_id': 'r1', 'usage': {'total_tokens': 1000}, 'latency_ms': 500},
            {'ai_request_id': 'r2', 'usage': {'total_tokens': 1500}, 'latency_ms': 700, 'regenerates': 'r1'},
        ],
        'Commit': [{'sha': 'abc1234', 'change_ids': ['c1'], 'files': [{'path': 'src/a.ts'}]}],
        'Reference': [{'tag': 'v1', 'sha': 'fff', 'included_shas': ['abc1234']}],
        'Task': [{'PK': 'T#t#TASK#MAG-1', 'task_key': 'MAG-1', 'type': 'Bug'}],
        'TaskLink': [],
    }
    df = build_dataset(items, now=NOW)
    assert list(df['change_id']) == ['c1', 'c2']  # el rechazado no es fila
    r = df.set_index('change_id').loc['c1']
    assert r['tokens_total'] == 2500 and r['regenerations'] == 1 and r['latency_ms'] == 700
    assert r['session_acceptance_rate'] == pytest.approx(1 / 2)
    assert r['task_is_bug'] == 1
    assert r['survival'] == 1        # su commit está en la referencia v1
    assert r['rework'] == 1          # c2 borra líneas de src/a.ts 3 días después


# ── regla de deploy (train.decide_deploy) ────────────────────────────────────────

def test_decide_deploy_rules(monkeypatch):
    import train
    monkeypatch.setattr(train, 'FORCE_DEPLOY', False)
    monkeypatch.setattr(train, 'MIN_AUC', 0.65)
    assert train.decide_deploy(0.60, 'synthetic', None)[0] is False
    assert train.decide_deploy(0.70, 'synthetic', None)[0] is True
    cur = {'trained_on': 'synthetic', 'auc_test': 0.72}
    assert train.decide_deploy(0.71, 'synthetic', cur)[0] is False
    assert train.decide_deploy(0.73, 'synthetic', cur)[0] is True
    assert train.decide_deploy(0.66, 'real', cur, heuristic_auc=0.60)[0] is True   # real reemplaza sintético
    assert train.decide_deploy(0.66, 'real', cur, heuristic_auc=0.70)[0] is False  # no supera heurística
    real = {'trained_on': 'real', 'auc_test': 0.60}
    assert train.decide_deploy(0.90, 'synthetic', real)[0] is False                # sintético no pisa real


def test_dynamo_change_item_shape_accepted_files_and_accepted_at():
    """Ítem Change real (productivity.types.ts → ChangeItem): accepted_files / accepted_at."""
    item = {'change_id': 'c9', 'status': 'committed', 'accepted_at': OLD, 'reference_tags': ['v1'],
            'accepted_files': [{'path': 'src/a.ts', 'added': 3, 'deleted': 0}]}
    assert survival_label(item, set(), set(), NOW) == 1
    later = {'change_id': 'c10', 'accepted_at': '2026-09-02T10:00:00Z',
             'accepted_files': [{'path': 'src/a.ts', 'added': 0, 'deleted': 2}]}
    assert rework_label(item, [later], [], NOW) == 1


def test_rework_same_session_iteration_is_not_rework():
    base = ch(session_id='s1')
    # mismo archivo, misma sesión, 2 h después: el dev iteró sobre su propio cambio
    iter_ = ch(change_id='c2', session_id='s1', occurred_at='2026-09-01T12:00:00Z',
               files=[{'path': 'src/a.ts', 'added': 3, 'deleted': 5}])
    assert rework_label(base, [iter_], [], NOW) == 0
    # misma sesión pero ≥ 24 h después ⇒ sí cuenta
    next_day = ch(change_id='c3', session_id='s1', occurred_at='2026-09-02T11:00:00Z',
                  files=[{'path': 'src/a.ts', 'added': 3, 'deleted': 5}])
    assert rework_label(base, [next_day], [], NOW) == 1
    # otra sesión, 2 h después ⇒ cuenta
    other = ch(change_id='c4', session_id='s2', occurred_at='2026-09-01T12:00:00Z',
               files=[{'path': 'src/a.ts', 'added': 3, 'deleted': 5}])
    assert rework_label(base, [other], [], NOW) == 1


def test_survival_no_deployed_status():
    """ChangeListItem no tiene estado `deployed`: solo in_reference o evidencia (deployed_at / SHA)."""
    assert survival_label(ch(status='deployed'), set(), set(), NOW) == 0
    assert survival_label(ch(deployed_at='2026-09-03T00:00:00Z'), set(), set(), NOW) == 1


def test_deployed_commit_shas_merge_commit_of_pr_counts():
    commits = [{'sha': 'a' * 40, 'repository': 'org/r', 'branch': 'feature/x'},
               {'sha': 'b' * 40, 'repository': 'org/r', 'remote_branch': 'feature/y'}]
    prs = [{'repository': 'org/r', 'source_branch': 'feature/x', 'merge_sha': 'c' * 12, 'head_sha': 'a' * 40},
           {'repository': 'org/r', 'source_branch': 'feature/y', 'merge_sha': 'd' * 40, 'head_sha': 'b' * 40}]
    deps = [{'repository': 'org/r', 'sha': 'c' * 40, 'state': 'success', 'environment': 'production'},
            {'repository': 'org/r', 'sha': 'd' * 40, 'state': 'failure', 'environment': 'production'},
            {'repository': 'org/r', 'sha': 'b' * 40, 'state': 'success', 'environment': 'staging'}]
    assert deployed_commit_shas(commits, deps, prs) == {'a' * 40}
