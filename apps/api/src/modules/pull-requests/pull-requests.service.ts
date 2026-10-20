import { asArray } from '../branches/branches.service';
import { branchesRepository, type BranchesRepository } from '../branches/branches.repository';
import { branchRef, developerSessionIds, hasScopeFilters, pullRequestMatches } from '../productivity/productivity.filters';
import { pullRequestsRepository, type PullRequestsRepository } from './pull-requests.repository';
import type {
  CommitLite,
  PullRequestItem,
  PullRequestListItem,
  PullRequestQuery,
  PullRequestTotals,
} from './pull-requests.types';

/** Bitbucket manda SHAs cortos (12) en merge_commit: se compara por prefijo. */
export const shaMatch = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
};

/**
 * Commits que se atribuyen al PR: los de la rama origen (rama local del IDE o rama del push remoto)
 * + head + merge commit. Es una aproximación (no recorre ancestros) ⇒ provenance estimated.
 */
export function prCommits(pr: Pick<PullRequestItem, 'source_branch' | 'head_sha' | 'merge_sha'>, commits: CommitLite[]): CommitLite[] {
  return commits.filter(
    (c) =>
      (!!pr.source_branch && (c.branch === pr.source_branch || c.remote_branch === pr.source_branch)) ||
      shaMatch(c.sha, pr.head_sha) ||
      shaMatch(c.sha, pr.merge_sha),
  );
}

export function toPullRequestListItem(pr: PullRequestItem, commits: CommitLite[]): PullRequestListItem {
  const mine = prCommits(pr, commits);
  const ai = mine.reduce(
    (acc, c) => {
      const matched = c.automation?.ai_matched_lines ?? 0;
      acc.ai_matched_lines += matched;
      acc.commit_added_lines += c.automation?.commit_added_lines ?? 0;
      if (matched > 0) acc.commits_with_ai++;
      return acc;
    },
    { ai_matched_lines: 0, commit_added_lines: 0, commits_with_ai: 0 },
  );
  return {
    repository: pr.repository,
    number: pr.number,
    state: pr.state,
    source_branch: pr.source_branch,
    target_branch: pr.target_branch,
    task_keys: asArray(pr.task_keys).sort(),
    head_sha: pr.head_sha,
    merge_sha: pr.merge_sha ?? null,
    url: pr.url,
    author_login: typeof pr.author_login === 'string' && pr.author_login ? pr.author_login : null,
    opened_at: pr.opened_at ?? null,
    merged_at: pr.merged_at ?? null,
    closed_at: pr.closed_at ?? null,
    updated_at: pr.last_event_at ?? pr.updated_at ?? '',
    ai: {
      commits: mine.length,
      ...ai,
      contains_ai_lines: ai.ai_matched_lines > 0,
      provenance: 'estimated',
    },
  };
}

export function totalsOf(items: PullRequestListItem[]): PullRequestTotals {
  return {
    total: items.length,
    open: items.filter((i) => i.state === 'open').length,
    merged: items.filter((i) => i.state === 'merged').length,
    closed: items.filter((i) => i.state === 'closed').length,
    with_ai_lines: items.filter((i) => i.ai.contains_ai_lines).length,
  };
}

export class PullRequestsService {
  constructor(
    private readonly repo: PullRequestsRepository = pullRequestsRepository,
    private readonly branches: BranchesRepository = branchesRepository,
  ) {}

  /**
   * ?repository ?developer ?pr_author (AND, productivity.filters): pr_author por author_login;
   * developer ⇒ PRs cuya rama origen (Branch.session_ids) tiene sesiones de ese developer.
   */
  async applyScope(tenantId: string, prs: PullRequestItem[], q: Pick<PullRequestQuery, 'repository' | 'developer' | 'pr_author'>): Promise<PullRequestItem[]> {
    if (!hasScopeFilters(q)) return prs;
    let devBranches: Set<string> | undefined;
    if (q.developer) {
      const refs = [...new Map(prs.filter((p) => p.source_branch).map((p) => [branchRef(p.repository, p.source_branch), { repository: p.repository, branch: p.source_branch }])).values()];
      const branchItems = refs.length ? await this.branches.batchGet(tenantId, refs) : [];
      const ids = [...new Set(branchItems.flatMap((b) => asArray(b.session_ids)))];
      const devIds = developerSessionIds(ids.length ? await this.branches.sessions(tenantId, ids) : [], q.developer);
      devBranches = new Set(branchItems.filter((b) => asArray(b.session_ids).some((id) => devIds.has(id))).map((b) => branchRef(b.repository, b.branch)));
    }
    return prs.filter((p) => pullRequestMatches(p, q, { devBranches }));
  }

  async listItems(tenantId: string, q: Omit<PullRequestQuery, 'state'>): Promise<PullRequestItem[]> {
    if (q.repository) {
      const items = await this.repo.byRepository(tenantId, q.repository);
      return q.project_id ? items.filter((i) => !i.project_id || i.project_id === q.project_id) : items;
    }
    if (q.project_id) return this.repo.byProject(tenantId, q.project_id);
    const projects = await this.branches.projectIds(tenantId);
    return (await Promise.all(projects.map((p) => this.repo.byProject(tenantId, p)))).flat();
  }

  /** Enriquecer con líneas IA: un Query de commits por repositorio presente. */
  async enrich(tenantId: string, prs: PullRequestItem[]): Promise<PullRequestListItem[]> {
    const repos = [...new Set(prs.map((p) => p.repository))];
    const commitsByRepo = new Map<string, CommitLite[]>();
    await Promise.all(repos.map(async (r) => commitsByRepo.set(r, await this.repo.commitsOf(tenantId, r))));
    return prs.map((p) => toPullRequestListItem(p, commitsByRepo.get(p.repository) ?? []));
  }

  /** GET /pull-requests — totales (open/merged/closed) en meta, calculados ANTES del filtro de estado. */
  async list(tenantId: string, q: PullRequestQuery): Promise<{ data: PullRequestListItem[]; meta: PullRequestTotals }> {
    const raw = await this.listItems(tenantId, q);
    const unique = await this.applyScope(tenantId, [...new Map(raw.map((p) => [`${p.repository}#${p.number}`, p])).values()], q);
    const items = (await this.enrich(tenantId, unique)).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const meta = totalsOf(items);
    return { data: q.state ? items.filter((i) => i.state === q.state) : items, meta };
  }
}

export const pullRequestsService = new PullRequestsService();
