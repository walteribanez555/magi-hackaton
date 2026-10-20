import { keys } from '@magicode/contracts';
import { webhooksRepository, type WebhooksRepository } from '../webhooks/webhooks.repository';
import type { CommitLite, PullRequestItem } from './pull-requests.types';

export class PullRequestsRepository {
  constructor(private readonly store: WebhooksRepository = webhooksRepository) {}

  byRepository(t: string, repository: string): Promise<PullRequestItem[]> {
    return this.store.queryPrefix<PullRequestItem>(keys.repoPk(t, repository), 'PR#', { limit: 2000 });
  }

  byProject(t: string, project: string): Promise<PullRequestItem[]> {
    const pk = keys.pullRequestGsi1(t, project, '').GSI1PK;
    return this.store.queryPrefix<PullRequestItem>(pk, 'PR#', { index: 'GSI1', desc: true, limit: 2000 });
  }

  /** Commits del repositorio (IDE + remoto) para cruzar líneas IA. */
  commitsOf(t: string, repository: string): Promise<CommitLite[]> {
    return this.store.queryPrefix<CommitLite>(keys.repoPk(t, repository), 'COMMIT#', { limit: 5000 });
  }

  batchGet(t: string, refs: Array<{ repository: string; number: number }>): Promise<PullRequestItem[]> {
    return this.store.batchGet<PullRequestItem>(refs.map((r) => keys.pullRequest(t, r.repository, r.number)));
  }
}

export const pullRequestsRepository = new PullRequestsRepository();
