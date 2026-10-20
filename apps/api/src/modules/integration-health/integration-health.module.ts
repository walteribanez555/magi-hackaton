import { Hono } from 'hono';
import type { AppEnv } from '../../app.types';
import { handleException } from '../../common/exceptions';
import { integrationHealthService } from './integration-health.service';

/**
 * Rutas de salud bajo /api/v1/integrations (YA montadas dentro de integrationsRouter):
 *   GET  /:integrationId/health            ?refresh=true consulta al proveedor → { data: IntegrationHealth }
 *   POST /:integrationId/register-webhook  → { data: RegisterWebhookResult }
 *   POST /:integrationId/test              IntegrationTestRequest → 202 { data: IntegrationTestRun }
 *   GET  /:integrationId/tests/:testId     → { data: IntegrationTestRun }  (timeout perezoso)
 */
export const integrationHealthRouter = new Hono<AppEnv>();

integrationHealthRouter.get('/:integrationId/health', async (c) => {
  try {
    const refresh = c.req.query('refresh') === 'true';
    return c.json({ data: await integrationHealthService.health(c.get('tenant_id'), c.req.param('integrationId'), refresh) });
  } catch (err) {
    return handleException(err, c);
  }
});

integrationHealthRouter.post('/:integrationId/register-webhook', async (c) => {
  try {
    return c.json({ data: await integrationHealthService.registerWebhook(c.get('tenant_id'), c.req.param('integrationId')) });
  } catch (err) {
    return handleException(err, c);
  }
});

integrationHealthRouter.post('/:integrationId/test', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const data = await integrationHealthService.startTest(c.get('tenant_id'), c.req.param('integrationId'), body);
    return c.json({ data }, data.status === 'pending' ? 202 : 200);
  } catch (err) {
    return handleException(err, c);
  }
});

integrationHealthRouter.get('/:integrationId/tests/:testId', async (c) => {
  try {
    return c.json({ data: await integrationHealthService.getTest(c.get('tenant_id'), c.req.param('integrationId'), c.req.param('testId')) });
  } catch (err) {
    return handleException(err, c);
  }
});

/**
 * Mount path: /api/v1/projects — detrás del Bearer auth.
 *   GET /:projectId/readiness → { data: ProjectReadiness }   (sin llamadas al proveedor)
 */
export const projectsRouter = new Hono<AppEnv>();

projectsRouter.get('/:projectId/readiness', async (c) => {
  try {
    return c.json({ data: await integrationHealthService.projectReadiness(c.get('tenant_id'), c.req.param('projectId')) });
  } catch (err) {
    return handleException(err, c);
  }
});

/**
 * Mount path: /api/v1/repositories — detrás del Bearer auth.
 *   GET /                         ?project_id → { data: RepositoryOption[] }  (lista desplegable)
 *   GET /:repository/readiness    repository URL-encoded ("org%2Frepo"; también acepta org/repo) → { data: RepositoryReadiness }
 */
export const repositoriesRouter = new Hono<AppEnv>();

repositoriesRouter.get('/', async (c) => {
  try {
    const data = await integrationHealthService.repositoryOptions(c.get('tenant_id'), c.req.query('project_id') || undefined);
    return c.json({ data, meta: { total: data.length, ready: data.filter((d) => d.ready).length } });
  } catch (err) {
    return handleException(err, c);
  }
});

repositoriesRouter.get('/:repository{.+}/readiness', async (c) => {
  try {
    const repository = decodeURIComponent(c.req.param('repository'));
    const data = await integrationHealthService.repositoryReadiness(c.get('tenant_id'), repository, c.req.query('project_id') || undefined);
    return c.json({ data });
  } catch (err) {
    return handleException(err, c);
  }
});
