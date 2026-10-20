import { describe, expect, it } from 'vitest';
import { REQUIRED_WEBHOOK_EVENTS } from '@magicode/contracts';
import { FakeCredentials, FakeTaskSyncRepo, JIRA_CREDS, mockFetch } from '../../task-sync/__tests__/helpers';
import { TaskSyncService } from '../../task-sync/task-sync.service';
import { FakeIntegrations, FakeStore, lookupItem, TENANT } from '../../webhooks/__tests__/helpers';
import { TasksRepository } from '../../tasks/tasks.repository';
import { HttpException } from '../../../common/exceptions';
import { BitbucketHooks, findHook, GitHubHooks, GitLabHooks, JiraHooks, jqlFor } from '../provider-hooks.client';

const URL_ = 'https://api.example.com/api/v1/webhooks/github/int_0123456789abcdef';
const spec = { url: URL_, secret: 's3cr3t-fake', events: REQUIRED_WEBHOOK_EVENTS.github };
const http = (m: ReturnType<typeof mockFetch>) => ({ fetch: m.fetch, sleep: async () => {} });

describe('GitHubHooks', () => {
  it('lista, crea (content_type json + secreto + eventos), hace ping y lee entregas', async () => {
    const m = mockFetch([
      { method: 'GET', path: /\/repos\/acme\/shop\/hooks\?per_page=100$/, body: [{ id: 77, active: true, events: ['push'], config: { url: URL_ + '/' } }] },
      { method: 'POST', path: /\/repos\/acme\/shop\/hooks$/, status: 201, body: { id: 78, active: true, events: spec.events, config: { url: URL_ } } },
      { method: 'POST', path: /\/hooks\/78\/pings$/, status: 204 },
      { method: 'GET', path: /\/hooks\/78\/deliveries\?per_page=10$/, body: [{ status_code: 200, event: 'ping', delivered_at: '2026-10-20T20:00:00Z', guid: 'x' }] },
    ]);
    const gh = new GitHubHooks({ provider: 'github', token: 'ghp_fake_token_not_real_0000000000' }, 'acme/shop', http(m));
    const hooks = await gh.listHooks();
    expect(findHook(hooks, URL_)?.id).toBe('77'); // compara sin barra final
    expect(await gh.createHook(spec)).toEqual({ id: '78', url: URL_, active: true, events: spec.events });
    expect(m.calls[1]!.body).toEqual({ name: 'web', active: true, events: spec.events, config: { url: URL_, content_type: 'json', secret: 's3cr3t-fake', insecure_ssl: '0' } });
    expect(m.calls[1]!.headers.Authorization).toBe('Bearer ghp_fake_token_not_real_0000000000');
    await gh.ping('78');
    expect(await gh.deliveries('78')).toEqual([{ status_code: 200, event: 'ping', delivered_at: '2026-10-20T20:00:00Z' }]);
  });

  it('GitHub Enterprise: usa api_url', async () => {
    const m = mockFetch([{ method: 'GET', path: /hooks/, body: [] }]);
    await new GitHubHooks({ provider: 'github', token: 'ghp_fake_token_not_real_0000000000', api_url: 'https://ghe.example.com/api/v3' }, 'acme/shop', http(m)).listHooks();
    expect(m.calls[0]!.url).toBe('https://ghe.example.com/api/v3/repos/acme/shop/hooks?per_page=100');
  });
});

