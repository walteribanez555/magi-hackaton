import { describe, expect, it } from 'vitest';
import { FilterOptions, keys } from '@magicode/contracts';
import { config } from '../../../config/config';
import { ProductivityService } from '../productivity.service';
import type { ProductivityRepository } from '../productivity.repository';
import type { UsageService } from '../../usage/usage.service';
import {
  branchMatches,
  commitMatches,
  normalizeDeveloper,
  prAuthorScope,
  pullRequestMatches,
  readScopeFilters,
  sessionMatches,
  taskMatches,
} from '../productivity.filters';
import type { AiRequestItem, ChangeItem, CommitItem, SessionItem } from '../productivity.types';
import { accepted, commit, request, session } from './fixtures';

process.env.LOG_LEVEL = 'error';
process.env.MAGIHUB_MODE = 'real';
config.reload();

const T = 't1';
const caller = { tenant_id: T, key_id: 'k1' };
const FROM = '2026-10-20T00:00:00.000Z';
const TO = '2026-10-20T23:59:59.000Z';

const PRS = [
  { repository: 'org/repo', number: 1, source_branch: 'feature/MAG-1', head_sha: 'h'.repeat(40), merge_sha: null, task_keys: ['MAG-1'], author_login: 'AnaDev', state: 'open' },
  { repository: 'org/repo', number: 2, source_branch: 'feature/MAG-2', head_sha: 'i'.repeat(40), merge_sha: null, task_keys: ['MAG-2'], author_login: 'bob', state: 'merged' },
];

describe('productivity.filters — helpers', () => {
  it('normaliza developer (trim + minúsculas) y lee los filtros del query', () => {
    expect(normalizeDeveloper('  Ana.Dev@Example.COM ')).toBe('ana.dev@example.com');
    expect(normalizeDeveloper('   ')).toBeUndefined();
    const q: Record<string, string> = { repository: 'org/repo', developer: 'Ana@X.io', pr_author: '', other: 'x' };
    expect(readScopeFilters((k) => q[k])).toEqual({ repository: 'org/repo', developer: 'ana@x.io' });
  });

  it('pr_author → ramas origen, SHAs y tareas de sus PRs (login sin mayúsculas)', () => {
    const pa = prAuthorScope(PRS, 'anadev');
    expect([...pa.branches]).toEqual(['org/repo|feature/MAG-1']);
    expect([...pa.taskKeys]).toEqual(['MAG-1']);
    expect(pa.shas).toEqual(['h'.repeat(40)]);
  });

  it('sesión / commit / PR / rama / tarea combinan los filtros con AND', () => {
    const pa = prAuthorScope(PRS, 'AnaDev');
    const s = { repository: 'org/repo', branch: 'feature/MAG-1', developer: 'ana@x.io' };
    expect(sessionMatches(s, { developer: 'ana@x.io', pr_author: 'AnaDev' }, pa)).toBe(true);
    expect(sessionMatches(s, { developer: 'ana@x.io', repository: 'org/other' }, pa)).toBe(false);
    expect(sessionMatches({ ...s, branch: 'feature/MAG-2' }, { pr_author: 'AnaDev' }, pa)).toBe(false);

    // commit sin developer propio hereda el de su sesión; head del PR cuenta aunque la rama sea otra
    const devs = new Map([['s1', 'ana@x.io']]);
    expect(commitMatches({ repository: 'org/repo', sha: 'c'.repeat(40), session_id: 's1' }, { developer: 'ana@x.io' }, { sessionDevelopers: devs })).toBe(true);
    expect(commitMatches({ repository: 'org/repo', sha: 'c'.repeat(40), session_id: 's1', developer: 'bob@x.io' }, { developer: 'ana@x.io' }, { sessionDevelopers: devs })).toBe(false);
    expect(commitMatches({ repository: 'org/repo', sha: 'h'.repeat(40), branch: 'main' }, { pr_author: 'anadev' }, { pa })).toBe(true);
    expect(commitMatches({ repository: 'org/repo', sha: 'd'.repeat(40), remote_branch: 'feature/MAG-1' }, { pr_author: 'anadev' }, { pa })).toBe(true);
    expect(commitMatches({ repository: 'org/repo', sha: 'd'.repeat(40), branch: 'main' }, { pr_author: 'anadev' }, { pa })).toBe(false);

    expect(PRS.filter((p) => pullRequestMatches(p, { pr_author: 'BOB' })).map((p) => p.number)).toEqual([2]);
    expect(PRS.filter((p) => pullRequestMatches(p, { developer: 'ana@x.io' }, { devBranches: new Set(['org/repo|feature/MAG-2']) })).map((p) => p.number)).toEqual([2]);

    expect(branchMatches({ repository: 'org/repo', branch: 'feature/MAG-1', session_ids: ['s1'] }, { developer: 'ana@x.io', pr_author: 'anadev' }, { pa, devSessionIds: new Set(['s1']) })).toBe(true);
    expect(branchMatches({ repository: 'org/repo', branch: 'feature/MAG-1', session_ids: ['s9'] }, { developer: 'ana@x.io' }, { devSessionIds: new Set(['s1']) })).toBe(false);

    const links = [{ kind: 'session', link_id: 's1', session_id: 's1', repository: 'org/repo' }];
    expect(taskMatches('MAG-1', links, { pr_author: 'anadev' }, { pa })).toBe(true);
    expect(taskMatches('MAG-7', links, { pr_author: 'anadev' }, { pa })).toBe(false);
    expect(taskMatches('MAG-7', links, { developer: 'ana@x.io', repository: 'org/repo' }, { devSessionIds: new Set(['s1']) })).toBe(true);
  });
});

