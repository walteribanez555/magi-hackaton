import { beforeEach, describe, expect, it } from 'vitest';
import { keys, OutboxAction, type TaskProviderCredentials } from '@magicode/contracts';
import { HttpException } from '../../../common/exceptions';
import { TasksRepository } from '../../tasks/tasks.repository';
import { FakeIntegrations, FakeStore, lookupItem, TENANT } from '../../webhooks/__tests__/helpers';
import { JiraClient } from '../jira.client';
import { COMMIT_URL_UNKNOWN } from '../rules.engine';
import { MAX_ATTEMPTS, RetryableOutboxError, TaskSyncService } from '../task-sync.service';
import type { TaskMetrics } from '../../tasks/tasks.types';
import { FakeCredentials, FakeTaskSyncRepo, JIRA_CREDS, mockFetch } from './helpers';

const JIRA_ID = 'int_aaaaaaaaaaaaaaaa';
const GH_ID = 'int_0123456789abcdef';
const scope = { tenant_id: TENANT, key_id: 'key_1' };
let now = new Date('2026-10-20T20:00:00.000Z');

let repo: FakeTaskSyncRepo;
let ints: FakeIntegrations;
let store: FakeStore;
let creds: FakeCredentials;
let fetchRoutes: Parameters<typeof mockFetch>[0];
let fetchCalls: ReturnType<typeof mockFetch>['calls'];
let svc: TaskSyncService;

const METRICS: TaskMetrics = { tokens: { value: 1500, provenance: 'estimated' }, accepted_lines: 50, effective_lines: 27.5, criticality: 'medium' };

function build() {
  const m = mockFetch(fetchRoutes);
  fetchCalls = m.calls;
  svc = new TaskSyncService({
    repo: repo.asRepo(),
    integrations: ints.asRepo(),
    tasks: new TasksRepository(store.asRepo()),
    taskMetrics: { metricsFor: async () => ({ links: [], metrics: METRICS }) },
    credentials: creds.asStore(),
    now: () => now,
    clientFor: (c: TaskProviderCredentials) => new JiraClient(c as never, { fetch: m.fetch, sleep: async () => {} }, () => now),
  });
}

beforeEach(() => {
  now = new Date('2026-10-20T20:00:00.000Z');
  repo = new FakeTaskSyncRepo();
  store = new FakeStore();
  creds = new FakeCredentials();
  ints = new FakeIntegrations()
    .add(lookupItem())
    .add(lookupItem({ integration_id: JIRA_ID, provider: 'jira', repository: undefined, task_project_keys: ['MAG'], status: 'active' }));
  store.put({ ...keys.task(TENANT, 'MAG-123'), task_key: 'MAG-123', project_id: 'shop', integration_id: JIRA_ID, status: 'En curso', status_category: 'in_progress' });
  fetchRoutes = [{ method: 'GET', path: /myself$/, body: { accountId: 'fake-svc-1' } }];
  build();
});

const outbox = () => [...repo.outbox.values()];

