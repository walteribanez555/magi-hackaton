import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UpdateSpec } from '../../../common/utils/dynamo-expr';
import type { IntegrationsRepository } from '../../integrations/integrations.repository';
import type { IntegrationItem, IntLookupItem } from '../../integrations/integrations.types';
import type { Item, Key, WebhooksRepository } from '../webhooks.repository';

export const fixture = <T = Record<string, unknown>>(name: string): T =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')) as T;

export const fixtureRaw = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

/**
 * Store en memoria con la MISMA semántica que WebhooksRepository: SET, if_not_exists, ADD de Sets
 * y un evaluador mínimo de condiciones (attribute_exists / attribute_not_exists / = / <> / <=, OR/AND).
 */
export class FakeStore {
  readonly items = new Map<string, Item>();
  deliveries = new Set<string>();
  failUpdatesMatching: RegExp | null = null;

  private k(key: Key) {
    return `${key.PK}|${key.SK}`;
  }

  put(item: Item) {
    this.items.set(this.k(item as Key), structuredClone(item));
  }

  getSync(key: Key): Item | undefined {
    return this.items.get(this.k(key));
  }

  all(prefixSk?: string): Item[] {
    return [...this.items.values()].filter((i) => !prefixSk || String(i.SK).startsWith(prefixSk));
  }

  async putDelivery(input: { tenant_id: string; delivery_key: string }): Promise<boolean> {
    const k = `${input.tenant_id}|${input.delivery_key}`;
    if (this.deliveries.has(k)) return false;
    this.deliveries.add(k);
    return true;
  }

  async deleteDelivery(tenantId: string, deliveryKey: string): Promise<void> {
    this.deliveries.delete(`${tenantId}|${deliveryKey}`);
  }

  async get(key: Key): Promise<Item | null> {
    const it = this.items.get(this.k(key));
    return it ? structuredClone(it) : null;
  }

  async batchGet<T = Item>(keys: Key[]): Promise<T[]> {
    return keys.map((k) => this.items.get(this.k(k))).filter(Boolean).map((i) => structuredClone(i)) as T[];
  }

  private evalCond(item: Item | undefined, expr: string, names: Record<string, string>, values: Record<string, unknown>): boolean {
    const resolve = (tok: string): unknown => {
      tok = tok.trim();
      if (tok.startsWith(':')) return values[tok];
      // rutas de documento: a.b / #n.#m
      return tok.split('.').reduce<unknown>((acc, part) => {
        const name = part.startsWith('#') ? names[part]! : part;
        return acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[name] : undefined;
      }, item);
    };
    return expr.split(/\s+OR\s+/).some((orPart) =>
      orPart
        .split(/\s+AND\s+/)
        .every((cond) => {
          const c = cond.trim();
          let m = /^attribute_exists\((.+)\)$/.exec(c);
          if (m) return item !== undefined && resolve(m[1]!) !== undefined;
          m = /^attribute_not_exists\((.+)\)$/.exec(c);
          if (m) return item === undefined || resolve(m[1]!) === undefined;
          m = /^(.+?)\s*(<>|<=|=)\s*(.+)$/.exec(c);
          if (!m) throw new Error(`condición no soportada: ${c}`);
          const a = resolve(m[1]!);
          const b = resolve(m[3]!);
          if (m[2] === '=') return a === b;
          if (m[2] === '<>') return a !== b;
          return a !== undefined && String(a) <= String(b);
        }),
    );
  }

