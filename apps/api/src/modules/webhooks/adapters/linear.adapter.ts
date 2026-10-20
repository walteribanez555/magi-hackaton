import type { AdapterInput, AdaptResult } from '../webhooks.types';
import { base, num, obj, str, toIso } from './common';

/** state.type de Linear → categoría normalizada. */
export function linearStatusCategory(type: string | undefined): 'todo' | 'in_progress' | 'done' {
  switch (type) {
    case 'started':
      return 'in_progress';
    case 'completed':
    case 'canceled':
      return 'done';
    default: // backlog · unstarted · triage
      return 'todo';
  }
}

/**
 * Linear (opcional): type=Issue, action=create|update|remove.
 * Docs: https://linear.app/developers/webhooks
 */
export function linearAdapter(input: AdapterInput): AdaptResult {
  const p = obj(input.payload);
  const type = str(p.type) ?? input.event;
  const action = str(p.action) ?? '';
  const d = obj(p.data);
  const key = str(d.identifier);
  const b = base(input, 'linear');

  if (type !== 'Issue') return { type: 'ignored', reason: `type ${type ?? '(none)'} not supported` };
  if (!['create', 'update', 'remove'].includes(action)) return { type: 'ignored', reason: `Issue.${action}` };
  if (!key) return { type: 'ignored', reason: 'Issue without identifier' };
  if (action === 'remove') return { type: 'events', events: [{ ...b, kind: 'task.deleted', task_key: key }] };

  const state = obj(d.state);
  const assignee = str(obj(d.assignee).name);
  const estimate = num(d.estimate);
  const url = str(d.url) ?? str(p.url);
  return {
    type: 'events',
    events: [
      {
        ...b,
        kind: 'task.upserted',
        task_key: key,
        title: (str(d.title) ?? key).slice(0, 500),
        status: str(state.name) ?? 'Unknown',
        status_category: linearStatusCategory(str(state.type)),
        ...(assignee ? { assignee } : {}),
        ...(estimate !== undefined ? { story_points: estimate } : {}),
        ...(url ? { url } : {}),
        updated_at: toIso(d.updatedAt, toIso(p.webhookTimestamp, input.received_at)),
      },
    ],
  };
}
