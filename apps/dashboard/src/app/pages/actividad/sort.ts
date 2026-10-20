import type { ChangeListItem } from '@magicode/contracts';

/** Criticidad descendente; los no puntuados al final, por fecha descendente. */
export function byCriticality(a: ChangeListItem, b: ChangeListItem): number {
  const sa = a.scores?.criticality_score ?? -1;
  const sb = b.scores?.criticality_score ?? -1;
  if (sa !== sb) return sb - sa;
  return b.occurred_at.localeCompare(a.occurred_at);
}

export function byDate(a: ChangeListItem, b: ChangeListItem): number {
  return b.occurred_at.localeCompare(a.occurred_at);
}

export function byLines(a: ChangeListItem, b: ChangeListItem): number {
  return b.accepted_added_lines - a.accepted_added_lines || byDate(a, b);
}