  async update(
    key: Key,
    spec: UpdateSpec,
    condition?: { expression: string; names?: Record<string, string>; values?: Record<string, unknown> },
  ): Promise<boolean> {
    if (this.failUpdatesMatching?.test(key.SK)) throw Object.assign(new Error('boom'), { name: 'InternalServerError' });
    const cur = this.items.get(this.k(key));
    if (condition && !this.evalCond(cur, condition.expression, condition.names ?? {}, condition.values ?? {})) return false;
    const next: Item = cur ? structuredClone(cur) : { ...key };
    for (const [f, v] of Object.entries(spec.set ?? {})) if (v !== undefined) next[f] = structuredClone(v);
    for (const [f, v] of Object.entries(spec.setIfNotExists ?? {})) if (v !== undefined && next[f] === undefined) next[f] = structuredClone(v);
    for (const [f, v] of Object.entries(spec.add ?? {})) {
      if (v instanceof Set) {
        if (!v.size) continue;
        const prev = next[f];
        if (prev !== undefined && !(prev instanceof Set)) throw new Error(`ValidationException: ADD Set sobre ${typeof prev} en ${f}`);
        next[f] = new Set([...((prev as Set<string>) ?? []), ...v]);
      } else {
        next[f] = ((next[f] as number) ?? 0) + v;
      }
    }
    this.items.set(this.k(key), next);
    return true;
  }

  async queryPrefix<T = Item>(pk: string, skPrefix: string, opts: { index?: 'GSI1'; desc?: boolean } = {}): Promise<T[]> {
    const pkName = opts.index ? 'GSI1PK' : 'PK';
    const skName = opts.index ? 'GSI1SK' : 'SK';
    const rows = [...this.items.values()]
      .filter((i) => i[pkName] === pk && String(i[skName] ?? '').startsWith(skPrefix))
      .sort((a, b) => String(a[skName]).localeCompare(String(b[skName])));
    if (opts.desc) rows.reverse();
    return rows.map((r) => structuredClone(r)) as T[];
  }

  asRepo(): WebhooksRepository {
    return this as unknown as WebhooksRepository;
  }
}

export const SECRET = 'a'.repeat(64);
export const TENANT = 'tenant_acme';

export function lookupItem(o: Partial<IntLookupItem> = {}): IntLookupItem {
  return {
    PK: `INT#${o.integration_id ?? 'int_0123456789abcdef'}`,
    SK: 'META',
    entity: 'IntLookup',
    integration_id: 'int_0123456789abcdef',
    tenant_id: TENANT,
    key_id: 'key_1',
    project_id: 'shop',
    provider: 'github',
    repository: 'acme/shop',
    secret: SECRET,
    status: 'pending',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...o,
  };
}

/** IntegrationsRepository en memoria (lookups + filas Integration del tenant). */
export class FakeIntegrations {
  lookups = new Map<string, IntLookupItem>();
  integrations: IntegrationItem[] = [];
  deliveries: Array<{ tenant: string; id: string; at: string }> = [];

  add(l: IntLookupItem) {
    this.lookups.set(l.integration_id, l);
    this.integrations.push({
      PK: `T#${l.tenant_id}`,
      SK: `INT#${l.integration_id}`,
      entity: 'Integration',
      integration_id: l.integration_id,
      tenant_id: l.tenant_id,
      key_id: l.key_id,
      project_id: l.project_id,
      provider: l.provider,
      ...(l.repository ? { repository: l.repository } : {}),
      ...(l.task_project_keys ? { task_project_keys: l.task_project_keys } : {}),
      webhook_url: `https://api.test/api/v1/webhooks/${l.provider}/${l.integration_id}`,
      status: l.status,
      last_delivery_at: null,
      created_at: l.created_at,
      updated_at: l.updated_at,
      provenance: 'real',
    });
    return this;
  }

  async getLookup(id: string) {
    return this.lookups.get(id) ?? null;
  }
  async get(tenant: string, id: string) {
    return this.integrations.find((i) => i.tenant_id === tenant && i.integration_id === id) ?? null;
  }
  async listByTenant(tenant: string) {
    return this.integrations.filter((i) => i.tenant_id === tenant);
  }
  async markDelivery(tenant: string, id: string, at: string) {
    this.deliveries.push({ tenant, id, at });
    const l = this.lookups.get(id);
    if (l && l.status !== 'disabled') l.status = 'active';
  }

  asRepo(): IntegrationsRepository {
    return this as unknown as IntegrationsRepository;
  }
}
