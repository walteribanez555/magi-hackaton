import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { KeyIdentity } from '@magicode/contracts';
import type { AppEnv } from '../../../app.types';
import { config } from '../../../config/config';
import { handleException } from '../../exceptions';
import { createAuthMiddleware, identityCache } from '../auth.middleware';
import { keyFingerprint } from '../../utils/hash';
import { MagiHubAuthError, MagiHubUnavailableError, type MagiHubClient } from '../../../modules/magihub/magihub.types';

process.env.LOG_LEVEL = 'error';
config.reload();

const GOOD = 'mh_demo_walter';
const who: KeyIdentity = { tenant_id: 'demo-tenant', key_id: 'key_abc', scopes: [] };

function setup() {
  let now = 1_000_000;
  const whoami = vi.fn(async (key: string) => {
    if (key === GOOD) return who;
    if (key === 'mh_down') throw new MagiHubUnavailableError('timeout');
    throw new MagiHubAuthError(401);
  });
  const client: MagiHubClient = { whoami, usage: vi.fn() };
  const app = new Hono<AppEnv>();
  app.onError((err, c) => handleException(err, c));
  app.use('*', createAuthMiddleware({ client: () => client, now: () => now }));
  app.get('/me', (c) =>
    c.json({ tenant: c.get('tenant_id'), key: c.get('key_id'), fp: c.get('key_fingerprint'), hasKey: c.get('apiKey') === GOOD }),
  );
  return { app, whoami, advance: (ms: number) => (now += ms) };
}

const auth = (k: string) => ({ headers: { authorization: `Bearer ${k}` } });

beforeEach(() => identityCache.clear());

describe('authMiddleware', () => {
  it('sin Authorization ⇒ 401 MISSING_API_KEY', async () => {
    const { app, whoami } = setup();
    const res = await app.request('/me');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ statusCode: 401, code: 'MISSING_API_KEY' });
    expect(whoami).not.toHaveBeenCalled();
  });

  it('esquema distinto de Bearer ⇒ 401', async () => {
    const { app } = setup();
    const res = await app.request('/me', { headers: { authorization: `Basic ${GOOD}` } });
    expect(res.status).toBe(401);
  });

  it('key inválida en MagiHub ⇒ 401 INVALID_API_KEY y no se cachea', async () => {
    const { app, whoami } = setup();
    const r1 = await app.request('/me', auth('mh_bad'));
    expect(r1.status).toBe(401);
    expect(await r1.json()).toMatchObject({ code: 'INVALID_API_KEY' });
    await app.request('/me', auth('mh_bad'));
    expect(whoami).toHaveBeenCalledTimes(2);
    expect(identityCache.size()).toBe(0);
  });

  it('MagiHub caído ⇒ 502', async () => {
    const { app } = setup();
    const res = await app.request('/me', auth('mh_down'));
    expect(res.status).toBe(502);
  });

  it('key válida ⇒ tenant/key_id/huella en contexto; la respuesta nunca contiene la key', async () => {
    const { app } = setup();
    const res = await app.request('/me', auth(GOOD));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ tenant: 'demo-tenant', key: 'key_abc', fp: keyFingerprint(GOOD), hasKey: true });
    expect(keyFingerprint(GOOD)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('caché de 5 min por key: no repite whoami hasta que expira', async () => {
    const { app, whoami, advance } = setup();
    await app.request('/me', auth(GOOD));
    await app.request('/me', auth(GOOD));
    expect(whoami).toHaveBeenCalledTimes(1);
    advance(4 * 60_000);
    await app.request('/me', auth(GOOD));
    expect(whoami).toHaveBeenCalledTimes(1);
    advance(2 * 60_000);
    await app.request('/me', auth(GOOD));
    expect(whoami).toHaveBeenCalledTimes(2);
  });
});
