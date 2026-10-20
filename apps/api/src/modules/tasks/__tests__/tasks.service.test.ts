import { beforeEach, describe, expect, it } from 'vitest';
import { keys, TaskListItem } from '@magicode/contracts';
import { HttpException } from '../../../common/exceptions';
import { BranchesRepository } from '../../branches/branches.repository';
import { PullRequestsRepository } from '../../pull-requests/pull-requests.repository';
import { PullRequestsService } from '../../pull-requests/pull-requests.service';
import { FakeStore } from '../../webhooks/__tests__/helpers';
import { TasksRepository } from '../tasks.repository';
import { aggregateTaskMetrics, allocateTaskTokens, TasksService, type TaskUsageSource } from '../tasks.service';

const T = 't1';
let store: FakeStore;
let svc: TasksService;
/** Sin snapshots de usage (fallback Σ reportado) salvo que el test lo cambie. */
let usageSource: TaskUsageSource;

function link(task: string, kind: 'branch' | 'session' | 'commit' | 'pr' | 'deployment', id: string, o: Record<string, unknown> = {}) {
  store.put({ ...keys.taskLink(T, task, kind, id), entity: 'TaskLink', task_key: task, kind, link_id: id, updated_at: '2026-10-20T10:00:00.000Z', ...o });
}

