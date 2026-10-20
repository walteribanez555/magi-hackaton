import type { TaskProviderCredentials } from '@magicode/contracts';
import type { CredentialsStore, ProviderCredentials } from '../credentials.store';
import { CLAIM_STALE_MS, type TaskSyncRepository } from '../task-sync.repository';
import type { AutomationRuleItem, OutboxItem } from '../task-sync.types';

/** TaskSyncRepository en memoria con la misma máquina de estados (claim condicional, finish desde sending). */
export class FakeTaskSyncRepo {
  outbox = new Map<string, OutboxItem>();
  idem = new Map<string, string>();
  rules: AutomationRuleItem[] = [];
  taskStatus: Array<{ task: string; status: string; category: string }> = [];
  credentials: Array<{ integration: string; service_account_id?: string; managed_field_ids: string[]; base_url?: string }> = [];

  private k(key: { PK: string; SK: string }) {
    return `${key.PK}|${key.SK}`;
  }

  async enqueue(item: OutboxItem) {
    const idemKey = `${item.tenant_id}|${item.idempotency_key}`;
    const existing = this.idem.get(idemKey);
    if (existing) return { item: structuredClone(this.outbox.get(existing)!), duplicate: true };
    this.idem.set(idemKey, this.k(item));
    this.outbox.set(this.k(item), structuredClone(item));
    return { item, duplicate: false };
  }
  async getOutbox(key: { PK: string; SK: string }) {
    const it = this.outbox.get(this.k(key));
    return it ? structuredClone(it) : null;
  }
  async listActions(tenant: string, task: string) {
    return [...this.outbox.values()].filter((o) => o.tenant_id === tenant && o.task_key === task).sort((a, b) => b.SK.localeCompare(a.SK));
  }
  async claim(item: OutboxItem, now: Date) {
    const cur = this.outbox.get(this.k(item));
    if (!cur) return null;
    const stale = cur.status === 'sending' && (cur.claimed_at ?? '') < new Date(now.getTime() - CLAIM_STALE_MS).toISOString();
    if (cur.status !== 'pending' && !stale) return null;
    Object.assign(cur, { status: 'sending', attempts: (cur.attempts ?? 0) + 1, claimed_at: now.toISOString(), updated_at: now.toISOString() });
    return structuredClone(cur);
  }
  async finish(item: OutboxItem, status: OutboxItem['status'], patch: { result?: Record<string, unknown> | null; last_error?: string | null }, now: Date) {
    const cur = this.outbox.get(this.k(item))!;
    if (cur.status !== 'sending') throw new Error('ConditionalCheckFailed');
    Object.assign(cur, { status, updated_at: now.toISOString(), GSI1PK: `T#${cur.tenant_id}#OUTBOX#${status}` });
    if (patch.result !== undefined) cur.result = patch.result;
    if (patch.last_error !== undefined) cur.last_error = patch.last_error;
    delete cur.claimed_at;
  }
  async setTaskStatus(_t: string, task: string, status: string, category: string) {
    this.taskStatus.push({ task, status, category });
  }
  async listRules(tenant: string, integration: string) {
    return this.rules.filter((r) => r.tenant_id === tenant && r.integration_id === integration).map((r) => structuredClone(r));
  }
  async getRule(tenant: string, integration: string, id: string) {
    return this.rules.find((r) => r.tenant_id === tenant && r.integration_id === integration && r.rule_id === id) ?? null;
  }
  async putRule(item: AutomationRuleItem, mustExist: boolean) {
    const i = this.rules.findIndex((r) => r.PK === item.PK && r.SK === item.SK);
    if (mustExist !== i >= 0) return false;
    if (i >= 0) this.rules[i] = item;
    else this.rules.push(item);
    return true;
  }
  async deleteRule(tenant: string, integration: string, id: string) {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => !(r.tenant_id === tenant && r.integration_id === integration && r.rule_id === id));
    return this.rules.length < before;
  }
  async markCredentials(_t: string, integration: string, input: { service_account_id?: string; managed_field_ids: string[]; base_url?: string }) {
    this.credentials.push({ integration, ...input });
  }

  asRepo(): TaskSyncRepository {
    return this as unknown as TaskSyncRepository;
  }
}

export class FakeCredentials {
  saved = new Map<string, ProviderCredentials>();
  async save(id: string, _t: string, c: ProviderCredentials) {
    this.saved.set(id, c);
  }
  async get(id: string) {
    return this.saved.get(id) ?? null;
  }
  asStore(): CredentialsStore {
    return this as unknown as CredentialsStore;
  }
}

export const JIRA_CREDS: Extract<TaskProviderCredentials, { provider: 'jira' }> = {
  provider: 'jira',
  site_url: 'https://example.atlassian.net',
  email: 'bot@example.com',
  api_token: 'fake-token-not-real-123',
  field_ids: { magicode_tokens: 'customfield_10100', magicode_criticality: 'customfield_10102' },
};

type Route = { method: string; path: RegExp; status?: number; body?: unknown; headers?: Record<string, string> };

/** fetch simulado: responde por (método, ruta) en orden; registra todas las llamadas. */
export function mockFetch(routes: Route[]) {
  const calls: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }> = [];
  const queue = [...routes];
  const fetch = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = new URL(url).pathname + new URL(url).search;
    calls.push({
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const i = queue.findIndex((r) => r.method === method && r.path.test(path));
    if (i < 0) return new Response(JSON.stringify({ errorMessages: [`no route ${method} ${path}`] }), { status: 404 });
    const r = queue.splice(i, 1)[0]!;
    // la ruta se re-encola si es la última para ese patrón (respuestas repetibles)
    if (!queue.some((q) => q.method === r.method && String(q.path) === String(r.path)) && r.status === undefined) queue.push(r);
    const status = r.status ?? 200;
    return new Response(r.body === undefined || status === 204 ? null : JSON.stringify(r.body), { status, headers: r.headers });
  };
  return { fetch, calls };
}
