import { beforeEach, describe, expect, it } from 'vitest';
import { keys, WEBHOOK_SIGNATURE_HEADERS, type IntegrationProvider, type RuleTrigger } from '@magicode/contracts';
import { HttpException } from '../../../common/exceptions';
import type { TriggerInput } from '../../task-sync/task-sync.types';
import { WebhookProjector } from '../webhooks.projection';
import { WebhooksService } from '../webhooks.service';
import { signBody } from '../webhooks.signature';
import { FakeIntegrations, FakeStore, fixture, fixtureRaw, lookupItem, SECRET, TENANT } from './helpers';

const NOW = '2026-10-20T20:00:00.000Z';
const GH_ID = 'int_0123456789abcdef';
const JIRA_ID = 'int_aaaaaaaaaaaaaaaa';

let store: FakeStore;
let ints: FakeIntegrations;
let fired: Array<{ trigger: RuleTrigger; input: TriggerInput }>;
let svc: WebhooksService;
let healthCalls: Array<{ fn: string; outcome?: string; event?: string; error?: string; signal?: unknown }>;

beforeEach(() => {
  healthCalls = [];
  store = new FakeStore();
  ints = new FakeIntegrations().add(lookupItem());
  fired = [];
  svc = new WebhooksService({
    integrations: ints.asRepo(),
    repo: store.asRepo(),
    projector: new WebhookProjector(store.asRepo()),
    fireTrigger: async (trigger, input) => void fired.push({ trigger, input }),
    health: {
      recordDelivery: async (_l, outcome, info) => void healthCalls.push({ fn: 'record', outcome, event: info.event, error: info.error }),
      onValidDelivery: async (_l, signal) => (healthCalls.push({ fn: 'valid', signal }), false),
      onInvalidSignature: async () => void healthCalls.push({ fn: 'invalid' }),
    },
    now: () => new Date(NOW),
  });
});

function request(
  provider: IntegrationProvider,
  body: string | Record<string, unknown>,
  event: string | undefined,
  o: { delivery?: string; integration?: string; headers?: Record<string, string>; secret?: string } = {},
) {
  const raw = typeof body === 'string' ? (body.endsWith('.json') ? fixtureRaw(body) : body) : JSON.stringify(body);
  const h = WEBHOOK_SIGNATURE_HEADERS[provider];
  return {
    provider,
    integration_id: o.integration ?? GH_ID,
    raw_body: raw,
    headers: {
      ...signBody(provider, raw, o.secret ?? SECRET),
      ...(event ? { [h.event]: event } : {}),
      [h.delivery]: o.delivery ?? 'delivery-1',
      ...(o.headers ?? {}),
    },
  };
}

async function expectHttp(p: Promise<unknown>, status: number, code?: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpException);
  expect((err as HttpException).statusCode).toBe(status);
  if (code) expect((err as HttpException).code).toBe(code);
}

