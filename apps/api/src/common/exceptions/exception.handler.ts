import type { Context } from 'hono';
import { ZodError } from 'zod';
import type { ApiError } from '@magicode/contracts';
import { createLogger } from '../../config/logger';
import { HttpException } from './http.exception';

const logger = createLogger('Exception');

/** Traduce cualquier error a `ApiError` (contracts/api.ts). Nunca filtra stack ni secretos. */
export function handleException(err: unknown, c: Context): Response {
  if (err instanceof HttpException) {
    const body: ApiError & { code?: string } = {
      statusCode: err.statusCode,
      message: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.details !== undefined ? { details: err.details } : {}),
    };
    if (err.statusCode >= 500) logger.error(err.message, { code: err.code });
    return c.json(body, err.statusCode as Parameters<typeof c.json>[1]);
  }
  if (err instanceof ZodError) {
    const body: ApiError & { code: string } = {
      statusCode: 400,
      message: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
    };
    return c.json(body, 400);
  }
  logger.error('Unhandled error', err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err);
  const body: ApiError = { statusCode: 500, message: 'An unexpected error occurred.' };
  return c.json(body, 500);
}