beforeEach(() => {
  store = new FakeStore();
  const prRepo = new PullRequestsRepository(store.asRepo());
  const branches = new BranchesRepository(store.asRepo());
  usageSource = { cachedWindow: async () => null, requestsOfKey: async () => [], mode: () => 'real' };
  svc = new TasksService(new TasksRepository(store.asRepo()), branches, prRepo, new PullRequestsService(prRepo, branches), {
    cachedWindow: (...a) => usageSource.cachedWindow(...a),
    requestsOfKey: (...a) => usageSource.requestsOfKey(...a),
    mode: () => usageSource.mode(),
  });

  store.put({
    ...keys.task(T, 'MAG-123'),
    ...keys.taskGsi1(T, 'shop', '2026-10-20T13:20:00.000Z'),
    entity: 'Task',
    task_key: 'MAG-123',
    project_id: 'shop',
    title: 'Login form',
    status: 'En curso',
    status_category: 'in_progress',
    assignee: 'Ana Dev',
    story_points: 5,
    url: 'https://example.atlassian.net/browse/MAG-123',
    source_updated_at: '2026-10-20T13:20:00.000Z',
  });
  store.put({
    ...keys.task(T, 'MAG-9'),
    ...keys.taskGsi1(T, 'shop', '2026-10-01T00:00:00.000Z'),
    entity: 'Task',
    task_key: 'MAG-9',
    project_id: 'shop',
    title: 'Done thing',
    status: 'Hecho',
    status_category: 'done',
    source_updated_at: '2026-10-01T00:00:00.000Z',
  });
  // sesión del IDE: 2 peticiones (una de otra tarea) + cambios aceptados
  store.put({ ...keys.session(T, 's1'), entity: 'Session', session_id: 's1', repository: 'acme/shop', branch: 'feature/mag-123-login', started_at: '2026-10-20T09:00:00.000Z' });
  store.put({ ...keys.aiRequest(T, 's1', 'r1'), entity: 'AiRequest', task_key: 'MAG-123', usage: { total_tokens: 1200 }, provenance: 'real', usage_source: 'magihub-response' });
  store.put({ ...keys.aiRequest(T, 's1', 'r2'), entity: 'AiRequest', usage: { total_tokens: 300 }, provenance: 'real' });
  store.put({ ...keys.aiRequest(T, 's1', 'r3'), entity: 'AiRequest', task_key: 'MAG-999', usage: { total_tokens: 9999 } });
  store.put({ ...keys.change(T, 's1', 'c1'), entity: 'Change', task_key: 'MAG-123', status: 'committed', accepted_added_lines: 40, dimensions: { effective_lines: 22.5 }, scores: { criticality: 'medium' } });
  store.put({ ...keys.change(T, 's1', 'c2'), entity: 'Change', task_key: 'MAG-123', status: 'rejected', accepted_added_lines: 99 });
  store.put({ ...keys.change(T, 's1', 'c3'), entity: 'Change', status: 'accepted', accepted_added_lines: 10, dimensions: { effective_lines: 5 }, scores: { criticality: 'high' } });

  link('MAG-123', 'session', 's1', { session_id: 's1' });
  link('MAG-123', 'branch', 'feature/mag-123-login', { repository: 'acme/shop', branch: 'feature/mag-123-login' });
  link('MAG-123', 'commit', 'a'.repeat(40), { repository: 'acme/shop', sha: 'a'.repeat(40) });
  link('MAG-123', 'commit', 'b'.repeat(40), { repository: 'acme/shop', sha: 'b'.repeat(40) });
  link('MAG-123', 'pr', 'acme/shop:42', { repository: 'acme/shop', number: 42, state: 'merged', url: 'https://github.com/acme/shop/pull/42' });
  link('MAG-123', 'deployment', 'acme/shop:1', { deployment_id: '1', repository: 'acme/shop', state: 'failure', deployed: false });
  link('MAG-123', 'deployment', 'acme/shop:2', { deployment_id: '2', repository: 'acme/shop', state: 'success', deployed: true, environment: 'production' });

  store.put({ ...keys.commit(T, 'acme/shop', 'a'.repeat(40)), sha: 'a'.repeat(40), repository: 'acme/shop', branch: 'feature/mag-123-login', committed_at: '2026-10-20T10:00:00Z', verified_remote: true, commit_source: 'git-local', automation: { ai_matched_lines: 30, commit_added_lines: 40, ai_share: 0.75 } });
  store.put({ ...keys.commit(T, 'acme/shop', 'b'.repeat(40)), sha: 'b'.repeat(40), repository: 'acme/shop', remote_branch: 'feature/mag-123-login', committed_at: '2026-10-20T11:00:00Z', verified_remote: true, remote_only: true, commit_source: 'git-remote', automation: { ai_matched_lines: 0, commit_added_lines: 0, ai_share: 0 } });
  store.put({ ...keys.branch(T, 'acme/shop', 'feature/mag-123-login'), ...keys.branchGsi1(T, 'shop', '2026-10-20T11:00:00.000Z'), repository: 'acme/shop', branch: 'feature/mag-123-login', task_keys: new Set(['MAG-123', 'MAG-777']), session_ids: new Set(['s1']), commit_shas: new Set(['a'.repeat(40), 'b'.repeat(40)]), last_activity_at: '2026-10-20T11:00:00.000Z' });
  store.put({ ...keys.pullRequest(T, 'acme/shop', 42), repository: 'acme/shop', number: 42, state: 'merged', source_branch: 'feature/mag-123-login', target_branch: 'main', head_sha: 'b'.repeat(40), merge_sha: 'c'.repeat(40), url: 'https://github.com/acme/shop/pull/42', task_keys: ['MAG-123'] });
  // se desplegó el MERGE commit del PR #42 (no el SHA del commit de la sesión)
  store.put({ ...keys.deployment(T, 'acme/shop', '2'), entity: 'Deployment', repository: 'acme/shop', deployment_id: '2', sha: 'c'.repeat(40), state: 'success', environment: 'production' });
});

describe('aggregateTaskMetrics', () => {
  it('suma tokens de peticiones de la tarea o sin tarea; líneas solo de cambios aceptados; criticidad máxima', () => {
    const rows = [{ requests: store.all('R#'), changes: store.all('C#') }];
    expect(aggregateTaskMetrics('MAG-123', rows)).toEqual({
      tokens: { value: 1500, provenance: 'estimated' },
      accepted_lines: 50,
      effective_lines: 27.5,
      criticality: 'high',
    });
  });

  it('sin sesiones enlazadas → tokens null; mock → simulated', () => {
    expect(aggregateTaskMetrics('X-1', []).tokens).toEqual({ value: null, provenance: 'estimated' });
    expect(aggregateTaskMetrics('X-1', [{ requests: [{ usage: { total_tokens: 5 }, usage_source: 'magihub-mock' }], changes: [] }]).tokens).toEqual({
      value: 5,
      provenance: 'simulated',
    });
  });
});