describe('credenciales', () => {
  it('verifica /myself, guarda en el store, registra la cuenta de servicio y siembra reglas una vez', async () => {
    await svc.saveCredentials(scope, JIRA_ID, JIRA_CREDS);
    expect(creds.saved.get(JIRA_ID)).toEqual(JIRA_CREDS);
    expect(repo.credentials).toEqual([
      { integration: JIRA_ID, service_account_id: 'fake-svc-1', managed_field_ids: ['customfield_10016', 'customfield_10100', 'customfield_10102'], base_url: 'https://example.atlassian.net' },
    ]);
    expect(repo.rules.map((r) => [r.trigger, r.enabled])).toEqual([
      ['commit.linked', true],
      ['pr.opened', false],
      ['deployment.success', false],
    ]);
    await svc.saveCredentials(scope, JIRA_ID, JIRA_CREDS);
    expect(repo.rules).toHaveLength(3);
  });

  it('401 de Jira → 422; proveedor distinto → 400; credenciales Jira en integración git → 400; otra integración → 404', async () => {
    fetchRoutes = [{ method: 'GET', path: /myself$/, status: 401, body: { errorMessages: ['nope'] } }];
    build();
    await expect(svc.saveCredentials(scope, JIRA_ID, JIRA_CREDS)).rejects.toSatisfy((e) => e instanceof HttpException && e.statusCode === 422);
    expect(creds.saved.size).toBe(0);
    await expect(svc.saveCredentials(scope, JIRA_ID, { provider: 'linear', api_key: 'lin_fake_key_123' })).rejects.toSatisfy(
      (e) => e instanceof HttpException && e.statusCode === 400,
    );
    // integración git: espera GitProviderCredentials ⇒ credenciales de Jira = ZodError (400)
    await expect(svc.saveCredentials(scope, GH_ID, JIRA_CREDS)).rejects.toThrow(/discriminator/);
    await expect(svc.saveCredentials({ ...scope, tenant_id: 'other' }, JIRA_ID, JIRA_CREDS)).rejects.toSatisfy(
      (e) => e instanceof HttpException && e.statusCode === 404,
    );
  });
});

describe('acciones manuales', () => {
  it('encola pending con origen manual (key_id) e idempotencia', async () => {
    const body = { action: { kind: 'comment', body_markdown: 'Hola **equipo**' }, idempotency_key: 'click-0001' };
    const a = await svc.enqueueManual(scope, 'mag-123', body);
    expect(a.duplicate).toBe(false);
    expect(OutboxAction.parse(a.item)).toMatchObject({
      task_key: 'MAG-123',
      integration_id: JIRA_ID,
      provider: 'jira',
      status: 'pending',
      attempts: 0,
      origin: { type: 'manual', key_id: 'key_1' },
      idempotency_key: 'manual:click-0001',
    });
    const b = await svc.enqueueManual(scope, 'MAG-123', body);
    expect(b).toEqual({ item: a.item, duplicate: true });
    expect(outbox()).toHaveLength(1);
    expect(outbox()[0]).toMatchObject({ GSI1PK: `T#${TENANT}#OUTBOX#pending`, entity: 'OutboxAction' });
  });

  it('sin integración para el prefijo → 404; cuerpo inválido → zod', async () => {
    await expect(svc.enqueueManual(scope, 'OPS-1', { action: { kind: 'comment', body_markdown: 'x' }, idempotency_key: 'k-12345678' })).rejects.toSatisfy(
      (e) => e instanceof HttpException && e.statusCode === 404,
    );
    await expect(svc.enqueueManual(scope, 'MAG-123', { action: { kind: 'explode' }, idempotency_key: 'k-12345678' })).rejects.toThrow();
  });
});

