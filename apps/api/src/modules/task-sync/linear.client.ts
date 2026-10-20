import type { AvailableTransition, TaskAction, TaskProviderCredentials } from '@magicode/contracts';
import { linearStatusCategory } from '../webhooks/adapters/linear.adapter';
import { normalizeName, ProviderError, requestJson, type HttpOptions } from './provider-http';
import type { ExecuteResult, TaskProviderClient } from './task-sync.types';

type LinearCredentials = Extract<TaskProviderCredentials, { provider: 'linear' }>;

export const LINEAR_API = 'https://api.linear.app/graphql';

interface LinearIssue {
  id: string;
  identifier: string;
  team?: { states?: { nodes?: Array<{ id: string; name: string; type: string }> } };
}

/** Cliente GraphQL de Linear (opcional). Las etiquetas no se gestionan (se informan como skipped). */
export class LinearClient implements TaskProviderClient {
  constructor(
    private readonly creds: LinearCredentials,
    private readonly http: HttpOptions = {},
  ) {}

  private async gql<T>(query: string, variables: Record<string, unknown>, label: string): Promise<T> {
    const res = await requestJson<{ data?: T; errors?: Array<{ message?: string; extensions?: { code?: string } }> }>(
      LINEAR_API,
      {
        method: 'POST',
        headers: { Authorization: this.creds.api_key, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
      },
      { ...this.http, label: `linear ${label}` },
    );
    const errors = res.body?.errors ?? [];
    if (errors.length) {
      const rateLimited = errors.some((e) => e.extensions?.code === 'RATELIMITED');
      throw new ProviderError(`linear ${label}: ${errors.map((e) => e.message).join('; ')}`, rateLimited ? 429 : 400, rateLimited);
    }
    if (!res.body?.data) throw new ProviderError(`linear ${label}: respuesta vacía`, null, true);
    return res.body.data;
  }

  async whoami(): Promise<{ account_id: string; display_name?: string }> {
    const d = await this.gql<{ viewer: { id: string; name?: string } }>('query { viewer { id name } }', {}, 'viewer');
    return { account_id: d.viewer.id, ...(d.viewer.name ? { display_name: d.viewer.name } : {}) };
  }

  private async issue(key: string): Promise<LinearIssue> {
    const d = await this.gql<{ issue: LinearIssue | null }>(
      'query($id: String!) { issue(id: $id) { id identifier team { states { nodes { id name type } } } } }',
      { id: key },
      'issue',
    );
    if (!d.issue) throw new ProviderError(`linear: issue ${key} no encontrado`, 404, false);
    return d.issue;
  }

  async transitions(key: string): Promise<AvailableTransition[]> {
    const issue = await this.issue(key);
    return (issue.team?.states?.nodes ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      to_status: s.name,
      to_category: linearStatusCategory(s.type),
    }));
  }

  private update(id: string, input: Record<string, unknown>) {
    return this.gql('mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id, input }, 'issueUpdate');
  }

  private async comment(issueId: string, body: string): Promise<string | null> {
    const d = await this.gql<{ commentCreate: { comment?: { id: string } } }>(
      'mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }',
      { input: { issueId, body } },
      'commentCreate',
    );
    return d.commentCreate.comment?.id ?? null;
  }

  async execute(key: string, action: TaskAction): Promise<ExecuteResult> {
    const issue = await this.issue(key);
    switch (action.kind) {
      case 'transition': {
        const states = issue.team?.states?.nodes ?? [];
        const want = action.to_status ? normalizeName(action.to_status) : null;
        const st = states.find((s) => s.id === action.transition_id || (want !== null && normalizeName(s.name) === want));
        if (!st) {
          throw new ProviderError(
            `Estado "${action.to_status ?? action.transition_id}" no existe en el equipo de ${key}. Disponibles: ${states.map((s) => s.name).join(', ')}`,
            409,
            false,
          );
        }
        await this.update(issue.id, { stateId: st.id });
        const commentId = action.comment ? await this.comment(issue.id, action.comment) : null;
        const category = linearStatusCategory(st.type);
        return {
          status: 'sent',
          result: { state_id: st.id, to_status: st.name, to_category: category, ...(commentId ? { comment_id: commentId } : {}) },
          task_status: { status: st.name, status_category: category },
        };
      }
      case 'comment':
        return { status: 'sent', result: { comment_id: await this.comment(issue.id, action.body_markdown) } };
      case 'update_fields': {
        const skipped = Object.keys(action.fields).filter((f) => f !== 'story_points');
        if (action.fields.story_points === undefined) {
          return { status: 'skipped', result: { reason: 'Linear solo admite estimate (story_points)', skipped_fields: skipped } };
        }
        await this.update(issue.id, { estimate: action.fields.story_points });
        return { status: 'sent', result: { fields: ['story_points'], ...(skipped.length ? { skipped_fields: skipped } : {}) } };
      }
      case 'remote_link': {
        const d = await this.gql<{ attachmentLinkURL: { attachment?: { id: string } } }>(
          'mutation($issueId: String!, $url: String!, $title: String) { attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success attachment { id } } }',
          { issueId: issue.id, url: action.url, title: action.title },
          'attachmentLinkURL',
        );
        return { status: 'sent', result: { attachment_id: d.attachmentLinkURL.attachment?.id ?? null } };
      }
      case 'assign':
        await this.update(issue.id, { assigneeId: action.assignee_account_id });
        return { status: 'sent', result: { assignee_account_id: action.assignee_account_id } };
    }
  }
}
