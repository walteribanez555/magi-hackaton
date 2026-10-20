import {
  REQUIRED_WEBHOOK_EVENTS,
  type GitProviderCredentials,
  type TaskProviderCredentials,
} from '@magicode/contracts';
import { ProviderError, requestJson, type HttpOptions } from '../task-sync/provider-http';
import type { HookInfo, ProviderDelivery } from './integration-health.types';

export interface HookSpec {
  url: string;
  secret: string;
  events: string[];
  /** jira: proyectos para el filtro JQL */
  task_project_keys?: string[];
}

/** API mínima de webhooks por proveedor (verificación, registro, ping, historial de entregas). */
export interface HookApi {
  /** credenciales válidas + permiso sobre el repo/sitio (lanza ProviderError 401/403/404) */
  verify(): Promise<void>;
  listHooks(): Promise<HookInfo[]>;
  createHook(spec: HookSpec): Promise<HookInfo>;
  updateHook(id: string, spec: HookSpec): Promise<HookInfo>;
  /** dispara una entrega de prueba (si el proveedor lo permite) */
  ping?(hookId: string): Promise<void>;
  /** últimas entregas según el proveedor (GitHub) — más reciente primero */
  deliveries?(hookId: string): Promise<ProviderDelivery[]>;
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();
export const findHook = (hooks: HookInfo[], url: string): HookInfo | null => hooks.find((h) => sameUrl(h.url, url)) ?? null;

async function call<T>(base: string, path: string, init: RequestInit & { headers: Record<string, string> }, http: HttpOptions, label: string): Promise<T | null> {
  const res = await requestJson<T>(`${base}${path}`, init, { ...http, label });
  return res.body;
}

const json = (headers: Record<string, string>, method: string, body?: unknown): RequestInit & { headers: Record<string, string> } => ({
  method,
  headers: { ...headers, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

// ── GitHub ─────────────────────────────────────────────────────────────────

interface GhHook {
  id: number;
  active: boolean;
  events: string[];
  config: { url?: string };
}

export class GitHubHooks implements HookApi {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  constructor(
    creds: Extract<GitProviderCredentials, { provider: 'github' }>,
    private readonly repository: string,
    private readonly http: HttpOptions = {},
  ) {
    this.base = (creds.api_url ?? 'https://api.github.com').replace(/\/+$/, '');
    this.headers = { Authorization: `Bearer ${creds.token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'magicode-integrations' };
  }
  private repo(path = '') {
    return `/repos/${this.repository}${path}`;
  }
  private toInfo = (h: GhHook): HookInfo => ({ id: String(h.id), url: h.config?.url ?? '', active: h.active, events: h.events ?? [] });

  async verify() {
    await call(this.base, this.repo(), json(this.headers, 'GET'), this.http, 'github GET repo');
    await this.listHooks(); // requiere "Webhooks: read"
  }
  async listHooks() {
    return ((await call<GhHook[]>(this.base, this.repo('/hooks?per_page=100'), json(this.headers, 'GET'), this.http, 'github GET hooks')) ?? []).map(this.toInfo);
  }
  private body(spec: HookSpec) {
    return { active: true, events: spec.events, config: { url: spec.url, content_type: 'json', secret: spec.secret, insecure_ssl: '0' } };
  }
  async createHook(spec: HookSpec) {
    const h = await call<GhHook>(this.base, this.repo('/hooks'), json(this.headers, 'POST', { name: 'web', ...this.body(spec) }), this.http, 'github POST hook');
    return this.toInfo(h!);
  }
  async updateHook(id: string, spec: HookSpec) {
    const h = await call<GhHook>(this.base, this.repo(`/hooks/${id}`), json(this.headers, 'PATCH', this.body(spec)), this.http, 'github PATCH hook');
    return this.toInfo(h!);
  }
  async ping(hookId: string) {
    await call(this.base, this.repo(`/hooks/${hookId}/pings`), json(this.headers, 'POST'), this.http, 'github POST ping');
  }
  async deliveries(hookId: string) {
    const list = (await call<Array<{ status_code: number; event: string; delivered_at: string }>>(
      this.base,
      this.repo(`/hooks/${hookId}/deliveries?per_page=10`),
      json(this.headers, 'GET'),
      this.http,
      'github GET deliveries',
    )) ?? [];
    return list.map((d) => ({ status_code: d.status_code, event: d.event, delivered_at: d.delivered_at }));
  }
}

// ── Bitbucket Cloud ────────────────────────────────────────────────────────

interface BbHook {
  uuid: string;
  url: string;
  active: boolean;
  events: string[];
}

export class BitbucketHooks implements HookApi {
  private readonly base = 'https://api.bitbucket.org/2.0';
  private readonly headers: Record<string, string>;
  constructor(
    creds: Extract<GitProviderCredentials, { provider: 'bitbucket' }>,
    private readonly repository: string,
    private readonly http: HttpOptions = {},
  ) {
    this.headers = { Authorization: `Basic ${Buffer.from(`${creds.username}:${creds.app_password}`).toString('base64')}` };
  }
  private toInfo = (h: BbHook): HookInfo => ({ id: h.uuid, url: h.url, active: h.active, events: h.events ?? [] });
  async verify() {
    await this.listHooks(); // requiere webhooks + repository:read
  }
  async listHooks() {
    const res = await call<{ values?: BbHook[] }>(this.base, `/repositories/${this.repository}/hooks?pagelen=100`, json(this.headers, 'GET'), this.http, 'bitbucket GET hooks');
    return (res?.values ?? []).map(this.toInfo);
  }
  private body(spec: HookSpec) {
    return { description: 'MagiCode', url: spec.url, active: true, events: spec.events, secret: spec.secret };
  }
  async createHook(spec: HookSpec) {
    return this.toInfo((await call<BbHook>(this.base, `/repositories/${this.repository}/hooks`, json(this.headers, 'POST', this.body(spec)), this.http, 'bitbucket POST hook'))!);
  }
  async updateHook(id: string, spec: HookSpec) {
    const path = `/repositories/${this.repository}/hooks/${encodeURIComponent(id)}`;
    return this.toInfo((await call<BbHook>(this.base, path, json(this.headers, 'PUT', this.body(spec)), this.http, 'bitbucket PUT hook'))!);
  }
}

// ── GitLab ─────────────────────────────────────────────────────────────────

type GlHook = { id: number; url: string; enable_ssl_verification?: boolean } & Record<string, unknown>;

export class GitLabHooks implements HookApi {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly project: string;
  constructor(
    creds: Extract<GitProviderCredentials, { provider: 'gitlab' }>,
    repository: string,
    private readonly http: HttpOptions = {},
  ) {
    const root = (creds.api_url ?? 'https://gitlab.com').replace(/\/+$/, '');
    this.base = /\/api\/v4$/.test(root) ? root : `${root}/api/v4`;
    this.headers = { 'PRIVATE-TOKEN': creds.token };
    this.project = encodeURIComponent(repository);
  }
  private toInfo = (h: GlHook): HookInfo => ({
    id: String(h.id),
    url: h.url,
    active: true,
    events: REQUIRED_WEBHOOK_EVENTS.gitlab.filter((flag) => h[flag] === true),
  });
  async verify() {
    await call(this.base, `/projects/${this.project}`, json(this.headers, 'GET'), this.http, 'gitlab GET project');
    await this.listHooks();
  }
  async listHooks() {
    return ((await call<GlHook[]>(this.base, `/projects/${this.project}/hooks`, json(this.headers, 'GET'), this.http, 'gitlab GET hooks')) ?? []).map(this.toInfo);
  }
  private body(spec: HookSpec) {
    return { url: spec.url, token: spec.secret, enable_ssl_verification: true, ...Object.fromEntries(REQUIRED_WEBHOOK_EVENTS.gitlab.map((f) => [f, true])) };
  }
  async createHook(spec: HookSpec) {
    return this.toInfo((await call<GlHook>(this.base, `/projects/${this.project}/hooks`, json(this.headers, 'POST', this.body(spec)), this.http, 'gitlab POST hook'))!);
  }
  async updateHook(id: string, spec: HookSpec) {
    return this.toInfo((await call<GlHook>(this.base, `/projects/${this.project}/hooks/${id}`, json(this.headers, 'PUT', this.body(spec)), this.http, 'gitlab PUT hook'))!);
  }
  async ping(hookId: string) {
    await call(this.base, `/projects/${this.project}/hooks/${hookId}/test/push_events`, json(this.headers, 'POST'), this.http, 'gitlab POST test');
  }
}

// ── Jira Cloud (webhooks de administrador) ─────────────────────────────────

interface JiraHook {
  self?: string;
  name?: string;
  url: string;
  enabled?: boolean;
  events?: string[];
}

export const jqlFor = (keys: string[] = []): string => (keys.length ? `project in (${keys.join(', ')})` : '');

export class JiraHooks implements HookApi {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  constructor(
    creds: Extract<TaskProviderCredentials, { provider: 'jira' }>,
    private readonly http: HttpOptions = {},
  ) {
    this.base = creds.site_url.replace(/\/+$/, '');
    this.headers = { Authorization: `Basic ${Buffer.from(`${creds.email}:${creds.api_token}`).toString('base64')}` };
  }
  private toInfo = (h: JiraHook): HookInfo => ({
    id: h.self?.split('/').pop() ?? '',
    url: h.url,
    active: h.enabled !== false,
    events: h.events ?? [],
  });
  async verify() {
    await call(this.base, '/rest/api/3/myself', json(this.headers, 'GET'), this.http, 'jira GET myself');
  }
  /** Requiere permiso de administrador de Jira (403 si no). */
  async listHooks() {
    return ((await call<JiraHook[]>(this.base, '/rest/webhooks/1.0/webhook', json(this.headers, 'GET'), this.http, 'jira GET webhooks')) ?? []).map(this.toInfo);
  }
  private body(spec: HookSpec) {
    return {
      name: 'MagiCode',
      url: spec.url,
      events: spec.events,
      filters: { 'issue-related-events-section': jqlFor(spec.task_project_keys) },
      excludeBody: false,
      secret: spec.secret,
    };
  }
  async createHook(spec: HookSpec) {
    return this.toInfo((await call<JiraHook>(this.base, '/rest/webhooks/1.0/webhook', json(this.headers, 'POST', this.body(spec)), this.http, 'jira POST webhook'))!);
  }
  async updateHook(id: string, spec: HookSpec) {
    return this.toInfo((await call<JiraHook>(this.base, `/rest/webhooks/1.0/webhook/${id}`, json(this.headers, 'PUT', this.body(spec)), this.http, 'jira PUT webhook'))!);
  }
  /** Prueba de ida y vuelta: agrega y quita la etiqueta de healthcheck (dispara 2 issue_updated). */
  async toggleHealthcheckLabel(issueKey: string, label: string) {
    const path = `/rest/api/3/issue/${encodeURIComponent(issueKey)}?notifyUsers=false`;
    await call(this.base, path, json(this.headers, 'PUT', { update: { labels: [{ add: label }] } }), this.http, 'jira PUT label add');
    await call(this.base, path, json(this.headers, 'PUT', { update: { labels: [{ remove: label }] } }), this.http, 'jira PUT label remove');
  }
}

/** Fábrica: credenciales + integración → API de hooks (null si el proveedor no lo soporta, p. ej. Linear). */
export function hookApiFor(
  creds: GitProviderCredentials | TaskProviderCredentials,
  integration: { repository?: string },
  http: HttpOptions = {},
): HookApi | null {
  switch (creds.provider) {
    case 'github':
      return integration.repository ? new GitHubHooks(creds, integration.repository, http) : null;
    case 'bitbucket':
      return integration.repository ? new BitbucketHooks(creds, integration.repository, http) : null;
    case 'gitlab':
      return integration.repository ? new GitLabHooks(creds, integration.repository, http) : null;
    case 'jira':
      return new JiraHooks(creds, http);
    default:
      return null;
  }
}

export { ProviderError };