describe('outbox: máquina de estados', () => {
  async function enqueue(action: Record<string, unknown> = { kind: 'comment', body_markdown: 'Hola' }) {
    creds.saved.set(JIRA_ID, JIRA_CREDS);
    const { item } = await svc.enqueueManual(scope, 'MAG-123', { action, idempotency_key: `k-${Math.random()}` });
    const row = outbox().find((o) => o.action_id === item.action_id)!;
    return { PK: row.PK, SK: row.SK };
  }

  it('pending → sending → sent (transition refleja el estado en la Task local)', async () => {
    fetchRoutes = [
      { method: 'GET', path: /transitions$/, body: { transitions: [{ id: '31', name: 'Done', to: { name: 'Hecho', statusCategory: { key: 'done' } } }] } },
      { method: 'POST', path: /transitions$/, status: 204 },
      { method: 'PUT', path: /properties/, body: {} },
    ];
    build();
    const key = await enqueue({ kind: 'transition', to_status: 'hecho' });
    expect(await svc.processOutbox(key)).toBe('sent');
    expect(await repo.getOutbox(key)).toMatchObject({ status: 'sent', attempts: 1, last_error: null, result: { transition_id: '31', to_status: 'Hecho' }, GSI1PK: `T#${TENANT}#OUTBOX#sent` });
    expect(repo.taskStatus).toEqual([{ task: 'MAG-123', status: 'Hecho', category: 'done' }]);
    // re-entrega del mismo registro del stream → no-op (no se duplica en Jira)
    expect(await svc.processOutbox(key)).toBe('noop');
    expect(fetchCalls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('5xx → vuelve a pending con last_error y RetryableOutboxError; al 5º intento → failed', async () => {
    fetchRoutes = Array.from({ length: 3 * MAX_ATTEMPTS }, () => ({ method: 'POST', path: /comment$/, status: 503 }));
    build();
    const key = await enqueue();
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await expect(svc.processOutbox(key)).rejects.toBeInstanceOf(RetryableOutboxError);
      expect(await repo.getOutbox(key)).toMatchObject({ status: 'pending', attempts: i, last_error: expect.stringContaining('HTTP 503') });
    }
    expect(await svc.processOutbox(key)).toBe('failed');
    expect(await repo.getOutbox(key)).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, last_error: expect.stringContaining('agotados') });
  });

  it('4xx (no 429) → failed definitivo al primer intento', async () => {
    fetchRoutes = [{ method: 'POST', path: /comment$/, status: 403, body: { errorMessages: ['You do not have permission to comment'] } }];
    build();
    const key = await enqueue();
    expect(await svc.processOutbox(key)).toBe('failed');
    expect(await repo.getOutbox(key)).toMatchObject({ status: 'failed', attempts: 1, last_error: expect.stringContaining('permission') });
  });

  it('sin credenciales o integración deshabilitada → failed', async () => {
    const key = await enqueue();
    creds.saved.clear();
    expect(await svc.processOutbox(key)).toBe('failed');
    expect((await repo.getOutbox(key))!.last_error).toMatch(/credenciales/);

    const key2 = await enqueue();
    ints.lookups.get(JIRA_ID)!.status = 'disabled';
    expect(await svc.processOutbox(key2)).toBe('failed');
  });

  it('un "sending" huérfano (>2 min) se puede re-tomar; uno reciente no', async () => {
    fetchRoutes = [
      { method: 'POST', path: /comment$/, status: 201, body: { id: '1' } },
      { method: 'PUT', path: /properties/, body: {} },
    ];
    build();
    const key = await enqueue();
    const row = repo.outbox.get(`${key.PK}|${key.SK}`)!;
    Object.assign(row, { status: 'sending', claimed_at: '2026-10-20T19:59:30.000Z', attempts: 1 });
    expect(await svc.processOutbox(key)).toBe('noop');
    now = new Date('2026-10-20T20:05:00.000Z');
    expect(await svc.processOutbox(key)).toBe('sent');
  });
});