describe('webhooks.service — autenticación y alcance', () => {
  it('404 si la integración no existe, está deshabilitada o el id es inválido', async () => {
    await expectHttp(svc.handle(request('github', 'github-ping.json', 'ping', { integration: 'int_ffffffffffffffff' })), 404, 'INTEGRATION_NOT_FOUND');
    await expectHttp(svc.handle(request('github', 'github-ping.json', 'ping', { integration: '../etc' })), 404);
    ints.lookups.get(GH_ID)!.status = 'disabled';
    await expectHttp(svc.handle(request('github', 'github-ping.json', 'ping')), 404);
  });

  it('404 proveedor desconocido; 400 si el proveedor no coincide con la integración', async () => {
    await expectHttp(svc.handle({ ...request('github', 'github-ping.json', 'ping'), provider: 'svn' }), 404, 'UNKNOWN_PROVIDER');
    await expectHttp(svc.handle(request('bitbucket', 'github-ping.json', 'diagnostics:ping')), 400, 'PROVIDER_MISMATCH');
  });

  it('401 con firma inválida o ausente (y no toca la base)', async () => {
    await expectHttp(svc.handle(request('github', 'github-push.json', 'push', { secret: 'b'.repeat(64) })), 401, 'INVALID_SIGNATURE');
    const r = request('github', 'github-push.json', 'push');
    delete (r.headers as Record<string, string>)['x-hub-signature-256'];
    await expectHttp(svc.handle(r), 401);
    expect(store.items.size).toBe(0);
    expect(store.deliveries.size).toBe(0);
  });

  it('400 si el cuerpo firmado no es JSON', async () => {
    await expectHttp(svc.handle(request('github', 'not json', 'push')), 400, 'INVALID_JSON');
  });

  it('ping → 200 y la integración pasa a active', async () => {
    expect(await svc.handle(request('github', 'github-ping.json', 'ping'))).toEqual({ status: 200, body: { ok: true, ping: true } });
    expect(ints.lookups.get(GH_ID)!.status).toBe('active');
    expect(ints.deliveries).toEqual([{ tenant: TENANT, id: GH_ID, at: NOW }]);
  });

  it('evento no soportado → 202 ignored', async () => {
    const out = await svc.handle(request('github', 'github-ping.json', 'star'));
    expect(out.status).toBe(202);
    expect(out.body).toMatchObject({ ignored: true });
  });

  it('otro repositorio (webhook de organización) → 202 fuera de alcance, sin escrituras', async () => {
    const p = fixture<Record<string, unknown>>('github-push.json');
    const out = await svc.handle(request('github', { ...p, repository: { full_name: 'acme/other' } }, 'push'));
    expect(out.status).toBe(202);
    expect(store.items.size).toBe(0);
  });

  it('el repo se compara sin distinguir mayúsculas y las claves usan el nombre configurado', async () => {
    const p = fixture<Record<string, unknown>>('github-push.json');
    await svc.handle(request('github', { ...p, repository: { full_name: 'ACME/Shop' } }, 'push'));
    expect(store.getSync(keys.branch(TENANT, 'acme/shop', 'feature/mag-123-login'))).toBeDefined();
  });
});

describe('webhooks.service — dedupe', () => {
  it('la misma delivery dos veces → la segunda es 200 {duplicate:true} y no reescribe', async () => {
    const first = await svc.handle(request('github', 'github-push.json', 'push'));
    expect(first).toEqual({ status: 200, body: { ok: true, processed: 1, kinds: ['repo.push'] } });
    const snapshot = JSON.stringify([...store.items.entries()], (_, v) => (v instanceof Set ? [...v] : v));
    const second = await svc.handle(request('github', 'github-push.json', 'push'));
    expect(second).toEqual({ status: 200, body: { ok: true, duplicate: true } });
    expect(JSON.stringify([...store.items.entries()], (_, v) => (v instanceof Set ? [...v] : v))).toBe(snapshot);
  });

  it('si la proyección falla se libera el dedupe y el reintento sí procesa', async () => {
    store.failUpdatesMatching = /^BRANCH#/;
    await expect(svc.handle(request('github', 'github-push.json', 'push'))).rejects.toThrow('boom');
    expect(store.deliveries.size).toBe(0);
    store.failUpdatesMatching = null;
    const retry = await svc.handle(request('github', 'github-push.json', 'push'));
    expect(retry.body).toMatchObject({ processed: 1 });
  });
});

