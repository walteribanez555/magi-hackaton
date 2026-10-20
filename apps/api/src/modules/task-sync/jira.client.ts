import type { AvailableTransition, TaskAction, TaskProviderCredentials } from '@magicode/contracts';
import { jiraStatusCategory } from '../webhooks/adapters/common';
import { DEFAULT_STORY_POINTS_FIELD } from '../webhooks/adapters/jira.adapter';
import { markdownToAdf } from './adf';
import { normalizeName, ProviderError, requestJson, type HttpOptions } from './provider-http';
import type { ExecuteResult, TaskProviderClient } from './task-sync.types';

type JiraCredentials = Extract<TaskProviderCredentials, { provider: 'jira' }>;

/** Transición tal como la devuelve GET /rest/api/3/issue/{key}/transitions. */
export interface JiraTransition {
  id: string;
  name: string;
  to?: { name?: string; statusCategory?: { key?: string } };
}

export const ENTITY_PROPERTY = 'magicode.last_action';

export function toAvailableTransition(t: JiraTransition): AvailableTransition {
  return {
    id: String(t.id),
    name: t.name,
    to_status: t.to?.name ?? t.name,
    to_category: jiraStatusCategory(t.to?.statusCategory?.key),
  };
}

/**
 * Resuelve el destino de una acción `transition`: por id exacto, o por nombre del estado destino
 * (o de la transición) ignorando mayúsculas/acentos. null ⇒ no disponible desde el estado actual.
 */
export function resolveTransition(
  transitions: JiraTransition[],
  target: { to_status?: string; transition_id?: string },
): JiraTransition | null {
  if (target.transition_id) return transitions.find((t) => String(t.id) === target.transition_id) ?? null;
  if (!target.to_status) return null;
  const want = normalizeName(target.to_status);
  return (
    transitions.find((t) => t.to?.name && normalizeName(t.to.name) === want) ??
    transitions.find((t) => normalizeName(t.name) === want) ??
    null
  );
}

/** Cliente Jira Cloud REST v3 (Basic email:api_token). Cada método lanza ProviderError (transient o no). */
export class JiraClient implements TaskProviderClient {
  private readonly base: string;
  private readonly auth: string;

  constructor(
    private readonly creds: JiraCredentials,
    private readonly http: HttpOptions = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.base = creds.site_url.replace(/\/+$/, '');
    this.auth = `Basic ${Buffer.from(`${creds.email}:${creds.api_token}`).toString('base64')}`;
  }