describe('BitbucketHooks / GitLabHooks / JiraHooks', () => {
  it('Bitbucket: Basic auth, values[], update por uuid', async () => {
    const m = mockFetch([
      { method: 'GET', path: /\/2\.0\/repositories\/acme\/payments\/hooks/, body: { values: [{ uuid: '{abc}', url: URL_, active: true, events: ['repo:push'] }] } },
      { method: 'PUT', path: /\/hooks\/%7Babc%7D$/, body: { uuid: '{abc}', url: URL_, active: true, events: REQUIRED_WEBHOOK_EVENTS.bitbucket } },
    ]);
    const bb = new BitbucketHooks({ provider: 'bitbucket', username: 'ana', app_password: 'fake-app-pass' }, 'acme/payments', http(m));
    expect(await bb.listHooks()).toEqual([{ id: '{abc}', url: URL_, active: true, events: ['repo:push'] }]);
    await bb.updateHook('{abc}', { ...spec, events: REQUIRED_WEBHOOK_EVENTS.bitbucket });
    expect(m.calls[1]!.body).toMatchObject({ url: URL_, active: true, secret: 's3cr3t-fake', events: REQUIRED_WEBHOOK_EVENTS.bitbucket });
  });

  it('GitLab: proyecto url-encoded, flags de eventos y token como secreto', async () => {
    const m = mockFetch([
      { method: 'POST', path: /\/api\/v4\/projects\/g%2Fsub%2Fp\/hooks$/, status: 201, body: { id: 5, url: URL_, push_events: true, tag_push_events: true, merge_requests_events: true, deployment_events: false } },
      { method: 'POST', path: /\/hooks\/5\/test\/push_events$/, status: 201, body: {} },
    ]);
    const gl = new GitLabHooks({ provider: 'gitlab', token: 'glpat-fake-token-0000000000' }, 'g/sub/p', http(m));
    const hook = await gl.createHook({ ...spec, events: REQUIRED_WEBHOOK_EVENTS.gitlab });
    expect(hook.events).toEqual(['push_events', 'tag_push_events', 'merge_requests_events']);
    expect(m.calls[0]!.body).toMatchObject({ url: URL_, token: 's3cr3t-fake', push_events: true, deployment_events: true });
    expect(m.calls[0]!.headers['PRIVATE-TOKEN']).toBe('glpat-fake-token-0000000000');
    await gl.ping('5');
  });

  it('Jira: webhook admin con JQL y secreto; etiqueta de healthcheck add/remove', async () => {
    const m = mockFetch([
      { method: 'POST', path: /\/rest\/webhooks\/1\.0\/webhook$/, status: 201, body: { self: 'https://example.atlassian.net/rest/webhooks/1.0/webhook/12', url: URL_, events: REQUIRED_WEBHOOK_EVENTS.jira, enabled: true } },
      { method: 'PUT', path: /\/rest\/api\/3\/issue\/MAG-1\?notifyUsers=false$/, status: 204 },
      { method: 'PUT', path: /\/rest\/api\/3\/issue\/MAG-1\?notifyUsers=false$/, status: 204 },
    ]);
    const jira = new JiraHooks(JIRA_CREDS, http(m));
    expect((await jira.createHook({ ...spec, events: REQUIRED_WEBHOOK_EVENTS.jira, task_project_keys: ['MAG'] })).id).toBe('12');
    expect(m.calls[0]!.body).toMatchObject({ name: 'MagiCode', url: URL_, filters: { 'issue-related-events-section': 'project in (MAG)' }, secret: 's3cr3t-fake', excludeBody: false });
    await jira.toggleHealthcheckLabel('MAG-1', 'magicode-healthcheck');
    expect(m.calls.slice(1).map((c) => c.body)).toEqual([{ update: { labels: [{ add: 'magicode-healthcheck' }] } }, { update: { labels: [{ remove: 'magicode-healthcheck' }] } }]);
    expect(jqlFor([])).toBe('');
  });
});

describe('PUT /integrations/:id/credentials con credenciales git', () => {
  function build(routes: Parameters<typeof mockFetch>[0]) {
    const repo = new FakeTaskSyncRepo();
    const creds = new FakeCredentials();
    const ints = new FakeIntegrations().add(lookupItem());
    const m = mockFetch(routes);
    const svc = new TaskSyncService({
      repo: repo.asRepo(),
      integrations: ints.asRepo(),
      tasks: new TasksRepository(new FakeStore().asRepo()),
      credentials: creds.asStore(),
      http: http(m),
    });
    return { svc, repo, creds, m };
  }
  const scope = { tenant_id: TENANT, key_id: 'key_1' };
  const ghCreds = { provider: 'github', token: 'ghp_fake_token_not_real_0000000000' };

  it('verifica GET repo + GET hooks, guarda en el store y marca credentials_configured_at (sin reglas)', async () => {
    const { svc, repo, creds, m } = build([
      { method: 'GET', path: /\/repos\/acme\/shop$/, body: { full_name: 'acme/shop' } },
      { method: 'GET', path: /\/repos\/acme\/shop\/hooks/, body: [] },
    ]);
    await svc.saveCredentials(scope, 'int_0123456789abcdef', ghCreds);
    expect(m.calls.map((c) => c.url)).toEqual(['https://api.github.com/repos/acme/shop', 'https://api.github.com/repos/acme/shop/hooks?per_page=100']);
    expect(creds.saved.get('int_0123456789abcdef')).toEqual(ghCreds);
    expect(repo.credentials).toEqual([{ integration: 'int_0123456789abcdef', managed_field_ids: [] }]);
    expect(repo.rules).toHaveLength(0);
  });

  it('token sin acceso al repo (404) o sin permiso de webhooks (403) → 422; proveedor distinto → 400', async () => {
    const a = build([{ method: 'GET', path: /\/repos\/acme\/shop$/, status: 404, body: { message: 'Not Found' } }]);
    await expect(a.svc.saveCredentials(scope, 'int_0123456789abcdef', ghCreds)).rejects.toSatisfy((e) => e instanceof HttpException && e.statusCode === 422 && /no ve el repositorio/.test(e.message));
    const b = build([
      { method: 'GET', path: /\/repos\/acme\/shop$/, body: {} },
      { method: 'GET', path: /hooks/, status: 403, body: { message: 'Resource not accessible by personal access token' } },
    ]);
    await expect(b.svc.saveCredentials(scope, 'int_0123456789abcdef', ghCreds)).rejects.toSatisfy((e) => e instanceof HttpException && e.statusCode === 422);
    expect(b.creds.saved.size).toBe(0);
    await expect(b.svc.saveCredentials(scope, 'int_0123456789abcdef', { provider: 'gitlab', token: 'glpat-fake-token-0000000000' })).rejects.toSatisfy(
      (e) => e instanceof HttpException && e.statusCode === 400,
    );
  });
});
