import { Hono, type Context } from 'hono';
import type { AppEnv } from '../../app.types';
import { handleException } from '../../common/exceptions';
import { integrationHealthRouter } from '../integration-health/integration-health.module';
import { taskSyncService } from '../task-sync/task-sync.service';
import { integrationsService } from './integrations.service';

/**
 * Mount path: /api/v1/integrations — DETRÁS del Bearer auth (tenant = c.get('tenant_id')).
 *   GET    /                         → { data: Integration[] }        (?project_id) — sin secretos
 *   POST   /                         → 201 { data: IntegrationCreated } — secreto UNA vez
 *   DELETE /:integrationId           → { data: Integration }          (status=disabled)
 *   POST   /:integrationId/rotate-secret → { data: IntegrationCreated } — nuevo secreto UNA vez
 * Write-back (solo Jira/Linear):
 *   PUT    /:integrationId/credentials   TaskProviderCredentials → 204 (Secrets Manager; nunca se devuelven)
 *   GET    /:integrationId/rules         → { data: AutomationRule[] }
 *   POST   /:integrationId/rules         AutomationRuleUpsert → 201 { data: AutomationRule }
 *   PUT    /:integrationId/rules/:ruleId AutomationRuleUpsert → { data: AutomationRule }
 *   DELETE /:integrationId/rules/:ruleId → 204
 * Salud (integration-health.module): GET /:id/health · POST /:id/register-webhook · POST /:id/test · GET /:id/tests/:testId
 */
export const integrationsRouter = new Hono<AppEnv>();

const scope = (c: Context<AppEnv>) => ({ tenant_id: c.get('tenant_id'), key_id: c.get('key_id') });

const requestOrigin = (c: Context<AppEnv>): string | undefined => {
  try {
    return new URL(c.req.url).origin;
  } catch {
    return undefined;
  }
};

integrationsRouter.get('/', async (c) => {
  try {
    const data = await integrationsService.list(c.get('tenant_id'), c.req.query('project_id') || undefined);
    return c.json({ data, meta: { total: data.length } });
  } catch (err) {
    return handleException(err, c);
  }
});

integrationsRouter.post('/', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const data = await integrationsService.create(scope(c), body, requestOrigin(c));
    c.header('Cache-Control', 'no-store');
    return c.json({ data }, 201);
  } catch (err) {
    return handleException(err, c);
  }
});

integrationsRouter.delete('/:integrationId', async (c) => {
  try {
    return c.json({ data: await integrationsService.disable(c.get('tenant_id'), c.req.param('integrationId')) });
  } catch (err) {
    return handleException(err, c);
  }
});

integrationsRouter.post('/:integrationId/rotate-secret', async (c) => {
  try {
    const data = await integrationsService.rotateSecret(c.get('tenant_id'), c.req.param('integrationId'));
    c.header('Cache-Control', 'no-store');
    return c.json({ data });
  } catch (err) {
    return handleException(err, c);
  }
});

integrationsRouter.put('/:integrationId/credentials', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    await taskSyncService.saveCredentials(scope(c), c.req.param('integrationId'), body);
    return c.body(null, 204);
  } catch (err) {
    return handleException(err, c);
  }
});

integrationsRouter.get('/:integrationId/rules', async (c) => {
  try {
    const data = await taskSyncService.listRules(c.get('tenant_id'), c.req.param('integrationId'));
    return c.json({ data, meta: { total: data.length } });
  } catch (err) {
    return handleException(err, c);
  }
});

integrationsRouter.post('/:integrationId/rules', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    return c.json({ data: await taskSyncService.createRule(scope(c), c.req.param('integrationId'), body) }, 201);
  } catch (err) {
    return handleException(err, c);
  }
});

integrationsRouter.put('/:integrationId/rules/:ruleId', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const data = await taskSyncService.updateRule(scope(c), c.req.param('integrationId'), c.req.param('ruleId'), body);
    return c.json({ data });
  } catch (err) {
    return handleException(err, c);
  }
});

integrationsRouter.delete('/:integrationId/rules/:ruleId', async (c) => {
  try {
    await taskSyncService.deleteRule(c.get('tenant_id'), c.req.param('integrationId'), c.req.param('ruleId'));
    return c.body(null, 204);
  } catch (err) {
    return handleException(err, c);
  }
});

// Salud, registro del webhook y pruebas de ida y vuelta (mismo prefijo /integrations)
integrationsRouter.route('/', integrationHealthRouter);
