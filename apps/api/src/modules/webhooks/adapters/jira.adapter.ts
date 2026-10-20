import type { AdapterInput, AdaptResult } from '../webhooks.types';
import { base, jiraStatusCategory, num, obj, str, toIso } from './common';

export const DEFAULT_STORY_POINTS_FIELD = 'customfield_10016';

/** Campos que MagiCode puede cambiar vía write-back (por fieldId o por nombre del changelog). */
const MANAGED_FIELDS = new Set(['status', 'resolution', 'labels', 'assignee', 'story points', 'story point estimate']);

/**
 * Anti-bucle: un issue_updated cuyo actor es la cuenta de servicio de MagiCode y cuyo changelog
 * solo toca campos que gestiona MagiCode es el eco de nuestro propio write-back ⇒ se ignora.
 * Si el mismo actor cambió otros campos (p. ej. un humano usando el mismo usuario), se procesa.
 */
export function isSelfEcho(payload: Record<string, unknown>, serviceAccountId?: string, managedFieldIds: string[] = []): boolean {
  if (!serviceAccountId) return false;
  const actor = obj(payload.user).accountId;
  if (actor !== serviceAccountId) return false;
  const items = Array.isArray(obj(payload.changelog).items) ? (obj(payload.changelog).items as unknown[]) : [];
  const managed = new Set([...managedFieldIds.map((f) => f.toLowerCase()), ...MANAGED_FIELDS]);
  return items.every((raw) => {
    const it = obj(raw);
    const id = (str(it.fieldId) ?? '').toLowerCase();
    const name = (str(it.field) ?? '').toLowerCase();
    return (id && managed.has(id)) || (name && managed.has(name));
  });
}

/** https://empresa.atlassian.net/rest/api/2/issue/10001 → https://empresa.atlassian.net */
function originOf(self: string | undefined): string | undefined {
  if (!self) return undefined;
  try {
    return new URL(self).origin;
  } catch {
    return undefined;
  }
}

/**
 * Jira Cloud (webhook admin, System → WebHooks): jira:issue_created · jira:issue_updated · jira:issue_deleted.
 * El tipo de evento va en el CUERPO (`webhookEvent`), no en un header.
 * Docs: https://developer.atlassian.com/cloud/jira/platform/webhooks/
 */
export function jiraAdapter(input: AdapterInput): AdaptResult {
  const p = obj(input.payload);
  const event = str(p.webhookEvent) ?? '';
  const issue = obj(p.issue);
  const key = str(issue.key);
  const b = base(input, 'jira');

  if (!['jira:issue_created', 'jira:issue_updated', 'jira:issue_deleted'].includes(event)) {
    return { type: 'ignored', reason: `event ${event || '(none)'} not supported` };
  }
  if (!key) return { type: 'ignored', reason: `${event} without issue key` };
  if (event === 'jira:issue_deleted') return { type: 'events', events: [{ ...b, kind: 'task.deleted', task_key: key }] };
  if (event === 'jira:issue_updated' && isSelfEcho(p, input.options?.service_account_id, input.options?.managed_field_ids)) {
    return { type: 'ignored', reason: 'self', self: true };
  }

  const f = obj(issue.fields);
  const status = obj(f.status);
  const field = input.options?.story_points_field || DEFAULT_STORY_POINTS_FIELD;
  const storyPoints = num(f[field]);
  const assignee = str(obj(f.assignee).displayName);
  const type = str(obj(f.issuetype).name);
  const baseUrl = (input.options?.base_url || originOf(str(issue.self)))?.replace(/\/+$/, '');

  return {
    type: 'events',
    events: [
      {
        ...b,
        kind: 'task.upserted',
        task_key: key,
        title: (str(f.summary) ?? key).slice(0, 500),
        ...(type ? { type } : {}),
        status: str(status.name) ?? 'Unknown',
        status_category: jiraStatusCategory(str(obj(status.statusCategory).key)),
        ...(assignee ? { assignee } : {}),
        ...(storyPoints !== undefined ? { story_points: storyPoints } : {}),
        ...(baseUrl ? { url: `${baseUrl}/browse/${key}` } : {}),
        updated_at: toIso(f.updated, toIso(p.timestamp, input.received_at)),
      },
    ],
  };
}
