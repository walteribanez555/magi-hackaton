import { randomUUID } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import { createLogger } from '../../config/logger';
import type { AppEnv } from '../../app.types';

const logger = createLogger('Http');

/** request_id + log JSON de acceso (sin headers ni cuerpo: nunca se loguea Authorization). */
export const requestLogger = createMiddleware<AppEnv>(async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const requestId = incoming && /^[\w\-.:]{1,128}$/.test(incoming) ? incoming : randomUUID();
  c.set('requestId', requestId);
  c.set('logger', logger.child({ request_id: requestId }));
  const start = Date.now();
  await next();
  c.header('x-request-id', requestId);
  c.get('logger').info('request', {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration_ms: Date.now() - start,
  });
});