describe('webhooks.service — push → commit verificado', () => {
  const SHA1 = '0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c';
  const SHA2 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

  it('marca verified_remote en el commit del IDE y crea uno mínimo para el que no se reportó', async () => {
    store.put({
      ...keys.commit(TENANT, 'acme/shop', SHA1),
      entity: 'Commit',
      sha: SHA1,
      repository: 'acme/shop',
      session_id: 'sess_01J9ZK',
      branch: 'feature/mag-123-login',
      task_keys: ['MAG-123'],
      automation: { commit_added_lines: 40, ai_matched_lines: 30, ai_share: 0.75, ai_lost_lines: 2, effective_lines: 21 },
      commit_source: 'git-local',
      provenance: 'real',
    });
    await svc.handle(request('github', 'github-push.json', 'push'));

    const c1 = store.getSync(keys.commit(TENANT, 'acme/shop', SHA1))!;
    expect(c1).toMatchObject({
      verified_remote: true,
      remote_pushed_at: NOW,
      remote_branch: 'feature/mag-123-login',
      remote_session_id: 'sess_01J9ZK',
      commit_source: 'git-local', // no se pisa lo que reportó el IDE
      automation: { ai_matched_lines: 30 },
      remote_files: { added: 2, modified: 1, removed: 0 },
    });
    expect(c1.task_keys).toEqual(['MAG-123', 'MAG-124']);
    expect(c1.remote_only).toBeUndefined();

    const c2 = store.getSync(keys.commit(TENANT, 'acme/shop', SHA2))!;
    expect(c2).toMatchObject({
      entity: 'Commit',
      verified_remote: true,
      remote_only: true,
      commit_source: 'git-remote',
      provenance: 'real',
      project_id: 'shop',
      session_id: '',
      automation: { ai_matched_lines: 0, commit_added_lines: 0 },
      task_keys: ['MAG-123'], // "UTF-8" del mensaje es ruido y se descarta
    });
    expect(JSON.stringify(c2)).not.toContain('UTF');
  });

  it('upsert de la rama + TaskLinks commit/sesión/rama', async () => {
    await svc.handle(request('github', 'github-push.json', 'push'));
    const branch = store.getSync(keys.branch(TENANT, 'acme/shop', 'feature/mag-123-login'))!;
    expect(branch).toMatchObject({
      entity: 'Branch',
      head_sha: SHA2,
      deleted: false,
      last_activity_at: NOW,
      ...keys.branchGsi1(TENANT, 'shop', NOW),
    });
    expect([...(branch.task_keys as Set<string>)].sort()).toEqual(['MAG-123', 'MAG-124']);
    expect((branch.commit_shas as Set<string>).size).toBe(2);

    const links = store.all('L#').map((l) => `${String(l.PK).split('#TASK#')[1]} ${l.SK}`).sort();
    expect(links).toEqual([
      `MAG-123 L#branch#feature/mag-123-login`,
      `MAG-123 L#commit#${SHA1}`,
      `MAG-123 L#commit#${SHA2}`,
      `MAG-123 L#session#sess_01J9ZK`,
      `MAG-124 L#branch#feature/mag-123-login`,
      `MAG-124 L#commit#${SHA1}`,
      `MAG-124 L#session#sess_01J9ZK`,
    ]);
  });

  it('con Jira configurado solo se aceptan sus prefijos de proyecto', async () => {
    ints.add(lookupItem({ integration_id: JIRA_ID, provider: 'jira', repository: undefined, task_project_keys: ['MAG'] }));
    const p = fixture<{ commits: Array<{ message: string }> }>('github-push.json');
    p.commits[1]!.message = 'ABC-9 unrelated';
    await svc.handle(request('github', p as never, 'push'));
    expect(store.getSync(keys.commit(TENANT, 'acme/shop', SHA2))!.task_keys).toEqual(['MAG-123']);
  });

  it('tag push solo verifica una Reference existente (nunca crea una) y dispara reference.marked', async () => {
    await svc.handle(request('github', 'github-push-tag.json', 'push', { delivery: 'tag-1' }));
    expect(store.all('REF#')).toHaveLength(0);

    store.put({ ...keys.reference(TENANT, 'acme/shop', 'v1.4.0'), entity: 'Reference', tag: 'v1.4.0', kind: 'demo-reference', included_shas: [SHA1] });
    store.put({ ...keys.commit(TENANT, 'acme/shop', SHA1), sha: SHA1, task_keys: ['MAG-123'] });
    await svc.handle(request('github', 'github-push-tag.json', 'push', { delivery: 'tag-2' }));
    expect(store.getSync(keys.reference(TENANT, 'acme/shop', 'v1.4.0'))).toMatchObject({ verified_remote: true, remote_sha: SHA2, kind: 'demo-reference' });
    expect(fired).toEqual([
      expect.objectContaining({ trigger: 'reference.marked', input: expect.objectContaining({ task_keys: ['MAG-123'], ref: 'ref:acme/shop:v1.4.0' }) }),
    ]);
  });
});

