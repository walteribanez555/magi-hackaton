import { Hono } from 'hono';
import type { AppEnv } from '../../app.types';
import { handleException, HttpException } from '../../common/exceptions';
import { webhooksService } from './webhooks.service';

/** Cuerpo máximo aceptado (GitHub limita a 25 MB; un push normal pesa KB). */
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

/**
 * Mount path: /api/v1/webhooks — SIN Bearer auth (los proveedores no tienen la API key).
 *   POST /:provider/:integrationId   provider ∈ github|bitbucket|gitlab|jira|linear
 * Autenticidad = firma HMAC del proveedor con el secreto de la integración; el tenant sale de
 * IntLookup. Nunca se loguea el cuerpo ni el secreto.
 *   200 {ok, processed, kinds} · 200 {ok, ping} · 200 {ok, duplicate} · 202 {ok, ignored, reason}
 *   400 JSON inválido / proveedor no coincide · 401 firma · 404 integración · 413 cuerpo grande
 */
export const webhooksRouter = new Hono<AppEnv>();

webhooksRouter.post('/:provider/:integrationId', async (c) => {
  try {
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > MAX_WEBHOOK_BODY_BYTES) throw new HttpException(413, 'Payload demasiado grande', 'PAYLOAD_TOO_LARGE');
    // Cuerpo CRUDO: la firma se calcula sobre los bytes tal cual llegaron (no re-serializar).
    const raw = await c.req.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_WEBHOOK_BODY_BYTES) {
      throw new HttpException(413, 'Payload demasiado grande', 'PAYLOAD_TOO_LARGE');
    }
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(c.req.header())) headers[k.toLowerCase()] = v;

    const out = await webhooksService.handle({
      provider: c.req.param('provider'),
      integration_id: c.req.param('integrationId'),
      headers,
      raw_body: raw,
    });
    return c.json(out.body, out.status);
  } catch (err) {
    return handleException(err, c);
  }
});
