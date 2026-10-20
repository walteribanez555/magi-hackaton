#!/usr/bin/env python3
"""
Exporta el dataset REAL de entrenamiento desde la tabla single-table de DynamoDB
(`magicode-<env>-productivity`, env TABLE_NAME) con un Scan paginado filtrado por `entity`.

Por qué DynamoDB y no la réplica RDS: el Processing Job de SageMaker corre fuera de la VPC
(sin NAT) y Dynamo es alcanzable por API pública con IAM; la réplica RDS (`changes`,
`commits`, `refs`, `sessions`) es privada. Para tablas grandes, sustituir el Scan por una
exportación PITR a S3 (ExportTableToPointInTime) — mismo esquema de ítems.

Entidades usadas (ver packages/contracts/src/keys.ts):
  Change      → filas (solo aceptadas: status ∈ accepted|committed|in_reference); usa
                accepted_files, accepted_at, dimensions, commit_sha, reference_tags
                (ver apps/api/src/modules/productivity/productivity.types.ts → ChangeItem)
  AiRequest   → tokens_total (Σ de la cadena de regeneraciones), regenerations, latency_ms
  Commit      → commit_sha del cambio (change_ids) + paths para enlazar tareas Bug
  Reference   → included_shas / sha (etiqueta survival)
  Deployment  → sha con state=success (etiqueta survival)
  PullRequest → merge_sha/head_sha + source_branch: desplegar el merge commit del PR cuenta para
                los commits de su rama (Commit.branch / remote_branch), igual que la API
  Task        → type (Bug) + fechas;  TaskLink(kind=commit) → commits de la tarea

Etiquetas: ver labels.py (ventana 14 días; filas censuradas se excluyen).
Privacidad: el dataset solo contiene conteos/ratios + ids; no hay código ni prompts.

Uso:
  TABLE_NAME=magicode-dev-productivity python export_dataset.py --out data/real.csv
  ... --s3-uri s3://<ML_BUCKET>/scoring/dev/dataset/real.csv
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional

import pandas as pd

from features import FEATURES, build_feature_row, change_files, change_time
from labels import parse_ts, rework_label, survival_label

log = logging.getLogger(__name__)

ENTITIES = ['Change', 'Session', 'AiRequest', 'Commit', 'Reference', 'Deployment', 'PullRequest', 'Task', 'TaskLink']
ACCEPTED_STATUSES = {'accepted', 'committed', 'in_reference'}


def _sha_eq(a: Any, b: Any) -> bool:
    x, y = str(a or '').lower(), str(b or '').lower()
    return len(x) >= 7 and len(y) >= 7 and (x.startswith(y) or y.startswith(x))


def deployed_commit_shas(commits: List[Mapping[str, Any]], deployments: List[Mapping[str, Any]],
                         pull_requests: List[Mapping[str, Any]]) -> set:
    """
    SHAs de commits con evidencia de despliegue (misma regla que la API,
    apps/api/src/common/utils/deployment-evidence.ts): Deployment success del mismo repo cuyo
    SHA es el del commit o el merge_sha/head_sha de un PR cuya rama origen contiene el commit,
    y SOLO a entornos de producción (DEPLOY_PRODUCTION_ENVIRONMENTS, por defecto production,prod).
    """
    prod = {e.strip().lower() for e in os.getenv('DEPLOY_PRODUCTION_ENVIRONMENTS', 'production,prod').split(',') if e.strip()}
    ok = [d for d in deployments if d.get('state') == 'success' and d.get('sha')
          and str(d.get('environment') or '').strip().lower() in prod]
    out = set()
    for c in commits:
        repo = str(c.get('repository') or '').lower()
        branches = {b for b in (c.get('branch'), c.get('remote_branch')) if b}
        shas = [c.get('sha')]
        for pr in pull_requests:
            if str(pr.get('repository') or '').lower() == repo and pr.get('source_branch') in branches:
                shas += [pr.get('merge_sha'), pr.get('head_sha')]
        if any(str(d.get('repository') or '').lower() == repo and any(_sha_eq(s, d['sha']) for s in shas if s)
               for d in ok):
            out.add(c.get('sha'))
    return out


def _plain(v: Any) -> Any:
    """Decimal → float/int recursivo (boto3 resource devuelve Decimal)."""
    if isinstance(v, Decimal):
        return int(v) if v == v.to_integral_value() else float(v)
    if isinstance(v, list):
        return [_plain(x) for x in v]
    if isinstance(v, dict):
        return {k: _plain(x) for k, x in v.items()}
    if isinstance(v, set):
        return {_plain(x) for x in v}
    return v


def scan_entities(table_name: str, region: Optional[str] = None) -> Dict[str, List[dict]]:
    import boto3
    from boto3.dynamodb.conditions import Attr

    table = boto3.resource('dynamodb', region_name=region).Table(table_name)
    out: Dict[str, List[dict]] = defaultdict(list)
    kwargs: Dict[str, Any] = {'FilterExpression': Attr('entity').is_in(ENTITIES)}
    pages = 0
    while True:
        resp = table.scan(**kwargs)
        for item in resp.get('Items', []):
            item = _plain(item)
            out[item['entity']].append(item)
        pages += 1
        if 'LastEvaluatedKey' not in resp:
            break
        kwargs['ExclusiveStartKey'] = resp['LastEvaluatedKey']
    log.info('Scan %s: %d páginas → %s', table_name, pages, {k: len(v) for k, v in out.items()})
    return out


def _task_key_from_pk(pk: str) -> str:
    return pk.split('#TASK#', 1)[-1] if '#TASK#' in pk else ''


def build_dataset(items: Mapping[str, List[dict]], now: Optional[datetime] = None) -> pd.DataFrame:
    """Une las entidades y produce FEATURES + survival + rework (+ ids para agrupar)."""
    now = now or datetime.now(timezone.utc)
    changes = items.get('Change', [])
    requests = {r.get('ai_request_id'): r for r in items.get('AiRequest', [])}
    commits = {c.get('sha'): c for c in items.get('Commit', [])}

    # change_id → sha (si el Change no lo trae)
    sha_by_change: Dict[str, str] = {}
    for c in commits.values():
        for cid in c.get('change_ids') or []:
            sha_by_change.setdefault(cid, c.get('sha'))

    reference_shas = set()
    for r in items.get('Reference', []):
        reference_shas.update(r.get('included_shas') or [])
        if r.get('sha'):
            reference_shas.add(r['sha'])
    deployments = items.get('Deployment', [])
    deployed_shas = deployed_commit_shas(list(commits.values()), deployments, items.get('PullRequest', []))

    tasks = {}
    for t in items.get('Task', []):
        key = t.get('task_key') or _task_key_from_pk(str(t.get('PK', '')))
        tasks[key] = t
    task_paths: Dict[str, set] = defaultdict(set)
    for link in items.get('TaskLink', []):
        if link.get('kind') != 'commit':
            continue
        key = link.get('task_key') or _task_key_from_pk(str(link.get('PK', '')))
        sha = link.get('sha') or link.get('link_id') or str(link.get('SK', '')).split('#')[-1]
        commit = commits.get(sha)
        if commit:
            task_paths[key].update(f.get('path') for f in change_files(commit) if f.get('path'))
    bug_hits = [
        {'type': t.get('type'), 'created_at': t.get('created_at') or t.get('source_updated_at'),
         'updated_at': t.get('updated_at'), 'paths': task_paths.get(k, set())}
        for k, t in tasks.items()
    ]

    by_session: Dict[str, List[dict]] = defaultdict(list)
    by_repo: Dict[str, List[dict]] = defaultdict(list)
    for ch in changes:
        by_session[ch.get('session_id')].append(ch)
        if str(ch.get('status')) in ACCEPTED_STATUSES:
            by_repo[ch.get('repository')].append(ch)
    for lst in by_session.values():
        lst.sort(key=lambda c: str(change_time(c) or ''))

    rows: List[dict] = []
    censored = 0
    for sid, lst in by_session.items():
        proposed = accepted = 0
        for ch in lst:
            proposed += 1
            status = str(ch.get('status') or '')
            if status not in ACCEPTED_STATUSES:
                continue
            accepted += 1

            # Cadena de regeneraciones: tokens imputados COMPLETOS (incluye las regeneraciones)
            req = requests.get(ch.get('ai_request_id')) or {}
            tokens = float(((req.get('usage') or {}).get('total_tokens')) or 0)
            regen, cur, seen = 0, req, set()
            while cur.get('regenerates') and cur.get('regenerates') not in seen and regen < 20:
                seen.add(cur['regenerates'])
                cur = requests.get(cur['regenerates']) or {}
                tokens += float(((cur.get('usage') or {}).get('total_tokens')) or 0)
                regen += 1

            task = tasks.get(ch.get('task_key')) or {}
            ctx = {
                'tokens_total': tokens,
                'regenerations': regen,
                'latency_ms': req.get('latency_ms', 0),
                'session_acceptance_rate': accepted / proposed,
                'task_type': task.get('type'),
            }
            feats = build_feature_row(ch, ctx)
            ch_l = {**ch, 'commit_sha': ch.get('commit_sha') or sha_by_change.get(ch.get('change_id'))}
            y_s = survival_label(ch_l, reference_shas, deployed_shas, now)
            y_r = rework_label(ch_l, by_repo.get(ch.get('repository'), []), bug_hits, now)
            if y_s is None and y_r is None:
                censored += 1
                continue
            rows.append({**feats, 'survival': y_s, 'rework': y_r,
                         'session_id': sid, 'change_id': ch.get('change_id'), 'occurred_at': change_time(ch)})

    log.info('Dataset real: %d filas etiquetadas, %d censuradas (aún dentro de la ventana de 14 días)',
             len(rows), censored)
    cols = FEATURES + ['survival', 'rework', 'session_id', 'change_id', 'occurred_at']
    df = pd.DataFrame.from_records(rows, columns=cols)
    df.attrs['provenance'] = 'real'
    return df


def export(table_name: str, out: Optional[str] = None, s3_uri: Optional[str] = None,
           region: Optional[str] = None) -> pd.DataFrame:
    df = build_dataset(scan_entities(table_name, region))
    if out:
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        df.to_csv(out, index=False)
        log.info('→ %s', out)
    if s3_uri:
        import boto3
        bucket, key = s3_uri[len('s3://'):].split('/', 1)
        boto3.client('s3', region_name=region).put_object(Bucket=bucket, Key=key, Body=df.to_csv(index=False).encode())
        log.info('→ %s', s3_uri)
    return df


def main(argv: Optional[List[str]] = None) -> None:
    logging.basicConfig(level=logging.INFO, format='%(asctime)s  %(levelname)-8s  %(message)s', datefmt='%H:%M:%S')
    ap = argparse.ArgumentParser(description='Exporta el dataset REAL de scoring desde DynamoDB')
    ap.add_argument('--table', default=os.getenv('TABLE_NAME', ''))
    ap.add_argument('--out', default=str(Path(__file__).resolve().parent / 'data' / 'real.csv'))
    ap.add_argument('--s3-uri', default=None)
    ap.add_argument('--region', default=os.getenv('AWS_DEFAULT_REGION'))
    args = ap.parse_args(argv)
    if not args.table:
        log.error('TABLE_NAME (o --table) es obligatorio')
        sys.exit(1)
    export(args.table, args.out, args.s3_uri, args.region)


if __name__ == '__main__':
    main()
