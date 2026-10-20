import { Hono } from 'hono';
import type { AppEnv } from '../../app.types';
import { handleException } from '../../common/exceptions';
import { branchesService } from './branches.service';

/**
 * Mount path: /api/v1/branches — detrás del Bearer auth.
 *   GET / ?project_id&repository&include_deleted=true → { data: BranchListItem[], meta: { total } }
 */
export const branchesRouter = new Hono<AppEnv>();

branchesRouter.get('/', async (c) => {
  try {
    const data = await branchesService.list(c.get('tenant_id'), {
      project_id: c.req.query('project_id') || undefined,
      repository: c.req.query('repository') || undefined,
      include_deleted: c.req.query('include_deleted') === 'true',
    });
    return c.json({ data, meta: { total: data.length } });
  } catch (err) {
    return handleException(err, c);
  }
});