/** Repo en memoria con lo que usan las lecturas de ProductivityService. */
function fakeRepo(data: {
  sessions: SessionItem[];
  requests?: AiRequestItem[];
  changes?: ChangeItem[];
  commits?: CommitItem[];
  prs?: Array<Record<string, unknown>>;
  projects?: Array<{ project_id: string; repositories: string[]; last_activity_at: string }>;
}): ProductivityRepository {
  const prs = data.prs ?? [];
  const repo = {
    listProjects: async () => data.projects ?? [{ project_id: 'p1', repositories: ['org/repo'], last_activity_at: '2026-10-20T11:00:00.000Z' }],
    listSessionsOfProject: async (_t: string, p: string) => data.sessions.filter((s) => s.project_id === p),
    getSession: async (_t: string, id: string) => data.sessions.find((s) => s.session_id === id),
    loadSessionPartition: async (_t: string, id: string) => ({
      requests: (data.requests ?? []).filter((r) => r.session_id === id),
      changes: (data.changes ?? []).filter((c) => c.session_id === id),
      references: [],
    }),
    listCommitsOfSession: async (_t: string, id: string) => (data.commits ?? []).filter((c) => c.session_id === id),
    listCommitsOfRepo: async (_t: string, r: string) => (data.commits ?? []).filter((c) => c.repository === r),
    listRequestsOfKey: async () => data.requests ?? [],
    listDeploymentsOfRepo: async () => [],
    listPullRequestsOfRepo: async (_t: string, r: string) => prs.filter((p) => p.repository === r),
    listProjectGsi: async (_t: string, p: string, prefix: string) => (prefix === 'PR#' ? prs.filter((x) => (x.project_id ?? 'p1') === p) : []),
    listTaskSessionIds: async () => [],
    batchGet: async (ks: Array<{ PK: string; SK: string }>) =>
      data.sessions.filter((s) => ks.some((k) => k.PK === keys.session(T, s.session_id).PK)),
  };
  return repo as unknown as ProductivityRepository;
}

const noUsage = { getWindow: async () => Promise.reject(new Error('sin usage')) } as unknown as UsageService;
const svcWith = (repo: ProductivityRepository, integrations: Array<Record<string, unknown>> = []) =>
  new ProductivityService(repo, noUsage, () => new Date('2026-10-20T12:00:00.000Z'), {
    integrations: { listByTenant: async () => integrations as never },
    fireTrigger: async () => undefined,
  });

const ana = 'ana@x.io';
const bob = 'bob@x.io';

