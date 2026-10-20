import { keys } from '@magicode/contracts';
import { webhooksRepository, type WebhooksRepository } from '../webhooks/webhooks.repository';
import type { BranchItem } from './branches.types';

const projectGsiPk = (t: string, project: string) => keys.branchGsi1(t, project, '').GSI1PK;

export class BranchesRepository {
  constructor(private readonly store: WebhooksRepository = webhooksRepository) {}

  byRepository(t: string, repository: string): Promise<BranchItem[]> {
    return this.store.queryPrefix<BranchItem>(keys.repoPk(t, repository), 'BRANCH#', { limit: 2000 });
  }

  byProject(t: string, project: string): Promise<BranchItem[]> {
    return this.store.queryPrefix<BranchItem>(projectGsiPk(t, project), 'BRANCH#', { index: 'GSI1', desc: true, limit: 2000 });
  }

  /** Proyectos del tenant: filas Project (IDE) + proyectos de las integraciones. */
  async projectIds(t: string): Promise<string[]> {
    const pk = keys.project(t, 'x').PK;
    const [projects, integrations] = await Promise.all([
      this.store.queryPrefix(pk, 'P#', { limit: 500 }),
      this.store.queryPrefix(pk, 'INT#', { limit: 500 }),
    ]);
    return [...new Set([...projects, ...integrations].map((i) => i.project_id).filter((p): p is string => typeof p === 'string'))];
  }

  batchGet(t: string, refs: Array<{ repository: string; branch: string }>): Promise<BranchItem[]> {
    return this.store.batchGet(refs.map((r) => keys.branch(t, r.repository, r.branch)));
  }
}

export const branchesRepository = new BranchesRepository();
