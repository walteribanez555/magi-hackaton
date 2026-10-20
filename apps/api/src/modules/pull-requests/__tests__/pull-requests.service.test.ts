import { beforeEach, describe, expect, it } from 'vitest';
import { keys } from '@magicode/contracts';
import { BranchesRepository } from '../../branches/branches.repository';
import { FakeStore } from '../../webhooks/__tests__/helpers';
import { PullRequestsRepository } from '../pull-requests.repository';
import { PullRequestsService, prCommits, shaMatch } from '../pull-requests.service';

const T = 't1';
const R = 'acme/shop';
let store: FakeStore;
let svc: PullRequestsService;

const pr = (n: number, state: string, o: Record<string, unknown> = {}) =>
  store.put({
    ...keys.pullRequest(T, R, n),
    ...keys.pullRequestGsi1(T, 'shop', `2026-10-20T1${n % 10}:00:00.000Z`),
    entity: 'PullRequest',
    repository: R,
    number: n,
    project_id: 'shop',
    state,
    source_branch: `feature/MAG-${n}`,
    target_branch: 'main',
    head_sha: `head${n}`.padEnd(40, '0'),
    merge_sha: null,
    url: `https://github.com/${R}/pull/${n}`,
    task_keys: [`MAG-${n}`],
    last_event_at: `2026-10-20T1${n % 10}:00:00.000Z`,
    ...o,
  });

const commit = (sha: string, o: Record<string, unknown>) =>
  store.put({ ...keys.commit(T, R, sha), entity: 'Commit', sha, repository: R, ...o });

beforeEach(() => {
  store = new FakeStore();
  svc = new PullRequestsService(new PullRequestsRepository(store.asRepo()), new BranchesRepository(store.asRepo()));
  pr(1, 'open');
  pr(2, 'merged', { merge_sha: 'd00d1234d00d' }); // SHA corto (Bitbucket)
  pr(3, 'closed');
  // commits del IDE en la rama del PR 1 (con líneas IA) y uno remoto sin cruce
  commit('a'.repeat(40), { branch: 'feature/MAG-1', automation: { ai_matched_lines: 12, commit_added_lines: 20 } });
  commit('b'.repeat(40), { remote_branch: 'feature/MAG-1', remote_only: true, automation: { ai_matched_lines: 0, commit_added_lines: 0 } });
  // merge commit del PR 2 reportado por el IDE (SHA completo)
  commit('d00d1234d00d' + '0'.repeat(28), { branch: 'main', automation: { ai_matched_lines: 5, commit_added_lines: 50 } });
});

describe('shaMatch / prCommits', () => {
  it('compara por prefijo (≥7) y sin mayúsculas', () => {
    expect(shaMatch('D00D1234D00D', 'd00d1234d00d0000')).toBe(true);
    expect(shaMatch('abc', 'abcdef')).toBe(false);
    expect(shaMatch(null, 'abcdefg')).toBe(false);
  });

  it('commits del PR = rama origen (local o remota) + head + merge', () => {
    const commits = [
      { sha: 'x'.repeat(40), branch: 'feature/a' },
      { sha: 'y'.repeat(40), remote_branch: 'feature/a' },
      { sha: 'h'.repeat(40) },
      { sha: 'z'.repeat(40), branch: 'other' },
    ];
    expect(prCommits({ source_branch: 'feature/a', head_sha: 'h'.repeat(40), merge_sha: null }, commits).map((c) => c.sha[0])).toEqual(['x', 'y', 'h']);
  });
});

describe('PullRequestsService.list', () => {
  it('lista con líneas IA cruzadas y totales open/merged/closed en meta', async () => {
    const { data, meta } = await svc.list(T, { repository: R });
    expect(meta).toEqual({ total: 3, open: 1, merged: 1, closed: 1, with_ai_lines: 2 });
    const byN = Object.fromEntries(data.map((d) => [d.number, d]));
    expect(byN[1]!.ai).toEqual({ commits: 2, commits_with_ai: 1, ai_matched_lines: 12, commit_added_lines: 20, contains_ai_lines: true, provenance: 'estimated' });
    expect(byN[2]!.ai).toMatchObject({ commits: 1, ai_matched_lines: 5, contains_ai_lines: true });
    expect(byN[3]!.ai.contains_ai_lines).toBe(false);
    expect(byN[1]).toMatchObject({ task_keys: ['MAG-1'], state: 'open', merge_sha: null, url: 'https://github.com/acme/shop/pull/1' });
  });

  it('filtro por estado no altera los totales', async () => {
    const { data, meta } = await svc.list(T, { project_id: 'shop', state: 'merged' });
    expect(data.map((d) => d.number)).toEqual([2]);
    expect(meta.total).toBe(3);
  });

  it('aislamiento por tenant', async () => {
    expect((await svc.list('t2', { repository: R })).data).toEqual([]);
  });

  it('?pr_author filtra por author_login (sin mayúsculas) y expone author_login', async () => {
    pr(1, 'open', { author_login: 'AnaDev' });
    pr(2, 'merged', { merge_sha: 'd00d1234d00d', author_login: 'bob' });
    const { data, meta } = await svc.list(T, { project_id: 'shop', pr_author: 'anadev' });
    expect(data.map((d) => [d.number, d.author_login])).toEqual([[1, 'AnaDev']]);
    expect(meta.total).toBe(1);
    expect((await svc.list(T, { repository: R })).data.find((d) => d.number === 3)!.author_login).toBeNull();
  });

  it('?developer: PRs cuya rama origen tiene sesiones del developer', async () => {
    store.put({ ...keys.branch(T, R, 'feature/MAG-2'), repository: R, branch: 'feature/MAG-2', session_ids: new Set(['s1']) });
    store.put({ ...keys.branch(T, R, 'feature/MAG-3'), repository: R, branch: 'feature/MAG-3', session_ids: new Set(['s2']) });
    store.put({ ...keys.session(T, 's1'), session_id: 's1', developer: 'ana@x.io' });
    store.put({ ...keys.session(T, 's2'), session_id: 's2', developer: 'bob@x.io' });
    expect((await svc.list(T, { repository: R, developer: 'ana@x.io' })).data.map((d) => d.number)).toEqual([2]);
    expect((await svc.list(T, { repository: R, developer: 'ana@x.io', pr_author: 'bob' })).data).toEqual([]);
  });
});
