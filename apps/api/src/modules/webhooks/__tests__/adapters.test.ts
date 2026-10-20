import { describe, expect, it } from 'vitest';
import { extractTaskKeys, type NormalizedWebhookEvent } from '@magicode/contracts';
import { adaptWebhook } from '../adapters';
import { jiraStatusCategory, parseTrailers, toIso } from '../adapters/common';
import { isHealthcheckChange, isSelfEcho } from '../adapters/jira.adapter';
import { linearStatusCategory } from '../adapters/linear.adapter';
import type { AdapterInput, AdaptResult } from '../webhooks.types';
import { fixture } from './helpers';

const RECEIVED = '2026-10-20T20:00:00.000Z';
const input = (event: string | undefined, name: string, options?: AdapterInput['options']): AdapterInput => ({
  event,
  payload: fixture(name),
  delivery_id: 'd-1',
  integration_id: 'int_0123456789abcdef',
  received_at: RECEIVED,
  ...(options ? { options } : {}),
});

function events(res: AdaptResult): NormalizedWebhookEvent[] {
  if (res.type !== 'events') throw new Error(`esperaba eventos, llegó ${res.type}: ${'reason' in res ? res.reason : ''}`);
  return res.events;
}
const only = <K extends NormalizedWebhookEvent['kind']>(res: AdaptResult, kind: K) => {
  const evs = events(res);
  expect(evs).toHaveLength(1);
  expect(evs[0]!.kind).toBe(kind);
  return evs[0] as Extract<NormalizedWebhookEvent, { kind: K }>;
};

describe('extractTaskKeys / trailers', () => {
  it('extrae la clave de una rama en minúsculas', () => {
    expect(extractTaskKeys('feature/mag-123-login')).toEqual(['MAG-123']);
  });

  it('parsea MagiCode-Session y MagiCode-Task de un mensaje', () => {
    const t = parseTrailers('feat: x\n\nMagiCode-Session: sess_01J9ZK\nMagiCode-Task: MAG-124, MAG-125');
    expect(t).toEqual({ session_id: 'sess_01J9ZK', task_keys: ['MAG-124', 'MAG-125'] });
    expect(parseTrailers('sin trailers')).toEqual({ task_keys: [] });
  });

  it('toIso normaliza el formato +0000 de Jira y epoch ms', () => {
    expect(toIso('2026-10-20T13:20:00.000+0000', 'x')).toBe('2026-10-20T13:20:00.000Z');
    expect(toIso(1760966400000, 'x')).toBe('2025-10-20T13:20:00.000Z');
    expect(toIso('no-date', 'fallback')).toBe('fallback');
  });
});

