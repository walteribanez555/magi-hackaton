import { keys } from '@magicode/contracts';
import { webhooksRepository, type Item, type WebhooksRepository } from '../webhooks/webhooks.repository';
import type { TaskItem, TaskLinkItem } from './tasks.types';

export class TasksRepository {
  constructor(private readonly store: WebhooksRepository = webhooksRepository) {}

  byProject(t: string, project: string, limit = 200): Promise<TaskItem[]> {
    const pk = keys.taskGsi1(t, project, '').GSI1PK;
    return this.store.queryPrefix<TaskItem>(pk, 'TASK#', { index: 'GSI1', desc: true, limit });
  }

  async get(t: string, taskKey: string): Promise<TaskItem | null> {
    return (await this.store.get(keys.task(t, taskKey))) as TaskItem | null;
  }

  links(t: string, taskKey: string): Promise<TaskLinkItem[]> {
    return this.store.queryPrefix<TaskLinkItem>(keys.taskPk(t, taskKey), 'L#', { limit: 2000 });
  }

  /** AiRequest (R#) y Change (C#) de una sesión — para tokens y líneas. */
  async sessionRows(t: string, sessionId: string): Promise<{ requests: Item[]; changes: Item[] }> {
    const pk = keys.sessionPk(t, sessionId);
    const [requests, changes] = await Promise.all([
      this.store.queryPrefix(pk, 'R#', { limit: 5000 }),
      this.store.queryPrefix(pk, 'C#', { limit: 5000 }),
    ]);
    return { requests, changes };
  }

  sessions(t: string, ids: string[]): Promise<Item[]> {
    return this.store.batchGet(ids.map((id) => keys.session(t, id)));
  }

  /** Deployments del repo (regla de despliegue: SHA del commit o merge/head de su PR). */
  deploymentsOf(t: string, repository: string): Promise<Item[]> {
    return this.store.queryPrefix(keys.repoPk(t, repository), 'DEPLOY#', { limit: 2000 });
  }

  commits(t: string, refs: Array<{ repository: string; sha: string }>): Promise<Item[]> {
    return this.store.batchGet(refs.map((r) => keys.commit(t, r.repository, r.sha)));
  }
}

export const tasksRepository = new TasksRepository();
