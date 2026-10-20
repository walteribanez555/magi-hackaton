import { beforeEach, describe, expect, it } from 'vitest';
import { BranchListItem, keys } from '@magicode/contracts';
import { FakeStore } from '../../webhooks/__tests__/helpers';
import { BranchesRepository } from '../branches.repository';
import { BranchesService, toBranchListItem } from '../branches.service';

const T = 't1';
let store: FakeStore;
let svc: BranchesService;

const branch = (repo: string, name: string, project: string, at: string, o: Record<string, unknown> = {}) =>
  store.put({
    ...keys.branch(T, repo, name),
    ...keys.branchGsi1(T, project, at),
    entity: 'Branch',
    repository: repo,
    branch: name,
    project_id: project,
    last_activity_at: at,
    ...o,
  });

beforeEach(() => {
  store = new FakeStore();
  svc = new BranchesService(new BranchesRepository(store.asRepo()));
  branch('acme/shop', 'feature/mag-123-login', 'shop', '2026-10-20T10:00:00.000Z', {
    task_keys: new Set(['MAG-123']),
    session_ids: new Set(['s1', 's2']),
    commit_shas: new Set(['a', 'b', 'c']),
    head_sha: 'c',
    merged_into: 'main',
  });
  branch('acme/shop', 'old/experiment', 'shop', '2026-10-19T10:00:00.000Z', { deleted: true });
  branch('acme/shop', 'main', 'shop', '2026-10-20T12:00:00.000Z');
  branch('acme/infra', 'feature/OPS-1', 'infra', '2026-10-18T10:00:00.000Z', { task_keys: ['OPS-1'] });
  store.put({ ...keys.project(T, 'shop'), project_id: 'shop' });
  store.put({ ...keys.integration(T, 'int_1'), project_id: 'infra' });
});

describe('toBranchListItem', () => {
  it('convierte Sets de Dynamo en conteos/arrays válidos según el contrato', () => {
    const item = toBranchListItem(store.getSync(keys.branch(T, 'acme/shop', 'feature/mag-123-login')) as never);
    expect(BranchListItem.parse(item)).toEqual({
      repository: 'acme/shop',
      branch: 'feature/mag-123-login',
      task_keys: ['MAG-123'],
      sessions: 2,
      commits: 3,
      head_sha: 'c',
      merged_into: 'main',
      last_activity_at: '2026-10-20T10:00:00.000Z',
    });
  });
});

describe('BranchesService.list', () => {
  it('por proyecto (GSI1), más reciente primero y sin ramas borradas', async () => {
    const out = await svc.list(T, { project_id: 'shop' });
    expect(out.map((b) => b.branch)).toEqual(['main', 'feature/mag-123-login']);
    expect(out[0]).toMatchObject({ sessions: 0, commits: 0, head_sha: null, merged_into: null, task_keys: [] });
  });

  it('por repositorio (PK) e include_deleted', async () => {
    expect((await svc.list(T, { repository: 'acme/shop', include_deleted: true })).map((b) => b.branch)).toEqual([
      'main',
      'feature/mag-123-login',
      'old/experiment',
    ]);
  });

  it('sin filtros: todos los proyectos del tenant (Project + Integration)', async () => {
    expect((await svc.list(T, {})).map((b) => b.repository)).toEqual(['acme/shop', 'acme/shop', 'acme/infra']);
  });

  it('aislamiento: otro tenant no ve nada', async () => {
    expect(await svc.list('t2', { repository: 'acme/shop' })).toEqual([]);
  });
});