describe('github adapter', () => {
  it('push → repo.push con commits, claves y trailer de sesión (sin mensajes)', () => {
    const ev = only(adaptWebhook('github', input('push', 'github-push.json')), 'repo.push');
    expect(ev).toMatchObject({
      provider: 'github',
      repository: 'acme/shop',
      branch: 'feature/mag-123-login',
      before: '6113728f27ae82c7b1a177c8d03f9e96e0adf246',
      after: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      forced: false,
    });
    expect(ev.commits).toHaveLength(2);
    expect(ev.commits[0]).toEqual({
      sha: '0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c',
      message_task_keys: ['MAG-123', 'MAG-124'],
      author_login: 'anadev',
      timestamp: '2026-10-20T14:15:22.000Z',
      files_added: 2,
      files_modified: 1,
      files_removed: 0,
      has_session_trailer: true,
      session_id: 'sess_01J9ZK',
    });
    expect(ev.commits[1]!.has_session_trailer).toBe(false);
    expect(JSON.stringify(ev)).not.toContain('add login form'); // nunca el mensaje
  });

  it('push de tag → repo.tag created con el SHA', () => {
    const ev = only(adaptWebhook('github', input('push', 'github-push-tag.json')), 'repo.tag');
    expect(ev).toMatchObject({ tag: 'v1.4.0', sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', action: 'created' });
  });

  it('push borrando rama → repo.branch deleted', () => {
    const payload = { ...fixture('github-push.json'), deleted: true, after: '0'.repeat(40), commits: [] };
    const ev = only(adaptWebhook('github', { ...input('push', 'github-push.json'), payload }), 'repo.branch');
    expect(ev).toMatchObject({ branch: 'feature/mag-123-login', action: 'deleted' });
  });

  it('create branch → repo.branch created; delete tag → ignorado (llega por push)', () => {
    const ev = only(adaptWebhook('github', input('create', 'github-create-branch.json')), 'repo.branch');
    expect(ev).toMatchObject({ branch: 'feature/MAG-130-checkout', action: 'created' });
    expect(adaptWebhook('github', input('delete', 'github-delete-tag.json')).type).toBe('ignored');
  });

  it('pull_request closed+merged → state merged con merge_sha', () => {
    const ev = only(adaptWebhook('github', input('pull_request', 'github-pull_request-merged.json')), 'repo.pull_request');
    expect(ev).toMatchObject({
      number: 42,
      state: 'merged',
      title_task_keys: ['MAG-123'],
      source_branch: 'feature/mag-123-login',
      target_branch: 'main',
      merge_sha: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432',
      head_sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      url: 'https://github.com/acme/shop/pull/42',
      author_login: 'anadev',
    });
  });

  it('pull_request opened → open y SIN merge_sha (el de prueba no cuenta)', () => {
    const ev = only(adaptWebhook('github', input('pull_request', 'github-pull_request-opened.json')), 'repo.pull_request');
    expect(ev).toMatchObject({ state: 'open', merge_sha: null, title_task_keys: [], author_login: 'CarlosDev' });
  });

  it('pull_request sin user → sin author_login', () => {
    const p = fixture<Record<string, Record<string, unknown>>>('github-pull_request-opened.json');
    const payload = { ...p, pull_request: { ...p.pull_request, user: null } };
    const ev = only(adaptWebhook('github', { ...input('pull_request', 'github-pull_request-opened.json'), payload }), 'repo.pull_request');
    expect(ev.author_login).toBeUndefined();
  });

  it('pull_request con acción no relevante → ignorado', () => {
    const payload = { ...fixture('github-pull_request-opened.json'), action: 'labeled' };
    expect(adaptWebhook('github', { ...input('pull_request', 'github-pull_request-opened.json'), payload }).type).toBe('ignored');
  });

  it('deployment_status → repo.deployment (sha de deployment.sha, url target||log)', () => {
    const ev = only(adaptWebhook('github', input('deployment_status', 'github-deployment_status-success.json')), 'repo.deployment');
    expect(ev).toMatchObject({
      deployment_id: '987654321',
      sha: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432',
      ref: 'main',
      environment: 'production',
      state: 'success',
      url: 'https://github.com/acme/shop/actions/runs/998877/job/665544',
    });
  });

  it('deployment_status queued → pending', () => {
    const p = fixture<Record<string, Record<string, unknown>>>('github-deployment_status-success.json');
    const payload = { ...p, deployment_status: { ...p.deployment_status, state: 'queued' } };
    const ev = only(adaptWebhook('github', { ...input('deployment_status', 'github-deployment_status-success.json'), payload }), 'repo.deployment');
    expect(ev.state).toBe('pending');
  });

  it('ping → ping; evento desconocido → ignored', () => {
    expect(adaptWebhook('github', input('ping', 'github-ping.json'))).toEqual({ type: 'ping' });
    expect(adaptWebhook('github', input('watch', 'github-ping.json')).type).toBe('ignored');
  });
});

describe('bitbucket adapter', () => {
  it('repo:push → push de rama + tag + rama cerrada', () => {
    const evs = events(adaptWebhook('bitbucket', input('repo:push', 'bitbucket-repo-push.json')));
    expect(evs.map((e) => e.kind)).toEqual(['repo.push', 'repo.tag', 'repo.branch']);
    const push = evs[0] as Extract<NormalizedWebhookEvent, { kind: 'repo.push' }>;
    expect(push).toMatchObject({
      repository: 'acme/payments',
      branch: 'feature/PAY-7-refunds',
      before: 'beef0000beef0000beef0000beef0000beef0000',
      after: 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00',
    });
    expect(push.commits[0]).toMatchObject({ message_task_keys: ['PAY-7'], session_id: 'sess_bb1', author_login: 'anadev', files_added: 0 });
    expect(evs[1]).toMatchObject({ tag: 'v2.0.0', action: 'created' });
    expect(evs[2]).toMatchObject({ branch: 'old/experiment', action: 'deleted' });
  });

  it('pullrequest:fulfilled → merged', () => {
    const ev = only(adaptWebhook('bitbucket', input('pullrequest:fulfilled', 'bitbucket-pullrequest-fulfilled.json')), 'repo.pull_request');
    expect(ev).toMatchObject({
      number: 17,
      state: 'merged',
      merge_sha: 'd00d1234d00d',
      source_branch: 'feature/PAY-7-refunds',
      target_branch: 'main',
      title_task_keys: ['PAY-7'],
      url: 'https://bitbucket.org/acme/payments/pull-requests/17',
      author_login: 'anadev',
    });
  });

  it('pullrequest sin nickname → author_login = display_name', () => {
    const p = fixture<Record<string, Record<string, unknown>>>('bitbucket-pullrequest-fulfilled.json');
    const payload = { ...p, pullrequest: { ...p.pullrequest, author: { display_name: 'Ana Dev' } } };
    const ev = only(adaptWebhook('bitbucket', { ...input('pullrequest:fulfilled', 'bitbucket-pullrequest-fulfilled.json'), payload }), 'repo.pull_request');
    expect(ev.author_login).toBe('Ana Dev');
  });

  it('pullrequest:rejected → closed sin merge_sha', () => {
    const p = fixture<Record<string, Record<string, unknown>>>('bitbucket-pullrequest-fulfilled.json');
    const payload = { ...p, pullrequest: { ...p.pullrequest, state: 'DECLINED' } };
    const ev = only(adaptWebhook('bitbucket', { ...input('pullrequest:rejected', 'bitbucket-pullrequest-fulfilled.json'), payload }), 'repo.pull_request');
    expect(ev).toMatchObject({ state: 'closed', merge_sha: null });
  });

  it('diagnostics:ping → ping', () => {
    expect(adaptWebhook('bitbucket', input('diagnostics:ping', 'bitbucket-repo-push.json')).type).toBe('ping');
  });
});

describe('gitlab adapter', () => {
  it('push → repo.push con archivos', () => {
    const ev = only(adaptWebhook('gitlab', input('Push Hook', 'gitlab-push.json')), 'repo.push');
    expect(ev).toMatchObject({ repository: 'acme/infra', branch: 'feature/OPS-12-alerts' });
    expect(ev.commits[0]).toMatchObject({ message_task_keys: ['OPS-12'], files_added: 1, files_modified: 1, timestamp: '2026-10-20T08:00:00.000Z' });
  });

  it('merge_request merged', () => {
    const ev = only(adaptWebhook('gitlab', input('Merge Request Hook', 'gitlab-merge_request.json')), 'repo.pull_request');
    expect(ev).toMatchObject({ number: 5, state: 'merged', merge_sha: '0123456789abcdef0123456789abcdef01234567', head_sha: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7', author_login: 'jsmith' });
  });

  it('deployment → SHA completo desde commit_url', () => {
    const ev = only(adaptWebhook('gitlab', input('Deployment Hook', 'gitlab-deployment.json')), 'repo.deployment');
    expect(ev).toMatchObject({ deployment_id: '15', sha: '0123456789abcdef0123456789abcdef01234567', environment: 'staging', state: 'success' });
  });
});

describe('jira adapter', () => {
  it('issue_updated → task.upserted con story points, categoría y URL', () => {
    const ev = only(adaptWebhook('jira', input('Primary', 'jira-issue_updated.json')), 'task.upserted');
    expect(ev).toEqual({
      delivery_id: 'd-1',
      integration_id: 'int_0123456789abcdef',
      provider: 'jira',
      received_at: RECEIVED,
      kind: 'task.upserted',
      task_key: 'MAG-123',
      title: 'Login form',
      type: 'Story',
      status: 'En curso',
      status_category: 'in_progress',
      assignee: 'Ana Dev',
      story_points: 5,
      url: 'https://example.atlassian.net/browse/MAG-123',
      updated_at: '2026-10-20T13:20:00.000Z',
    });
  });

  it('usa base_url de la integración y el campo de story points configurado', () => {
    const p = fixture<{ issue: { fields: Record<string, unknown> } }>('jira-issue_updated.json');
    p.issue.fields.customfield_10028 = 8;
    const ev = only(
      adaptWebhook('jira', { ...input(undefined, 'jira-issue_updated.json', { base_url: 'https://jira.example.com/', story_points_field: 'customfield_10028' }), payload: p }),
      'task.upserted',
    );
    expect(ev.url).toBe('https://jira.example.com/browse/MAG-123');
    expect(ev.story_points).toBe(8);
  });

  it('issue_deleted → task.deleted', () => {
    expect(only(adaptWebhook('jira', input(undefined, 'jira-issue_deleted.json')), 'task.deleted').task_key).toBe('MAG-200');
  });

  it('statusCategory new|indeterminate|done → todo|in_progress|done', () => {
    expect(jiraStatusCategory('new')).toBe('todo');
    expect(jiraStatusCategory('indeterminate')).toBe('in_progress');
    expect(jiraStatusCategory('done')).toBe('done');
    expect(jiraStatusCategory(undefined)).toBe('todo');
    for (const [key, expected] of [['new', 'todo'], ['indeterminate', 'in_progress'], ['done', 'done']] as const) {
      const p = fixture<{ issue: { fields: { status: { statusCategory: { key: string } } } } }>('jira-issue_updated.json');
      p.issue.fields.status.statusCategory.key = key;
      expect(only(adaptWebhook('jira', { ...input(undefined, 'jira-issue_updated.json'), payload: p }), 'task.upserted').status_category).toBe(expected);
    }
  });

  it('comment_created u otros eventos → ignorado', () => {
    const payload = { ...fixture('jira-issue_updated.json'), webhookEvent: 'comment_created' };
    expect(adaptWebhook('jira', { ...input(undefined, 'jira-issue_updated.json'), payload }).type).toBe('ignored');
  });

  describe('prueba de ida y vuelta (etiqueta magicode-healthcheck)', () => {
    const withLabels = (from: string, to: string, extra: unknown[] = []) => {
      const p = fixture<{ changelog: { items: unknown[] } }>('jira-issue_updated.json');
      p.changelog.items = [{ field: 'labels', fieldId: 'labels', fromString: from, toString: to }, ...extra];
      return p;
    };
    it('solo agregar/quitar la etiqueta ⇒ type test (antes que el anti-bucle)', () => {
      expect(isHealthcheckChange(withLabels('a', 'a magicode-healthcheck') as never)).toBe(true);
      expect(isHealthcheckChange(withLabels('magicode-healthcheck', '') as never)).toBe(true);
      const res = adaptWebhook('jira', { ...input(undefined, 'jira-issue_updated.json', { service_account_id: 'fake-account-ana-0001' }), payload: withLabels('', 'magicode-healthcheck') });
      expect(res).toEqual({ type: 'test', task_key: 'MAG-123' });
    });
    it('otras etiquetas o más cambios ⇒ no es prueba', () => {
      expect(isHealthcheckChange(withLabels('', 'urgent') as never)).toBe(false);
      expect(isHealthcheckChange(withLabels('', 'magicode-healthcheck', [{ field: 'status', fieldId: 'status' }]) as never)).toBe(false);
    });
  });

  describe('anti-bucle', () => {
    const SA = 'fake-account-ana-0001';
    it('ignora (self) un cambio de estado hecho por la cuenta de servicio', () => {
      const res = adaptWebhook('jira', input(undefined, 'jira-issue_updated.json', { service_account_id: SA }));
      expect(res).toEqual({ type: 'ignored', reason: 'self', self: true });
    });

    it('procesa si la cuenta de servicio tocó campos que MagiCode no gestiona', () => {
      const p = fixture<{ changelog: { items: unknown[] } }>('jira-issue_updated.json');
      p.changelog.items.push({ field: 'summary', fieldId: 'summary', toString: 'Nuevo título' });
      expect(isSelfEcho(p as never, SA)).toBe(false);
      expect(adaptWebhook('jira', { ...input(undefined, 'jira-issue_updated.json', { service_account_id: SA }), payload: p }).type).toBe('events');
    });

    it('procesa si el actor es otra persona; los campos gestionados configurados cuentan', () => {
      expect(isSelfEcho(fixture('jira-issue_updated.json'), 'otra-cuenta')).toBe(false);
      const p = fixture<{ changelog: { items: unknown[] } }>('jira-issue_updated.json');
      p.changelog.items = [{ field: 'MagiCode tokens', fieldId: 'customfield_10100' }];
      expect(isSelfEcho(p as never, SA, ['customfield_10100'])).toBe(true);
      expect(isSelfEcho(p as never, SA)).toBe(false);
    });
  });
});

describe('linear adapter', () => {
  it('Issue update → task.upserted', () => {
    const ev = only(adaptWebhook('linear', input('Issue', 'linear-issue-update.json')), 'task.upserted');
    expect(ev).toMatchObject({
      task_key: 'ENG-42',
      title: 'Payments retry',
      status: 'In Progress',
      status_category: 'in_progress',
      assignee: 'Ana Dev',
      story_points: 3,
      url: 'https://linear.app/acme/issue/ENG-42/payments-retry',
    });
  });

  it('Issue remove → task.deleted; Comment → ignorado', () => {
    const p = fixture('linear-issue-update.json');
    expect(only(adaptWebhook('linear', { ...input('Issue', 'linear-issue-update.json'), payload: { ...p, action: 'remove' } }), 'task.deleted').task_key).toBe('ENG-42');
    expect(adaptWebhook('linear', { ...input('Comment', 'linear-issue-update.json'), payload: { ...p, type: 'Comment' } }).type).toBe('ignored');
  });

  it('state.type → categoría', () => {
    expect(linearStatusCategory('backlog')).toBe('todo');
    expect(linearStatusCategory('started')).toBe('in_progress');
    expect(linearStatusCategory('completed')).toBe('done');
    expect(linearStatusCategory('canceled')).toBe('done');
  });
});
