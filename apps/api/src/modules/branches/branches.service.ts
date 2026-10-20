import type { BranchListItem } from '@magicode/contracts';
import { branchMatches, developerSessionIds, hasScopeFilters, prAuthorScope, type PrAuthorScope, type PrFilterRow } from '../productivity/productivity.filters';
import { pullRequestsRepository, type PullRequestsRepository } from '../pull-requests/pull-requests.repository';
import { branchesRepository, type BranchesRepository } from './branches.repository';
import type { BranchItem, BranchQuery } from './branches.types';

export const asArray = (v: unknown): string[] =>
  v instanceof Set ? [...(v as Set<string>)] : Array.isArray(v) ? (v as string[]).filter((x) => typeof x === 'string') : [];

export function toBranchListItem(item: BranchItem): BranchListItem {
  return {
    repository: item.repository,
    branch: item.branch,
    task_keys: asArray(item.task_keys).sort(),
    sessions: asArray(item.session_ids).length,
    commits: asArray(item.commit_shas).length,
    head_sha: typeof item.head_sha === 'string' && item.head_sha ? item.head_sha : null,
    merged_into: typeof item.merged_into === 'string' && item.merged_into ? item.merged_into : null,
    last_activity_at: item.last_activity_at ?? item.updated_at ?? '',
  };
}

export class BranchesService {
  constructor(
    private readonly repo: BranchesRepository = branchesRepository,
    private readonly prs: Pick<PullRequestsRepository, 'byRepository' | 'byProject'> = pullRequestsRepository,
  ) {}

  /**
   * GET /branches?project_id&repository&developer&pr_author — más reciente primero.
   * Con project_id solo las ramas del proyecto (la fila Branch la escribe el último proyecto que la
   * tocó: IDE o integración) y commits = commit_shas sin los commits ingeridos bajo OTRO proyecto.
   */
  async list(tenantId: string, q: BranchQuery): Promise<BranchListItem[]> {
    let items: BranchItem[];
    let projects: string[];
    if (q.repository) {
      items = await this.repo.byRepository(tenantId, q.repository);
      projects = q.project_id ? [q.project_id] : [];
    } else if (q.project_id) {
      items = await this.repo.byProject(tenantId, q.project_id);
      projects = [q.project_id];
    } else {
      projects = await this.repo.projectIds(tenantId);
      items = (await Promise.all(projects.map((p) => this.repo.byProject(tenantId, p)))).flat();
    }
    if (q.project_id) items = items.filter((i) => !i.project_id || i.project_id === q.project_id);
    const seen = new Set<string>();
    items = items
      .filter((i) => q.include_deleted || i.deleted !== true)
      .filter((i) => {
        const k = `${i.repository}|${i.branch}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    items = await this.applyScope(tenantId, items, q, projects);
    if (q.project_id) items = await this.scopeCommitsToProject(tenantId, items, q.project_id);
    return items.map(toBranchListItem).sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
  }

  /** commit_shas sin los commits cuya fila Commit pertenece a otro proyecto (desconocidos se conservan). */
  private async scopeCommitsToProject(tenantId: string, items: BranchItem[], projectId: string): Promise<BranchItem[]> {
    const repos = [...new Set(items.filter((i) => asArray(i.commit_shas).length).map((i) => i.repository))];
    if (!repos.length) return items;
    const owners = new Map<string, Map<string, string>>();
    await Promise.all(repos.map(async (r) => owners.set(r, await this.repo.commitProjects(tenantId, r).catch(() => new Map<string, string>()))));
    return items.map((i) => {
      const own = owners.get(i.repository);
      if (!own?.size) return i;
      const shas = asArray(i.commit_shas).filter((sha) => {
        const p = own.get(sha.toLowerCase());
        return !p || p === projectId;
      });
      return { ...i, commit_shas: shas };
    });
  }

  /** ?repository ?developer ?pr_author (productivity.filters, AND). */
  private async applyScope(tenantId: string, items: BranchItem[], q: BranchQuery, projects: string[]): Promise<BranchItem[]> {
    if (!hasScopeFilters(q)) return items;
    let devSessionIds: Set<string> | undefined;
    if (q.developer) {
      const ids = [...new Set(items.flatMap((i) => asArray(i.session_ids)))];
      devSessionIds = developerSessionIds(ids.length ? await this.repo.sessions(tenantId, ids) : [], q.developer);
    }
    let pa: PrAuthorScope | null = null;
    if (q.pr_author) {
      const prs = q.repository
        ? await this.prs.byRepository(tenantId, q.repository)
        : (await Promise.all((projects.length ? projects : await this.repo.projectIds(tenantId)).map((p) => this.prs.byProject(tenantId, p)))).flat();
      pa = prAuthorScope(prs as PrFilterRow[], q.pr_author);
    }
    return items.filter((i) => branchMatches(i, q, { pa, devSessionIds }));
  }
}

export const branchesService = new BranchesService();
