import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { config } from './config/config';
import { authMiddleware } from './common/middlewares/auth.middleware';
import { requestLogger } from './common/middlewares/request-logger.middleware';
import { handleException } from './common/exceptions';
import type { AppEnv } from './app.types';

// ── Routers de módulos ──────────────────────────────────────────────────────
import { productivityRouter } from './modules/productivity/productivity.module';
import { usageRouter } from './modules/usage/usage.module';
import { webhooksRouter } from './modules/webhooks/webhooks.module';
import { integrationsRouter } from './modules/integrations/integrations.module';
import { tasksRouter } from './modules/tasks/tasks.module';
import { branchesRouter } from './modules/branches/branches.module';
import { pullRequestsRouter } from './modules/pull-requests/pull-requests.module';
import { projectsRouter, repositoriesRouter } from './modules/integration-health/integration-health.module';

export const app = new Hono<AppEnv>();

// ── Middlewares globales ────────────────────────────────────────────────────
app.use('*', requestLogger);
app.use(
  '*',
  cors({
    // Se lee en cada petición: la config puede recargarse tras cargar secretos.
    origin: (origin) => {
      const { origins } = config.getValue('cors');
      if (origins.includes('*')) return '*';
      return origins.includes(origin) ? origin : (origins[0] ?? '');
    },
    allowMethods: config.getValue('cors').methods,
    allowHeaders: config.getValue('cors').headers,
    exposeHeaders: ['x-request-id', 'x-magicode-demo'],
    maxAge: 600,
  }),
);
app.onError((err, c) => handleException(err, c));
app.notFound((c) => c.json({ statusCode: 404, message: 'Not Found' }, 404));

app.get('/', (c) => c.json({ service: 'magicode-api', status: 'ok' }));

// ── /api/v1 ─────────────────────────────────────────────────────────────────
const v1 = new Hono<AppEnv>();

// Público: health (sin auth, sin llamadas a Dynamo/MagiHub)
v1.get('/health', (c) => {
  const cfg = config.get();
  return c.json({
    status: 'ok',
    service: 'magicode-api',
    env: cfg.environment,
    magihub_mode: cfg.magihub.mode,
    table: cfg.tableName,
    time: new Date().toISOString(),
  });
});

// Webhooks del repo origen / gestor de tareas: SIN Bearer (verifican la firma HMAC de la integración).
// Van ANTES del authMiddleware global.
v1.route('/webhooks', webhooksRouter);

// ── A partir de aquí, todo requiere Authorization: Bearer <MagiHub API key> ──
v1.use('*', authMiddleware);

v1.get('/whoami', (c) => c.json({ data: c.get('identity') }));
v1.route('/productivity', productivityRouter);
v1.route('/usage', usageRouter);
// Multitenant enlazado: proyecto → tarea → rama → PR (+ integraciones)
v1.route('/integrations', integrationsRouter);
v1.route('/tasks', tasksRouter);
v1.route('/branches', branchesRouter);
v1.route('/pull-requests', pullRequestsRouter);
v1.route('/projects', projectsRouter);
v1.route('/repositories', repositoriesRouter);

app.route('/api/v1', v1);
