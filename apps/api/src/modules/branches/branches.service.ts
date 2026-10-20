import type { BranchListItem } from '@magicode/contracts';
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
  constructor(private readonly repo: BranchesRepository = branchesRepository) {}

  /** GET /branches?project_id&repository — más reciente primero. */
  async list(tenantId: string, q: BranchQuery): Promise<BranchListItem[]> {
    let items: BranchItem[];
    if (q.repository) {
      items = await this.repo.byRepository(tenantId, q.repository);
      if (q.project_id) items = items.filter((i) => !i.project_id || i.project_id === q.project_id);
    } else if (q.project_id) {
      items = await this.repo.byProject(tenantId, q.project_id);
    } else {
      const projects = await this.repo.projectIds(tenantId);
      items = (await Promise.all(projects.map((p) => this.repo.byProject(tenantId, p)))).flat();
    }
    const seen = new Set<string>();
    return items
      .filter((i) => q.include_deleted || i.deleted !== true)
      .filter((i) => {
        const k = `${i.repository}|${i.branch}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map(toBranchListItem)
      .sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
  }
}

export const branchesService = new BranchesService();
