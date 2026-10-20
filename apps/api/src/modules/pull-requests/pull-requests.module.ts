import { Hono } from 'hono';
import type { AppEnv } from '../../app.types';
import { BadRequestException, handleException } from '../../common/exceptions';
import { pullRequestsService } from './pull-requests.service';
import type { PullRequestState } from './pull-requests.types';

const STATES: PullRequestState[] = ['open', 'closed', 'merged'];

/**
 * Mount path: /api/v1/pull-requests — detrás del Bearer auth.
 *   GET / ?project_id&repository&state=open|merged|closed
 *     → { data: PullRequestListItem[], meta: { total, open, merged, closed, with_ai_lines } }
 */
export const pullRequestsRouter = new Hono<AppEnv>();

pullRequestsRouter.get('/', async (c) => {
  try {
    const state = c.req.query('state') || undefined;
    if (state && !STATES.includes(state as PullRequestState)) {
      throw new BadRequestException(`state debe ser ${STATES.join('|')}`, 'INVALID_STATE');
    }
    const out = await pullRequestsService.list(c.get('tenant_id'), {
      project_id: c.req.query('project_id') || undefined,
      repository: c.req.query('repository') || undefined,
      state: state as PullRequestState | undefined,
    });
    return c.json(out);
  } catch (err) {
    return handleException(err, c);
  }
});