describe('TasksService.list', () => {
  it('TaskListItem válido con enlaces agregados', async () => {
    const out = await svc.list(T, { project_id: 'shop' });
    const t = out.find((x) => x.task_key === 'MAG-123')!;
    expect(TaskListItem.parse(t)).toEqual({
      task_key: 'MAG-123',
      project_id: 'shop',
      title: 'Login form',
      status: 'En curso',
      status_category: 'in_progress',
      assignee: 'Ana Dev',
      story_points: 5,
      url: 'https://example.atlassian.net/browse/MAG-123',
      branches: ['feature/mag-123-login'],
      sessions: 1,
      commits: 2,
      pull_requests: [{ number: 42, state: 'merged', url: 'https://github.com/acme/shop/pull/42' }],
      tokens: { value: 1500, provenance: 'estimated' },
      accepted_lines: 50,
      effective_lines: 27.5,
      deployed: true,
      updated_at: '2026-10-20T13:20:00.000Z',
    });
  });

  it('incluye tareas "untracked" vistas en ramas pero sin webhook de Jira', async () => {
    const out = await svc.list(T, { project_id: 'shop' });
    expect(out.map((t) => t.task_key)).toEqual(['MAG-123', 'MAG-9', 'MAG-777']);
    expect(out[2]).toMatchObject({ title: 'MAG-777', status: 'untracked', status_category: 'todo', tokens: { value: null } });
  });

  it('filtra por status_category (sin untracked)', async () => {
    expect((await svc.list(T, { project_id: 'shop', status_category: 'done' })).map((t) => t.task_key)).toEqual(['MAG-9']);
  });

  it('excluye tareas borradas', async () => {
    store.put({ ...store.getSync(keys.task(T, 'MAG-9'))!, deleted: true });
    expect((await svc.list(T, { project_id: 'shop', status_category: 'done' }))).toEqual([]);
  });
});

describe('TasksService.detail', () => {
  it('devuelve la tarea + sesiones, commits, ramas, PRs y despliegues enlazados', async () => {
    const d = await svc.detail(T, 'mag-123');
    expect(d.task_key).toBe('MAG-123');
    expect(d.criticality).toBe('high');
    expect(d.linked.sessions).toEqual([{ session_id: 's1', repository: 'acme/shop', branch: 'feature/mag-123-login', started_at: '2026-10-20T09:00:00.000Z', ended_at: null }]);
    expect(d.linked.commits.map((c) => [c.sha[0], c.verified_remote, c.ai_matched_lines])).toEqual([
      ['b', true, null], // solo remoto: líneas IA desconocidas (null, no 0)
      ['a', true, 30],
    ]);
    expect(d.linked.branches[0]).toMatchObject({ branch: 'feature/mag-123-login', commits: 2, sessions: 1 });
    expect(d.linked.pull_requests[0]).toMatchObject({ number: 42, ai: { ai_matched_lines: 30, contains_ai_lines: true } });
    expect(d.linked.deployments.map((x) => [x.deployment_id, x.deployed])).toEqual([
      ['1', false],
      ['2', true],
    ]);
  });

  it('404 si no hay tarea ni enlaces; 400 si la clave es inválida', async () => {
    await expect(svc.detail(T, 'NOPE-1')).rejects.toSatisfy((e) => e instanceof HttpException && e.statusCode === 404);
    await expect(svc.detail(T, 'not a key')).rejects.toSatisfy((e) => e instanceof HttpException && e.statusCode === 400);
  });

  it('aislamiento: otro tenant no ve la tarea', async () => {
    await expect(svc.detail('t2', 'MAG-123')).rejects.toSatisfy((e) => e instanceof HttpException && e.statusCode === 404);
  });
});