  private async call<T>(method: string, path: string, body?: unknown, label = `jira ${method} ${path.split('?')[0]}`): Promise<T | null> {
    const res = await requestJson<T>(
      `${this.base}${path}`,
      {
        method,
        headers: {
          Authorization: this.auth,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      { ...this.http, label },
    );
    return res.body;
  }

  private issuePath(key: string) {
    return `/rest/api/3/issue/${encodeURIComponent(key)}`;
  }

  async whoami(): Promise<{ account_id: string; display_name?: string }> {
    const me = await this.call<{ accountId?: string; displayName?: string }>('GET', '/rest/api/3/myself');
    if (!me?.accountId) throw new ProviderError('jira myself: respuesta sin accountId', null, false);
    return { account_id: me.accountId, ...(me.displayName ? { display_name: me.displayName } : {}) };
  }

  async rawTransitions(key: string): Promise<JiraTransition[]> {
    const res = await this.call<{ transitions?: JiraTransition[] }>('GET', `${this.issuePath(key)}/transitions`);
    return res?.transitions ?? [];
  }

  async transitions(key: string): Promise<AvailableTransition[]> {
    return (await this.rawTransitions(key)).map(toAvailableTransition);
  }

  async addComment(key: string, markdown: string): Promise<string | null> {
    const res = await this.call<{ id?: string }>('POST', `${this.issuePath(key)}/comment`, { body: markdownToAdf(markdown) });
    return res?.id ?? null;
  }

  /** fields + update (labels) del PUT /issue — solo los campos con id configurado. */
  buildFieldUpdate(fields: Extract<TaskAction, { kind: 'update_fields' }>['fields']): {
    body: { fields?: Record<string, unknown>; update?: Record<string, unknown> };
    written: string[];
    skipped: string[];
  } {
    const ids = this.creds.field_ids ?? {};
    const out: Record<string, unknown> = {};
    const written: string[] = [];
    const skipped: string[] = [];
    const put = (name: string, fieldId: string | undefined, value: unknown) => {
      if (value === undefined) return;
      if (!fieldId) return void skipped.push(name);
      out[fieldId] = value;
      written.push(name);
    };
    put('story_points', ids.story_points || process.env.JIRA_STORY_POINTS_FIELD || DEFAULT_STORY_POINTS_FIELD, fields.story_points);
    put('magicode_tokens', ids.magicode_tokens, fields.magicode_tokens);
    put('magicode_effective_lines', ids.magicode_effective_lines, fields.magicode_effective_lines);
    // campo de selección única (select list): Jira espera { value }
    put('magicode_criticality', ids.magicode_criticality, fields.magicode_criticality ? { value: fields.magicode_criticality } : undefined);
    const labelOps = [
      ...(fields.labels_add ?? []).map((l) => ({ add: l.replace(/\s+/g, '-') })),
      ...(fields.labels_remove ?? []).map((l) => ({ remove: l.replace(/\s+/g, '-') })),
    ];
    if (labelOps.length) written.push('labels');
    return {
      body: {
        ...(Object.keys(out).length ? { fields: out } : {}),
        ...(labelOps.length ? { update: { labels: labelOps } } : {}),
      },
      written,
      skipped,
    };
  }

  async execute(key: string, action: TaskAction, actionId: string): Promise<ExecuteResult> {
    const issue = this.issuePath(key);
    let out: ExecuteResult;
    switch (action.kind) {
      case 'transition': {
        const list = await this.rawTransitions(key);
        const t = resolveTransition(list, action);
        if (!t) {
          const names = list.map((x) => x.to?.name ?? x.name).join(', ') || '(ninguna)';
          throw new ProviderError(
            `Transición a "${action.to_status ?? action.transition_id}" no disponible desde el estado actual de ${key}. Disponibles: ${names}`,
            409,
            false,
          );
        }
        await this.call('POST', `${issue}/transitions`, { transition: { id: String(t.id) } });
        const commentId = action.comment ? await this.addComment(key, action.comment) : null;
        const view = toAvailableTransition(t);
        out = {
          status: 'sent',
          result: { transition_id: view.id, to_status: view.to_status, to_category: view.to_category, ...(commentId ? { comment_id: commentId } : {}) },
          task_status: { status: view.to_status, status_category: view.to_category },
        };
        break;
      }
      case 'comment': {
        const id = await this.addComment(key, action.body_markdown);
        out = { status: 'sent', result: { comment_id: id } };
        break;
      }
      case 'update_fields': {
        const { body, written, skipped } = this.buildFieldUpdate(action.fields);
        if (!written.length) {
          return { status: 'skipped', result: { reason: 'ningún campo con field_id configurado', skipped_fields: skipped } };
        }
        await this.call('PUT', `${issue}?notifyUsers=false`, body);
        out = { status: 'sent', result: { fields: written, ...(skipped.length ? { skipped_fields: skipped } : {}) } };
        break;
      }
      case 'remote_link': {
        // globalId estable ⇒ Jira actualiza el mismo enlace en vez de duplicarlo
        const res = await this.call<{ id?: number | string }>('POST', `${issue}/remotelink`, {
          globalId: `magicode:${action.relation}:${action.url}`,
          application: { type: 'com.magicode', name: 'MagiCode' },
          relationship: action.relation.replace('_', ' '),
          object: { url: action.url, title: action.title },
        });
        out = { status: 'sent', result: { remote_link_id: res?.id ?? null } };
        break;
      }
      case 'assign': {
        await this.call('PUT', `${issue}/assignee`, { accountId: action.assignee_account_id });
        out = { status: 'sent', result: { assignee_account_id: action.assignee_account_id } };
        break;
      }
    }
    // Marca anti-bucle en el issue (best effort: no invalida una acción ya aplicada)
    try {
      await this.call('PUT', `${issue}/properties/${ENTITY_PROPERTY}`, { action_id: actionId, at: this.now().toISOString() });
    } catch {
      out.result.entity_property = 'failed';
    }
    return out;
  }
}