function twoDevelopers() {
  return fakeRepo({
    sessions: [
      session('s1', { key_id: 'k1', developer: ana, developer_name: 'Ana', branch: 'feature/MAG-1' }),
      session('s2', { key_id: 'k1', developer: bob, branch: 'feature/MAG-2', started_at: '2026-10-20T10:30:00.000Z' }),
      session('s3', { key_id: 'k1', developer: ana, repository: 'org/other', branch: 'main' }),
    ],
    requests: [request('r1', 1000, { session_id: 's1' }), request('r2', 400, { session_id: 's2' }), request('r3', 50, { session_id: 's3', repository: 'org/other' })],
    changes: [accepted('c1', 'r1', 10, { session_id: 's1' }), accepted('c2', 'r2', 20, { session_id: 's2' })],
    commits: [
      commit('a'.repeat(40), ['c1'], 5, { session_id: 's1', branch: 'feature/MAG-1', developer: ana }),
      commit('b'.repeat(40), ['c2'], 8, { session_id: 's2', branch: 'feature/MAG-2', developer: bob }),
    ],
    prs: PRS.map((p) => ({ ...p, project_id: 'p1', last_event_at: '2026-10-20T11:00:00.000Z' })),
  });
}

describe('lecturas con ?developer / ?pr_author / ?repository', () => {
  it('summary?developer: solo sesiones, peticiones, cambios y commits de ese developer', async () => {
    const svc = svcWith(twoDevelopers());
    const s = await svc.summary(caller, 'key', { developer: ana, from: FROM, to: TO });
    expect(s.scope.developer).toBe(ana);
    expect(s.counts).toMatchObject({ sessions: 2, ai_requests: 2, changes_accepted: 1, commits: 1 });
    expect(s.tokens.reported_by_requests.value).toBe(1050);

    const both = await svc.summary(caller, 'key', { developer: ana, repository: 'org/repo', from: FROM, to: TO });
    expect(both.counts).toMatchObject({ sessions: 1, ai_requests: 1 });
    expect(both.tokens.reported_by_requests.value).toBe(1000);
  });

  it('summary?developer: PRs cuya rama origen tiene sesiones del developer', async () => {
    const s = await svcWith(twoDevelopers()).summary(caller, 'key', { developer: bob, from: FROM, to: TO });
    expect(s.counts).toMatchObject({ sessions: 1, pull_requests: 1, pull_requests_merged: 1 });
  });

  it('pr_author → sus PRs → ramas origen → sesiones/commits y tareas', async () => {
    const svc = svcWith(twoDevelopers());
    const sessions = await svc.sessions(caller, 'key', { pr_author: 'anadev', from: FROM, to: TO });
    expect(sessions.map((x) => x.session_id)).toEqual(['s1']);
    const s = await svc.summary(caller, 'key', { pr_author: 'anadev', from: FROM, to: TO });
    expect(s.scope.pr_author).toBe('anadev');
    expect(s.counts).toMatchObject({ sessions: 1, commits: 1, pull_requests: 1, tasks: 1 });
    // autor sin PRs ⇒ nada
    expect(await svc.sessions(caller, 'key', { pr_author: 'nadie', from: FROM, to: TO })).toEqual([]);
  });

  it('changes y timeline respetan ?developer', async () => {
    const svc = svcWith(twoDevelopers());
    expect((await svc.changes(caller, 'key', { project_id: 'p1', developer: bob, from: FROM, to: TO })).map((c) => c.change_id)).toEqual(['c2']);
    const tl = await svc.timeline(caller, 'key', { developer: bob, from: FROM, to: TO }, 'day');
    expect(tl.reduce((a, p) => a + p.accepted_lines, 0)).toBe(20);
  });

  it('commits?developer&pr_author y campos del push (verified_remote, remote_*; solo-push ⇒ null)', async () => {
    const repo = fakeRepo({
      sessions: [session('s1', { developer: ana })],
      commits: [
        commit('a'.repeat(40), [], 3, { session_id: 's1', branch: 'feature/MAG-1', verified_remote: true, remote_branch: 'feature/MAG-1', remote_pushed_at: '2026-10-20T11:00:00.000Z' }),
        commit('c'.repeat(40), [], 0, {
          session_id: '',
          branch: 'feature/MAG-1',
          commit_source: 'git-remote',
          remote_only: true,
          verified_remote: true,
          remote_branch: 'feature/MAG-1',
          automation: { commit_added_lines: 0, ai_matched_lines: 0, ai_share: 0, ai_lost_lines: 0, effective_lines: 0 },
        }),
      ],
      prs: PRS,
    });
    const svc = svcWith(repo);
    const all = await svc.commits(caller, { repository: 'org/repo' });
    const remote = all.find((c) => c.sha.startsWith('c'))!;
    expect(remote).toMatchObject({ session_id: null, verified_remote: true, remote_branch: 'feature/MAG-1', remote_pushed_at: null, remote_only: true });
    expect(remote.automation).toEqual({ commit_added_lines: null, ai_matched_lines: null, ai_share: null, ai_lost_lines: null, effective_lines: null });
    expect(all.find((c) => c.sha.startsWith('a'))).toMatchObject({ verified_remote: true, remote_pushed_at: '2026-10-20T11:00:00.000Z', developer: ana });

    // developer heredado de la sesión (el commit no lo trae); el solo-push no tiene developer
    expect((await svc.commits(caller, { developer: ana })).map((c) => c.sha[0])).toEqual(['a']);
    expect((await svc.commits(caller, { pr_author: 'anadev' })).map((c) => c.sha[0]).sort()).toEqual(['a', 'c']);
    expect(await svc.commits(caller, { pr_author: 'bob' })).toEqual([]);
  });
});