describe('webhooks.service — deployments (solo success es evidencia)', () => {
  const SHA = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432';
  const depKey = keys.deployment(TENANT, 'acme/shop', '987654321');
  const withState = (state: string) => {
    const p = fixture<Record<string, Record<string, unknown>>>('github-deployment_status-success.json');
    return { ...p, deployment_status: { ...p.deployment_status, state } };
  };

  beforeEach(() => {
    store.put({ ...keys.commit(TENANT, 'acme/shop', SHA), entity: 'Commit', sha: SHA, task_keys: ['MAG-123'] });
  });

  it('success → Deployment real con evidencia, GSI1 por sha, TaskLink y regla deployment.success', async () => {
    await svc.handle(request('github', 'github-deployment_status-success.json', 'deployment_status'));
    expect(store.getSync(depKey)).toMatchObject({
      entity: 'Deployment',
      state: 'success',
      deployed: true,
      evidence_url: 'https://github.com/acme/shop/actions/runs/998877/job/665544',
      source: 'deployment-evidence',
      provenance: 'real',
      succeeded_at: NOW,
      task_keys: ['MAG-123'],
      GSI1PK: `${keys.repoPk(TENANT, 'acme/shop')}#SHA#${SHA}`,
    });
    expect(store.getSync(keys.taskLink(TENANT, 'MAG-123', 'deployment', 'acme/shop:987654321'))).toMatchObject({ deployed: true, environment: 'production' });
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      trigger: 'deployment.success',
      input: { tenant_id: TENANT, project_id: 'shop', task_keys: ['MAG-123'], environment: 'production', ref: 'deploy:acme/shop:987654321' },
    });
  });

  it('failure → se guarda pero NO cuenta como despliegue ni dispara reglas', async () => {
    await svc.handle(request('github', withState('failure'), 'deployment_status'));
    expect(store.getSync(depKey)).toMatchObject({ state: 'failure', deployed: false });
    expect(store.getSync(depKey)!.evidence_url).toBeUndefined();
    expect(store.getSync(depKey)!.succeeded_at).toBeUndefined();
    expect(fired).toHaveLength(0);
  });

  it('un inactive posterior no borra la evidencia de success (latest_state lo registra)', async () => {
    await svc.handle(request('github', 'github-deployment_status-success.json', 'deployment_status', { delivery: 'd1' }));
    await svc.handle(request('github', withState('inactive'), 'deployment_status', { delivery: 'd2' }));
    expect(store.getSync(depKey)).toMatchObject({ state: 'success', latest_state: 'inactive', deployed: true });
    expect(fired).toHaveLength(1); // la regla no se re-dispara
  });

  it('tareas del deploy también salen del PR cuyo merge_sha coincide', async () => {
    store.items.clear();
    await svc.handle(request('github', 'github-pull_request-merged.json', 'pull_request', { delivery: 'pr' }));
    await svc.handle(request('github', 'github-deployment_status-success.json', 'deployment_status', { delivery: 'dep' }));
    expect(store.getSync(depKey)!.task_keys).toEqual(['MAG-123']);
  });
});

