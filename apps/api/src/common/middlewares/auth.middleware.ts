import { createMiddleware } from 'hono/factory';
import { config } from '../../config/config';
import { createLogger } from '../../config/logger';
import type { AppEnv, CallerIdentity } from '../../app.types';
import { getMagiHubClient } from '../../modules/magihub/magihub.client';
import { MagiHubAuthError, type MagiHubClient } from '../../modules/magihub/magihub.types';
import { keyFingerprint, sha256Hex } from '../utils/hash';
import { BadGatewayException, UnauthorizedException } from '../exceptions';

const logger = createLogger('Auth');

interface CacheEntry {
  identity: CallerIdentity;
  expiresAt: number;
}

/**
 * Caché en memoria (por contenedor Lambda) de identidades validadas. Se indexa por sha256 completo
 * de la key (la huella pública de 12 hex se deriva de él); nunca guarda la key.
 */
const cache = new Map<string, CacheEntry>();
const MAX_ENTRIES = 1000;

export const identityCache = {
  clear: () => cache.clear(),
  size: () => cache.size,
};

function readBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m?.[1] ?? null;
}

export interface AuthDeps {
  client?: () => MagiHubClient;
  now?: () => number;
}

/**
 * `Authorization: Bearer <MagiHub API key>` → MagiHub whoami → tenant_id/key_id/key_fingerprint en el
 * contexto. El tenant SIEMPRE sale de MagiHub; cualquier tenant_id del cuerpo se ignora.
 */
export const createAuthMiddleware = (deps: AuthDeps = {}) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const { demoOpenAccess, demoApiKey } = config.getValue('auth');
    let apiKey = readBearer(c.req.header('authorization'));
    // Modo demo: sin header, se usa la key de demo configurada (el dashboard entra sin login).
    if (!apiKey && demoOpenAccess && demoApiKey) {
      apiKey = demoApiKey;
      c.header('x-magicode-demo', 'true');
    }
    if (!apiKey) throw new UnauthorizedException('Falta Authorization: Bearer <MagiHub API key>', 'MISSING_API_KEY');

    const now = deps.now?.() ?? Date.now();
    const cacheKey = sha256Hex(apiKey);
    let identity = cache.get(cacheKey);
    if (!identity || identity.expiresAt <= now) {
      const client = (deps.client ?? getMagiHubClient)();
      try {
        const who = await client.whoami(apiKey);
        identity = {
          identity: { ...who, key_fingerprint: keyFingerprint(apiKey) },
          expiresAt: now + config.getValue('auth').cacheTtlSeconds * 1000,
        };
      } catch (err) {
        cache.delete(cacheKey);
        if (err instanceof MagiHubAuthError) {
          logger.info('API key rechazada por MagiHub', { key_fingerprint: keyFingerprint(apiKey) });
          throw new UnauthorizedException('API key inválida para MagiHub', 'INVALID_API_KEY');
        }
        throw new BadGatewayException('No se pudo validar la API key con MagiHub', 'MAGIHUB_UNAVAILABLE');
      }
      if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
      cache.set(cacheKey, identity);
    }

    const id = identity.identity;
    c.set('identity', id);
    c.set('tenant_id', id.tenant_id);
    c.set('key_id', id.key_id);
    c.set('key_fingerprint', id.key_fingerprint);
    c.set('apiKey', apiKey);
    const log = c.get('logger');
    if (log) c.set('logger', log.child({ tenant_id: id.tenant_id, key_fingerprint: id.key_fingerprint }));
    await next();
  });

export const authMiddleware = createAuthMiddleware();
