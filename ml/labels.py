"""
Etiquetas de entrenamiento a partir de datos REALES (funciones puras, testeadas en tests/).

survival  — P(un cambio IA aceptado llega a la versión de referencia / despliegue)
  1  si el Change está en estado `in_reference` (o trae in_reference_at / deployed_at /
     reference_tags), o su commit_sha está incluido en
     una Reference (`included_shas` / `sha`) o en un Deployment con state=success.
  0  si pasó la ventana de observación (HORIZON_DAYS desde occurred_at) sin llegar.
  None (censurado: se EXCLUYE del entrenamiento) si aún está dentro de la ventana — todavía
     puede llegar; contarlo como 0 sesgaría el modelo hacia abajo.

rework    — P(el cambio requiere retrabajo en ≤ 14 días)
  1  si el ítem trae una señal explícita (`rework`=true o `lines_rewritten_14d` > 0, campo
     PROPUESTO para el contrato), o
     si otro cambio aceptado del MISMO repositorio, posterior y dentro de 14 días, borra líneas
     en alguno de los mismos archivos (files[].deleted > 0 en la misma ruta), o
     si una tarea de tipo Bug creada/actualizada dentro de esos 14 días está enlazada a
     commits que tocan los mismos archivos.
  0  si pasaron los 14 días sin ninguna señal.
  None si aún no pasaron 14 días y no hay señal positiva (censurado).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Mapping, Optional, Set

from features import BUG_TYPES, change_files, change_time

HORIZON_DAYS = 14
SURVIVED_STATUSES = {'in_reference', 'deployed'}


def parse_ts(v: Any) -> Optional[datetime]:
    if not v:
        return None
    try:
        dt = datetime.fromisoformat(str(v).replace('Z', '+00:00'))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def file_paths(item: Mapping[str, Any]) -> Set[str]:
    return {str(f.get('path')) for f in change_files(item) if f.get('path')}


def survival_label(
    change: Mapping[str, Any],
    reference_shas: Set[str],
    deployed_shas: Set[str],
    now: datetime,
    horizon_days: int = HORIZON_DAYS,
) -> Optional[int]:
    status = str(change.get('status') or '')
    if status in SURVIVED_STATUSES or change.get('in_reference_at') or change.get('deployed_at') \
            or change.get('reference_tags'):
        return 1
    sha = change.get('commit_sha')
    if sha and (sha in reference_shas or sha in deployed_shas):
        return 1
    t = parse_ts(change_time(change))
    if t is None:
        return None
    return 0 if now - t >= timedelta(days=horizon_days) else None


def rework_label(
    change: Mapping[str, Any],
    later_changes: Iterable[Mapping[str, Any]],
    bug_task_file_hits: Iterable[Mapping[str, Any]],
    now: datetime,
    horizon_days: int = HORIZON_DAYS,
) -> Optional[int]:
    """
    `later_changes`: cambios aceptados del mismo repositorio (cualquier sesión).
    `bug_task_file_hits`: [{type, updated_at|created_at, paths:set}] — tareas con los paths de
    los commits enlazados (TaskLink kind=commit → Commit.files).
    """
    if change.get('rework') is True or float(change.get('lines_rewritten_14d') or 0) > 0:
        return 1
    t0 = parse_ts(change_time(change))
    if t0 is None:
        return None
    t1 = t0 + timedelta(days=horizon_days)
    paths = file_paths(change)
    cid = change.get('change_id')

    for other in later_changes:
        if other.get('change_id') == cid:
            continue
        t = parse_ts(change_time(other))
        if t is None or not (t0 < t <= t1):
            continue
        for f in change_files(other):
            if f.get('path') in paths and float(f.get('deleted') or 0) > 0:
                return 1

    for task in bug_task_file_hits:
        if str(task.get('type') or '').strip().lower() not in BUG_TYPES:
            continue
        t = parse_ts(task.get('created_at') or task.get('source_updated_at') or task.get('updated_at'))
        if t is None or not (t0 < t <= t1):
            continue
        if paths & set(task.get('paths') or ()):
            return 1

    return 0 if now >= t1 else None
