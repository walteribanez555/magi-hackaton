import { keys, WEBHOOK_SIGNATURE_HEADERS, type IntegrationProvider } from '@magicode/contracts';
import type { IntegrationsRepository } from '../../integrations/integrations.repository';
import type { IntegrationItem, IntLookupItem } from '../../integrations/integrations.types';
import { FakeCredentials } from '../../task-sync/__tests__/helpers';
import { FakeStore, fixtureRaw } from '../../webhooks/__tests__/helpers';
import { WebhookProjector } from '../../webhooks/webhooks.projection';
import { WebhooksService } from '../../webhooks/webhooks.service';
import { signBody } from '../../webhooks/webhooks.signature';
import { IntegrationHealthRepository } from '../integration-health.repository';
import { IntegrationHealthService } from '../integration-health.service';
import type { HookApi } from '../provider-hooks.client';

export const T = 'tenant_acme';
export const T0 = Date.parse('2026-10-20T20:00:00.000Z');
export const GH = 'int_0123456789abcdef';
export const JIRA = 'int_aaaaaaaaaaaaaaaa';
export const SECRET = 'c'.repeat(64);

/** Entorno completo en memoria: store + integraciones + salud + webhooks, con reloj controlable. */
export function harness() {
  const store = new FakeStore();
  let clock = T0;
  const now = () => new Date(clock);
  const creds = new FakeCredentials();
  const apis = new Map<string, HookApi & Record<string, unknown>>();

  const integrations = {
    async get(t: string, id: string) {
      return (store.getSync(keys.integration(t, id)) as IntegrationItem | undefined) ?? null;
    },
    async getLookup(id: string) {
      return (await store.get(keys.integrationLookup(id))) as IntLookupItem | null;
    },
    async listByTenant(t: string) {
      return store.all('INT#').filter((i) => i.PK === `T#${t}`) as unknown as IntegrationItem[];
    },
    async markDelivery(t: string, id: string, at: string) {
      await store.update(keys.integration(t, id), { set: { last_delivery_at: at, status: 'active' } });
      await store.update(keys.integrationLookup(id), { set: { status: 'active' } });
    },
  } as unknown as IntegrationsRepository;

  const health = new IntegrationHealthService({
    repo: new IntegrationHealthRepository(store.asRepo()),
    integrations,
    store: store.asRepo(),
    credentials: creds.asStore(),
    now,
    hookApi: (_c, integ) => apis.get(integ.integration_id) ?? null,
  });
  const webhooks = new WebhooksService({
    integrations,
    repo: store.asRepo(),
    projector: new WebhookProjector(store.asRepo()),
    fireTrigger: async () => {},
    health,
    now,
  });

  function addIntegration(o: Partial<IntLookupItem> & { integration_id: string; provider: IntegrationProvider; project_id?: string }) {
    const project = o.project_id ?? 'shop';
    const created = o.created_at ?? new Date(T0 - 30 * 86_400_000).toISOString();
    const status = o.status ?? 'active';
    const common = {
      integration_id: o.integration_id,
      tenant_id: T,
      key_id: 'key_A',
      project_id: project,
      provider: o.provider,
      ...(o.repository ? { repository: o.repository } : {}),
      ...(o.task_project_keys ? { task_project_keys: o.task_project_keys } : {}),
      status,
      created_at: created,
      updated_at: created,
    };
    store.put({ ...keys.integration(T, o.integration_id), entity: 'Integration', ...common, webhook_url: `https://api.example.com/api/v1/webhooks/${o.provider}/${o.integration_id}`, last_delivery_at: null, provenance: 'real' });
    store.put({ ...keys.integrationLookup(o.integration_id), entity: 'IntLookup', ...common, secret: SECRET, ...o, status });
  }

  function request(provider: IntegrationProvider, integration: string, body: string | Record<string, unknown>, event?: string, o: { delivery?: string; secret?: string } = {}) {
    const raw = typeof body === 'string' ? (body.endsWith('.json') ? fixtureRaw(body) : body) : JSON.stringify(body);
    const h = WEBHOOK_SIGNATURE_HEADERS[provider];
    return {
      provider,
      integration_id: integration,
      raw_body: raw,
      headers: {
        ...signBody(provider, raw, o.secret ?? SECRET),
        ...(event ? { [h.event]: event } : {}),
        [h.delivery]: o.delivery ?? `d-${Math.random()}`,
      } as Record<string, string | undefined>,
    };
  }

  return {
    store,
    creds,
    apis,
    health,
    webhooks,
    integrations,
    addIntegration,
    request,
    now,
    advance: (ms: number) => (clock += ms),
    lookup: (id: string) => store.getSync(keys.integrationLookup(id)) as unknown as IntLookupItem,
  };
}

/** HookApi falso: registra llamadas; `onPing` permite simular la entrega del ping. */
export function fakeHookApi(o: Partial<HookApi> & { hooks?: Array<{ id: string; url: string; active: boolean; events: string[] }>; [k: string]: unknown } = {}) {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  let hooks = o.hooks ?? [];
  const api: HookApi & Record<string, unknown> = {
    verify: o.verify ?? (async () => void calls.push({ fn: 'verify', args: [] })),
    listHooks: o.listHooks ?? (async () => (calls.push({ fn: 'listHooks', args: [] }), hooks)),
    createHook:
      o.createHook ??
      (async (spec) => {
        calls.push({ fn: 'createHook', args: [spec] });
        const h = { id: '901', url: spec.url, active: true, events: spec.events };
        hooks = [...hooks, h];
        return h;
      }),
    updateHook: o.updateHook ?? (async (id, spec) => (calls.push({ fn: 'updateHook', args: [id, spec] }), { id, url: spec.url, active: true, events: spec.events })),
    ...(o.ping ? { ping: o.ping } : {}),
    ...(o.deliveries ? { deliveries: o.deliveries } : {}),
    ...Object.fromEntries(Object.entries(o).filter(([k]) => !['verify', 'listHooks', 'createHook', 'updateHook', 'ping', 'deliveries', 'hooks'].includes(k))),
  };
  return { api, calls };
}