describe('GET /productivity/filters', () => {
  it('repositorios (sesiones + integraciones + PRs), developers y autores de PR, ordenados', async () => {
    const repo = fakeRepo({
      sessions: [
        session('s1', { developer: 'zoe@x.io', developer_name: 'Zoe', repository: 'org/zeta' }),
        session('s2', { developer: ana, developer_name: 'Ana Old', started_at: '2026-10-19T10:00:00.000Z' }),
        session('s3', { developer: ana, developer_name: 'Ana', started_at: '2026-10-20T10:00:00.000Z' }),
        session('s4', {}),
        session('s5', { project_id: 'other', developer: 'other@x.io' }),
      ],
      prs: [...PRS, { ...PRS[0]!, number: 3 }, { repository: 'org/prs-only', number: 9, author_login: 'bob' }],
      projects: [{ project_id: 'p1', repositories: ['org/repo'], last_activity_at: '2026-10-20T11:00:00.000Z' }],
    });
    const out = await svcWith(repo, [{ project_id: 'p1', repository: 'org/from-int', status: 'active' }, { project_id: 'x', repository: 'org/x', status: 'active' }]).filters(caller, { project_id: 'p1' });
    expect(FilterOptions.parse(out)).toEqual({
      repositories: ['org/from-int', 'org/prs-only', 'org/repo', 'org/zeta'],
      developers: [
        { id: ana, name: 'Ana', sessions: 2 },
        { id: 'zoe@x.io', name: 'Zoe', sessions: 1 },
      ],
      pr_authors: [
        { login: 'AnaDev', pull_requests: 2 },
        { login: 'bob', pull_requests: 2 },
      ],
    });
  });
});

describe('GET /productivity/projects', () => {
  it('incluye proyectos con sesiones IDE aunque falte la fila Project, y los de integraciones', async () => {
    const repo = fakeRepo({
      sessions: [],
      requests: [request('r1', 10, { project_id: 'magi-hackaton', repository: 'org/hack', occurred_at: '2026-10-20T11:30:00.000Z' })],
      projects: [{ project_id: 'p1', repositories: ['org/repo'], last_activity_at: '2026-10-20T11:00:00.000Z' }],
    });
    const out = await svcWith(repo, [{ project_id: 'int-only', repository: 'org/int', status: 'active' }]).projects(caller);
    expect(out).toEqual([
      { project_id: 'magi-hackaton', repositories: ['org/hack'], last_activity_at: '2026-10-20T11:30:00.000Z' },
      { project_id: 'p1', repositories: ['org/repo'], last_activity_at: '2026-10-20T11:00:00.000Z' },
      { project_id: 'int-only', repositories: ['org/int'], last_activity_at: '' },
    ]);
  });
});