describe('fireTrigger (reglas)', () => {
  beforeEach(async () => {
    creds.saved.set(JIRA_ID, JIRA_CREDS);
    await svc.saveCredentials(scope, JIRA_ID, JIRA_CREDS);
    for (const r of repo.rules) r.enabled = true;
  });

  it('deployment.success en production → transición encolada con plantillas y métricas', async () => {
    const input = {
      tenant_id: TENANT,
      project_id: 'shop',
      task_keys: ['MAG-123'],
      ref: 'deploy:acme/shop:987',
      environment: 'production',
      vars: { sha: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432', environment: 'production', repository: 'acme/shop' },
    };
    await svc.fireTrigger('deployment.success', input);
    await svc.fireTrigger('deployment.success', input); // mismo hecho → mismo idempotency_key
    expect(outbox()).toHaveLength(1);
    const rule = repo.rules.find((r) => r.trigger === 'deployment.success')!;
    expect(outbox()[0]).toMatchObject({
      status: 'pending',
      origin: { type: 'rule', rule_id: rule.rule_id, trigger_ref: 'MAG-123|deploy:acme/shop:987' },
      idempotency_key: `${rule.rule_id}:MAG-123|deploy:acme/shop:987`,
      action: { kind: 'transition', to_status: 'Hecho', comment: 'Desplegado 9f8e7d6c5b4a en production. Tokens MagiHub: 1,500 · líneas efectivas: 27.5.' },
    });
    await svc.fireTrigger('deployment.success', { ...input, ref: 'deploy:acme/shop:988', environment: 'staging' });
    expect(outbox()).toHaveLength(1);
  });

  it('pr.opened respeta when.from_status_category', async () => {
    await svc.fireTrigger('pr.opened', { tenant_id: TENANT, task_keys: ['MAG-123'], ref: 'pr:acme/shop:43', vars: { pr_url: 'https://github.com/acme/shop/pull/43' } });
    expect(outbox().map((o) => o.action)).toEqual([{ kind: 'transition', to_status: 'En revisión', comment: 'PR abierto: https://github.com/acme/shop/pull/43' }]);
    store.put({ ...store.getSync(keys.task(TENANT, 'MAG-123'))!, status_category: 'done' });
    await svc.fireTrigger('pr.opened', { tenant_id: TENANT, task_keys: ['MAG-123'], ref: 'pr:acme/shop:44', vars: {} });
    expect(outbox()).toHaveLength(1);
  });

  it('commit.linked: commit_url desde el remote_url del Commit; sin remoto → skipped "commit_url desconocido"', async () => {
    const sha = '0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c';
    store.put({ ...keys.commit(TENANT, 'acme/shop', sha), sha, remote_url: 'git@github.com:acme/shop.git' });
    await svc.fireTrigger('commit.linked', { tenant_id: TENANT, task_keys: ['MAG-123'], ref: `commit:acme/shop:${sha}`, vars: { sha, repository: 'acme/shop' } });
    expect(outbox()[0]).toMatchObject({ status: 'pending', action: { kind: 'remote_link', url: `https://github.com/acme/shop/commit/${sha}`, title: 'Commit 0d1a26e67d8f (MagiCode)' } });

    const sha2 = 'b'.repeat(40);
    await svc.fireTrigger('commit.linked', { tenant_id: TENANT, task_keys: ['MAG-123'], ref: `commit:local/repo:${sha2}`, vars: { sha: sha2, repository: 'local/repo' } });
    const skipped = outbox().find((o) => o.status === 'skipped')!;
    expect(skipped).toMatchObject({ last_error: COMMIT_URL_UNKNOWN, action: { url: '{{commit_url}}' }, GSI1PK: `T#${TENANT}#OUTBOX#skipped` });
    expect(OutboxAction.parse(skipped)).toBeTruthy();
  });

  it('claves sin integración / inválidas no encolan y nunca lanza', async () => {
    await expect(svc.fireTrigger('pr.merged', { tenant_id: TENANT, task_keys: ['OPS-1', 'bad key'], ref: 'x' })).resolves.toBeUndefined();
    expect(outbox()).toHaveLength(0);
  });
});

describe('transiciones en vivo', () => {
  it('GET /tasks/:key/transitions → AvailableTransition[]', async () => {
    creds.saved.set(JIRA_ID, JIRA_CREDS);
    fetchRoutes = [{ method: 'GET', path: /MAG-123\/transitions$/, body: { transitions: [{ id: '21', name: 'Revisar', to: { name: 'En revisión', statusCategory: { key: 'indeterminate' } } }] } }];
    build();
    expect(await svc.transitions(TENANT, 'MAG-123')).toEqual([{ id: '21', name: 'Revisar', to_status: 'En revisión', to_category: 'in_progress' }]);
  });

  it('sin credenciales → 422', async () => {
    await expect(svc.transitions(TENANT, 'MAG-123')).rejects.toSatisfy((e) => e instanceof HttpException && e.statusCode === 422);
  });
});
