import { Hono } from 'hono';
import type { AppEnv } from '../../app.types';
import { BadRequestException, handleException } from '../../common/exceptions';
import { taskSyncService } from '../task-sync/task-sync.service';
import { readScopeFilters } from '../productivity/productivity.filters';
import { tasksService } from './tasks.service';
import type { StatusCategory } from './tasks.types';

const CATEGORIES: StatusCategory[] = ['todo', 'in_progress', 'done'];

/**
 * Mount path: /api/v1/tasks — detrás del Bearer auth (tenant = c.get('tenant_id')).
 *   GET  /                       ?project_id&repository&developer&pr_author&status_category → { data: TaskListItem[], meta: { total } }
 *   GET  /:taskKey               → { data: TaskListItem & { criticality, linked: { sessions, commits, branches, pull_requests, deployments } } }
 *   GET  /:taskKey/actions       → { data: OutboxAction[] }  (auditoría, más reciente primero)
 *   POST /:taskKey/actions       TaskActionRequest → 202 { data: OutboxAction } | 200 si idempotency_key repetida
 *   GET  /:taskKey/transitions   → { data: AvailableTransition[] }  (en vivo contra Jira/Linear)
 */
export const tasksRouter = new Hono<AppEnv>();

tasksRouter.get('/', async (c) => {
  try {
    const category = c.req.query('status_category') || undefined;
    if (category && !CATEGORIES.includes(category as StatusCategory)) {
      throw new BadRequestException(`status_category debe ser ${CATEGORIES.join('|')}`, 'INVALID_STATUS_CATEGORY');
    }
    const data = await tasksService.list(c.get('tenant_id'), {
      project_id: c.req.query('project_id') || undefined,
      ...readScopeFilters((k) => c.req.query(k)),
      status_category: category as StatusCategory | undefined,
    });
    return c.json({ data, meta: { total: data.length, tokens_provenance: 'estimated' } });
  } catch (err) {
    return handleException(err, c);
  }
});

tasksRouter.get('/:taskKey/actions', async (c) => {
  try {
    const data = await taskSyncService.listActions(c.get('tenant_id'), c.req.param('taskKey'));
    return c.json({ data, meta: { total: data.length } });
  } catch (err) {
    return handleException(err, c);
  }
});

tasksRouter.post('/:taskKey/actions', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { item, duplicate } = await taskSyncService.enqueueManual(
      { tenant_id: c.get('tenant_id'), key_id: c.get('key_id') },
      c.req.param('taskKey'),
      body,
    );
    return c.json({ data: item, meta: { duplicate } }, duplicate ? 200 : 202);
  } catch (err) {
    return handleException(err, c);
  }
});

tasksRouter.get('/:taskKey/transitions', async (c) => {
  try {
    return c.json({ data: await taskSyncService.transitions(c.get('tenant_id'), c.req.param('taskKey')) });
  } catch (err) {
    return handleException(err, c);
  }
});

tasksRouter.get('/:taskKey', async (c) => {
  try {
    return c.json({ data: await tasksService.detail(c.get('tenant_id'), c.req.param('taskKey')) });
  } catch (err) {
    return handleException(err, c);
  }
});