describe('TaskListItem.deployed — misma regla que el embudo', () => {
  it('desplegar el merge commit del PR de la rama del commit cuenta', async () => {
    const t = (await svc.list(T, { project_id: 'shop' })).find((x) => x.task_key === 'MAG-123')!;
    expect(t.deployed).toBe(true);
  });

  it('un TaskLink deployment success sin commit que case NO marca desplegado', async () => {
    store.put({ ...store.getSync(keys.deployment(T, 'acme/shop', '2'))!, sha: 'd'.repeat(40) });
    const t = (await svc.list(T, { project_id: 'shop' })).find((x) => x.task_key === 'MAG-123')!;
    expect(t.deployed).toBe(false);
  });

  it('success a staging se lista en el detalle pero no cuenta como desplegado', async () => {
    store.put({ ...store.getSync(keys.deployment(T, 'acme/shop', '2'))!, environment: 'staging' });
    link('MAG-123', 'deployment', 'acme/shop:3', { deployment_id: '3', repository: 'acme/shop', state: 'success', deployed: true, environment: 'staging' });
    const d = await svc.detail(T, 'MAG-123');
    expect(d.deployed).toBe(false);
    expect(d.linked.deployments.find((x) => x.deployment_id === '3')).toMatchObject({ state: 'success', deployed: false, environment: 'staging' });
  });

  it('deployment failure del merge commit no cuenta', async () => {
    store.put({ ...store.getSync(keys.deployment(T, 'acme/shop', '2'))!, state: 'failure' });
    expect((await svc.detail(T, 'MAG-123')).deployed).toBe(false);
  });
});

describe('TaskListItem.tokens — mismo método que el summary (allocateUsage)', () => {
  const req = (id: string, tokens: number, at: string, task?: string) => ({
    ai_request_id: id,
    key_id: 'k1',
    occurred_at: at,
    usage: { total_tokens: tokens },
    provenance: 'real',
    ...(task ? { task_key: task } : {}),
  });

  it('granularidad request: Σ registros de la API de consumo por request_id', async () => {
    const src: TaskUsageSource = {
      cachedWindow: async () => ({
        granularity: 'request',
        provenance: 'real',
        source: 'magihub-usage-api',
        records: [
          { request_id: 'r1', window_start: '2026-10-20T10:00:00.000Z', window_end: '2026-10-20T10:00:00.000Z', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 1250 }, requests: 1 },
        ],
      }),
      requestsOfKey: async () => [],
      mode: () => 'real',
    };
    expect(await allocateTaskTokens(T, [req('r1', 1200, '2026-10-20T10:00:00.000Z')], true, src)).toEqual({ value: 1250, provenance: 'real' });
  });

  it('granularidad hora: prorrateo por usage reportado ⇒ estimated', async () => {
    const mine = req('r1', 300, '2026-10-20T10:05:00.000Z');
    const other = req('rX', 100, '2026-10-20T10:20:00.000Z');
    const src: TaskUsageSource = {
      cachedWindow: async () => ({
        granularity: 'hour',
        provenance: 'real',
        source: 'magihub-usage-api',
        records: [
          { window_start: '2026-10-20T10:00:00.000Z', window_end: '2026-10-20T11:00:00.000Z', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 480 }, requests: 2 },
        ],
      }),
      requestsOfKey: async () => [mine, other] as never,
      mode: () => 'real',
    };
    expect(await allocateTaskTokens(T, [mine], true, src)).toEqual({ value: 360, provenance: 'estimated' });
  });

  it('sin snapshots ⇒ Σ reportado (estimated); mock ⇒ simulated', async () => {
    const r = [req('r1', 1200, '2026-10-20T10:00:00.000Z')];
    expect(await allocateTaskTokens(T, r, true, usageSource)).toEqual({ value: 1200, provenance: 'estimated' });
    expect(await allocateTaskTokens(T, r, true, { ...usageSource, mode: () => 'mock' })).toEqual({ value: 1200, provenance: 'simulated' });
    expect(await allocateTaskTokens(T, [], false, usageSource)).toEqual({ value: null, provenance: 'estimated' });
  });
});
