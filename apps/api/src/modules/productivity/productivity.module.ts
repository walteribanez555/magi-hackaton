import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { TaskKey } from '@magicode/contracts';
import type { AppEnv } from '../../app.types';
import { config } from '../../config/config';
import { BadRequestException } from '../../common/exceptions';
import { resolveWindow } from '../../common/utils/time';
import { productivityService } from './productivity.service';
import type { ProductivityQuery } from './productivity.types';

/** /productivity — ingesta de eventos del IDE y lecturas para el dashboard. */
export const productivityRouter = new Hono<AppEnv>();

const Query = z.object({
  project_id: z.string().min(1).max(128).optional(),
  repository: z.string().min(1).max(256).optional(),
  session_id: z.string().min(1).max(128).optional(),
  task_key: TaskKey.optional(),
  branch: z.string().min(1).max(256).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  bucket: z.enum(['hour', 'day']).optional(),
  refresh: z.enum(['true', 'false', '1', '0']).optional(),
});

function readQuery(c: Context<AppEnv>, defaultDays = 7): ProductivityQuery & { bucket?: 'hour' | 'day'; refresh: boolean } {
  const parsed = Query.safeParse(c.req.query());
  if (!parsed.success) {
    throw new BadRequestException('Parámetros inválidos', 'INVALID_QUERY', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  const q = parsed.data;
  const win = resolveWindow(q.from, q.to, { defaultDays, maxDays: config.getValue('usage').maxWindowDays });
  return { ...q, ...win, refresh: q.refresh === 'true' || q.refresh === '1' };
}

const callerOf = (c: Context<AppEnv>) => ({ tenant_id: c.get('tenant_id'), key_id: c.get('key_id') });

productivityRouter.post('/events', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new BadRequestException('Cuerpo JSON inválido', 'INVALID_JSON');
  }
  // El tenant sale de la API key; si el cuerpo trae tenant_id, zod lo descarta.
  const result = await productivityService.ingest(callerOf(c), body);
  return c.json({ data: result }, 202);
});

productivityRouter.get('/summary', async (c) => {
  const q = readQuery(c);
  return c.json({ data: await productivityService.summary(callerOf(c), c.get('apiKey'), q, q.refresh) });
});

productivityRouter.get('/timeline', async (c) => {
  const q = readQuery(c);
  const bucket = q.bucket ?? (Date.parse(q.to) - Date.parse(q.from) <= 2 * 86_400_000 ? 'hour' : 'day');
  return c.json({ data: await productivityService.timeline(callerOf(c), c.get('apiKey'), q, bucket), meta: { bucket } });
});

productivityRouter.get('/projects', async (c) => {
  return c.json({ data: await productivityService.projects(callerOf(c)) });
});

productivityRouter.get('/sessions', async (c) => {
  return c.json({ data: await productivityService.sessions(callerOf(c), c.get('apiKey'), readQuery(c)) });
});

productivityRouter.get('/sessions/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const win = from || to ? resolveWindow(from, to, { maxDays: config.getValue('usage').maxWindowDays }) : {};
  return c.json({ data: await productivityService.session(callerOf(c), c.get('apiKey'), sessionId, win) });
});

productivityRouter.get('/changes', async (c) => {
  const q = readQuery(c);
  if (!q.session_id && !q.project_id) throw new BadRequestException('Se requiere session_id o project_id', 'MISSING_SCOPE');
  return c.json({ data: await productivityService.changes(callerOf(c), c.get('apiKey'), q) });
});

productivityRouter.get('/commits', async (c) => {
  const repository = c.req.query('repository') || undefined;
  const from = c.req.query('from');
  const to = c.req.query('to');
  const win = from || to ? resolveWindow(from, to, { maxDays: 3650 }) : {};
  return c.json({ data: await productivityService.commits(callerOf(c), { repository, ...win }) });
});