describe('webhooks.service — pull requests', () => {
  it('merged → PR merged, rama merged_into, TaskLink pr y regla pr.merged', async () => {
    await svc.handle(request('github', 'github-pull_request-merged.json', 'pull_request'));
    expect(store.getSync(keys.pullRequest(TENANT, 'acme/shop', 42))).toMatchObject({
      state: 'merged',
      merge_sha: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432',
      task_keys: ['MAG-123'],
      merged_at: NOW,
      ...keys.pullRequestGsi1(TENANT, 'shop', NOW),
    });
    expect(store.getSync(keys.branch(TENANT, 'acme/shop', 'feature/mag-123-login'))).toMatchObject({ merged_into: 'main' });
    expect(store.getSync(keys.taskLink(TENANT, 'MAG-123', 'pr', 'acme/shop:42'))).toMatchObject({ number: 42, state: 'merged' });
    expect(fired.map((f) => f.trigger)).toEqual(['pr.merged']);
    expect(fired[0]!.input).toMatchObject({ target_branch: 'main', vars: { pr_url: 'https://github.com/acme/shop/pull/42' } });
  });

  it('un evento atrasado no "des-fusiona" el PR', async () => {
    await svc.handle(request('github', 'github-pull_request-merged.json', 'pull_request', { delivery: 'a' }));
    const p = fixture<{ pull_request: Record<string, unknown> }>('github-pull_request-merged.json');
    const late = { ...p, action: 'synchronize', pull_request: { ...p.pull_request, state: 'open', merged: false } };
    await svc.handle(request('github', late as never, 'pull_request', { delivery: 'b' }));
    expect(store.getSync(keys.pullRequest(TENANT, 'acme/shop', 42))!.state).toBe('merged');
  });

  it('opened → pr.opened con claves de la rama origen', async () => {
    await svc.handle(request('github', 'github-pull_request-opened.json', 'pull_request'));
    expect(fired).toEqual([
      expect.objectContaining({ trigger: 'pr.opened', input: expect.objectContaining({ task_keys: ['MAG-130'], target_branch: 'main', ref: 'pr:acme/shop:43' }) }),
    ]);
  });
});

describe('webhooks.service — Jira', () => {
  beforeEach(() => {
    ints.add(lookupItem({ integration_id: JIRA_ID, provider: 'jira', repository: undefined, task_project_keys: ['MAG'], base_url: 'https://example.atlassian.net' }));
  });
  const jira = (body: string | Record<string, unknown>, delivery = 'j1') => request('jira', body, 'Primary', { integration: JIRA_ID, delivery });

  it('issue_updated → Task (GSI1 por proyecto) y entregas viejas no pisan las nuevas', async () => {
    await svc.handle(jira('jira-issue_updated.json'));
    const task = store.getSync(keys.task(TENANT, 'MAG-123'))!;
    expect(task).toMatchObject({
      entity: 'Task',
      title: 'Login form',
      status: 'En curso',
      status_category: 'in_progress',
      story_points: 5,
      url: 'https://example.atlassian.net/browse/MAG-123',
      integration_id: JIRA_ID,
      source_updated_at: '2026-10-20T13:20:00.000Z',
      ...keys.taskGsi1(TENANT, 'shop', '2026-10-20T13:20:00.000Z'),
    });
    const p = fixture<{ issue: { fields: Record<string, unknown> } }>('jira-issue_updated.json');
    p.issue.fields.updated = '2026-10-19T00:00:00.000+0000';
    p.issue.fields.summary = 'OLD';
    await svc.handle(jira(p as never, 'j2'));
    expect(store.getSync(keys.task(TENANT, 'MAG-123'))!.title).toBe('Login form');
  });

  it('proyecto Jira no configurado → 202', async () => {
    const p = fixture<{ issue: Record<string, unknown> }>('jira-issue_updated.json');
    const out = await svc.handle(jira({ ...p, issue: { ...p.issue, key: 'OPS-1' } }));
    expect(out.status).toBe(202);
  });

  it('eco del propio write-back → 200 {ignored:"self"} sin escribir', async () => {
    ints.lookups.get(JIRA_ID)!.service_account_id = 'fake-account-ana-0001';
    expect(await svc.handle(jira('jira-issue_updated.json'))).toEqual({ status: 200, body: { ok: true, ignored: 'self' } });
    expect(store.items.size).toBe(0);
  });

  it('issue_deleted → deleted=true sobre la tarea existente', async () => {
    await svc.handle(jira('jira-issue_updated.json', 'a'));
    const p = fixture<{ issue: Record<string, unknown> }>('jira-issue_deleted.json');
    await svc.handle(jira({ ...p, issue: { ...p.issue, key: 'MAG-123' } }, 'b'));
    expect(store.getSync(keys.task(TENANT, 'MAG-123'))).toMatchObject({ deleted: true });
  });
});
