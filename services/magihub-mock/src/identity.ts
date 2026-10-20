import { createHash } from 'node:crypto';
import { SMART_AUTO_MODEL, type KeyIdentity } from '@magicode/contracts';

/**
 * SIMULADO: cualquier key que empiece con `mh_demo_` es válida para el tenant "demo-tenant".
 * key_id = "key_" + sha256(key)[:8] (estable por key, sin guardar la key).
 */
export const DEMO_PREFIX = 'mh_demo_';

export function readBearer(header: string | undefined): string | null {
  const m = header ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  return m?.[1] ?? null;
}

export function identityOf(apiKey: string | null): KeyIdentity | null {
  if (!apiKey || !apiKey.startsWith(DEMO_PREFIX) || apiKey.length < DEMO_PREFIX.length + 1) return null;
  const hash = createHash('sha256').update(apiKey).digest('hex');
  return {
    tenant_id: 'demo-tenant',
    key_id: `key_${hash.slice(0, 8)}`,
    key_name: `demo ${apiKey.slice(DEMO_PREFIX.length)} (simulado)`,
    scopes: ['chat:write', 'usage:read'],
    governance: { allowed_models: [SMART_AUTO_MODEL], monthly_token_limit: 5_000_000 },
  };
}
