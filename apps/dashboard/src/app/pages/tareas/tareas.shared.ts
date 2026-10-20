import type { TaskListItem } from '@magicode/contracts';

import type { Tone } from '@/shared/components/ui/status-mark.component';
import { PR_STATE_LABEL, TASK_CATEGORY_LABEL } from '@/shared/labels/labels';

/** Clases de tabla del diseño: reglas de 1px, cabecera pequeña en gris. */
export const TH = 'px-3 pt-3 pb-2 text-left text-xs font-medium text-muted first:pl-0 last:pr-0';
export const TD = 'px-3 py-3.5 align-top first:pl-0 last:pr-0';
export const SELECT =
  'min-h-11 rounded-[4px] border border-field bg-bg px-3 py-2.5 font-sans text-[15px] text-ink';

const CATEGORY_TONE: Record<TaskListItem['status_category'], Tone> = { todo: 'none', in_progress: 'info', done: 'ok' };

export function taskTone(t: Pick<TaskListItem, 'status_category'>): Tone {
  return CATEGORY_TONE[t.status_category] ?? 'muted';
}

/** "untracked" = la clave aparece en ramas/commits pero el gestor no la reportó. */
export function taskStatusLabel(t: Pick<TaskListItem, 'status' | 'status_category'>): string {
  if (!t.status || t.status === 'untracked') return `${TASK_CATEGORY_LABEL[t.status_category]} · sin datos del gestor`;
  return t.status;
}

export function prLabel(pr: { number: number; state: string }): string {
  return `#${pr.number} ${PR_STATE_LABEL[pr.state] ?? pr.state}`;
}
