import { randomBytes } from 'node:crypto';
import {
  GitProvider,
  IntegrationTestRequest,
  keys,
  REQUIRED_WEBHOOK_EVENTS,
  TaskProvider,
  type CheckResult,
  type HealthStatus,
  type IntegrationHealth,
  type IntegrationTestRun,
  type ProjectReadiness,
  type RegisterWebhookResult,
  type RepositoryApiKey,
  type RepositoryOption,
  type RepositoryReadiness,
} from '@magicode/contracts';
import { createLogger } from '../../config/logger';
import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnprocessableException,
} from '../../common/exceptions';
import { asArray } from '../branches/branches.service';
import { integrationsRepository, type IntegrationsRepository } from '../integrations/integrations.repository';
import type { IntegrationItem, IntLookupItem } from '../integrations/integrations.types';
import { credentialsStore, type CredentialsStore, type ProviderCredentials } from '../task-sync/credentials.store';
import { ProviderError, type HttpOptions } from '../task-sync/provider-http';
import { webhooksRepository, type Item, type WebhooksRepository } from '../webhooks/webhooks.repository';
import {
  deliveries24h,
  localChecks,
  mk,
  providerName,
  providerPlaceholders,
  rollup,
  sortChecks,
} from './integration-health.checks';
import { integrationHealthRepository, TEST_TTL_SECONDS, type IntegrationHealthRepository } from './integration-health.repository';
import type {
  DeliveryOutcome,
  IntHealthItem,
  LocalHealthInput,
  PendingTest,
  Role,
  TestExpectation,
  TestRunItem,
} from './integration-health.types';
import { HEALTHCHECK_LABEL } from '../webhooks/adapters/jira.adapter';
import { findHook, hookApiFor, jqlFor, JiraHooks, type HookApi } from './provider-hooks.client';

export { HEALTHCHECK_LABEL };

const logger = createLogger('IntegrationHealth');

const DAY_MS = 86_400_000;
export const AUTO_TIMEOUT_MS = 60_000;
export const MANUAL_TIMEOUT_MS = 15 * 60_000;
const WAIT_STEPS = ['Evento recibido', 'Firma válida', 'Procesado'] as const;

const isGit = (p: string) => GitProvider.safeParse(p).success;
const isTask = (p: string) => TaskProvider.safeParse(p).success;
export const roleOf = (provider: string): Role => (isGit(provider) ? 'repository' : 'tasks');
const sameRepo = (a?: string | null, b?: string | null) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

const SEVERITY: Record<HealthStatus, number> = { failing: 6, not_configured: 5, disabled: 4, awaiting_first_delivery: 3, degraded: 2, healthy: 1 };
export const worstStatus = (a: HealthStatus, b: HealthStatus): HealthStatus => (SEVERITY[a] >= SEVERITY[b] ? a : b);
const BLOCKING: HealthStatus[] = ['not_configured', 'awaiting_first_delivery', 'failing', 'disabled'];
export const isBlocking = (s: HealthStatus) => BLOCKING.includes(s);

const MANUAL_INSTRUCTIONS: Record<string, string> = {
  github: 'En GitHub: Settings → Webhooks → (webhook de MagiCode) → Recent Deliveries → Redeliver, o haz un push. La prueba pasa con la próxima entrega firmada.',
  bitbucket: 'En Bitbucket: Repository settings → Webhooks → View requests → Resend, o haz un push. La prueba pasa con la próxima entrega firmada.',
  gitlab: 'En GitLab: Settings → Webhooks → Test → Push events. La prueba pasa con la próxima entrega firmada.',
  jira: 'Edita cualquier issue del proyecto (por ejemplo, agrega una etiqueta). La prueba pasa con la próxima entrega firmada.',
  linear: 'Edita cualquier issue del equipo en Linear. La prueba pasa con la próxima entrega firmada.',
};

/** Lo que el webhook informa de cada entrega con firma válida (para completar pruebas pendientes). */
export interface DeliverySignal {
  at: string;
  event?: string;
  ping: boolean;
  kinds: string[];
  jira_test: boolean;
}

export function matchesExpectation(expect: TestExpectation, d: DeliverySignal): boolean {
  switch (expect) {
    case 'any':
      return true;
    case 'ping':
      return d.ping;
    case 'push':
      return d.kinds.includes('repo.push');
    case 'jira_label':
      return d.jira_test;
  }
}

export function notConfigured(role: Role, now: string): IntegrationHealth {
  return {
    integration_id: null,
    role,
    provider: null,
    status: 'not_configured',
    checks: [
      mk(
        'integration_exists',
        'fail',
        role === 'repository'
          ? 'Falta la integración del repositorio (GitHub, Bitbucket o GitLab) con su webhook.'
          : 'Falta la integración del gestor de tareas (Jira o Linear) con su webhook.',
        now,
        'create_integration',
      ),
    ],
    deliveries_24h: { accepted: 0, duplicate: 0, ignored: 0, rejected_signature: 0, rejected_other: 0 },
    last_event_at: {},
    last_delivery_at: null,
    last_error: null,
    last_test: null,
    can_auto_register: false,
  };
}

const publicRun = (r: TestRunItem): IntegrationTestRun => ({
  test_id: r.test_id,
  integration_id: r.integration_id,
  mode: r.mode,
  status: r.status,
  steps: r.steps,
  instructions: r.instructions ?? null,
  started_at: r.started_at,
  finished_at: r.finished_at ?? null,
  latency_ms: r.latency_ms ?? null,
});

export interface HealthDeps {
  repo?: IntegrationHealthRepository;
  integrations?: IntegrationsRepository;
  store?: WebhooksRepository;
  credentials?: CredentialsStore;
  http?: HttpOptions;
  now?: () => Date;
  hookApi?: (creds: ProviderCredentials, integ: IntegrationItem) => HookApi | null;
}

interface RepoContext {
  sessions: Item[];
}

export class IntegrationHealthService {
  private readonly repo: IntegrationHealthRepository;
  private readonly integrations: IntegrationsRepository;
  private readonly store: WebhooksRepository;
  private readonly credentials: CredentialsStore;
  private readonly now: () => Date;
  private readonly hookApi: (creds: ProviderCredentials, integ: IntegrationItem) => HookApi | null;

  constructor(deps: HealthDeps = {}) {
    this.repo = deps.repo ?? integrationHealthRepository;
    this.integrations = deps.integrations ?? integrationsRepository;
    this.store = deps.store ?? webhooksRepository;
    this.credentials = deps.credentials ?? credentialsStore;
    this.now = deps.now ?? (() => new Date());
    this.hookApi = deps.hookApi ?? ((creds, integ) => hookApiFor(creds, integ, deps.http ?? {}));
  }

  private iso() {
    return this.now().toISOString();
  }

  // ── contabilidad de entregas (lo llama el webhook; nunca lanza) ───────────

  async recordDelivery(lookup: Pick<IntLookupItem, 'tenant_id' | 'integration_id'>, outcome: DeliveryOutcome, info: { at: string; event?: string; error?: string }) {
    try {
      await this.repo.recordDelivery({ tenant_id: lookup.tenant_id, integration_id: lookup.integration_id, outcome, ...info });
    } catch (err) {
      logger.warn('No se pudo registrar la entrega', { integration_id: lookup.integration_id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Entrega con firma válida: si hay una prueba pendiente que encaja, se marca como superada. */
  async onValidDelivery(lookup: IntLookupItem, signal: DeliverySignal): Promise<boolean> {
    const p = lookup.pending_test;
    if (!p || signal.at > p.deadline_at || !matchesExpectation(p.expect, signal)) return false;
    try {
      const run = await this.repo.getTest(lookup.tenant_id, lookup.integration_id, p.sk);
      if (!run || run.status !== 'pending') {
        await this.repo.clearPendingTest(lookup.integration_id, p.test_id);
        return false;
      }
      const msgs: Record<string, string> = {
        'Evento recibido': `Evento ${signal.event ?? (signal.ping ? 'ping' : 'recibido')}`,
        'Firma válida': 'HMAC verificada con el secreto de la integración',
        Procesado: 'OK',
      };
      const steps = run.steps.map((s) => ((WAIT_STEPS as readonly string[]).includes(s.name) ? { ...s, status: 'pass' as const, at: signal.at, message: msgs[s.name] ?? null } : s));
      const from = Date.parse(run.triggered_at ?? run.started_at);
      const latency = Math.max(0, Date.parse(signal.at) - from);
      await this.repo.updateTest({ PK: run.PK, SK: run.SK }, { status: 'passed', steps, finished_at: signal.at, latency_ms: latency });
      await this.repo.clearPendingTest(lookup.integration_id, p.test_id);
      await this.repo.setLastTest(lookup.tenant_id, lookup.integration_id, { test_id: run.test_id, status: 'passed', finished_at: signal.at }, signal.at);
      logger.info('Prueba de ida y vuelta superada', { integration_id: lookup.integration_id, test_id: run.test_id, latency_ms: latency });
      return true;
    } catch (err) {
      logger.warn('No se pudo completar la prueba', { integration_id: lookup.integration_id, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  /** Firma inválida mientras hay una prueba pendiente ⇒ la prueba falla con un diagnóstico claro. */
  async onInvalidSignature(lookup: IntLookupItem, at: string): Promise<void> {
    const p = lookup.pending_test;
    if (!p || at > p.deadline_at) return;
    try {
      const run = await this.repo.getTest(lookup.tenant_id, lookup.integration_id, p.sk);
      if (!run || run.status !== 'pending') return;
      const steps = run.steps.map((s) => {
        if (s.name === 'Evento recibido') return { ...s, status: 'pass' as const, at, message: 'Llegó una entrega' };
        if (s.name === 'Firma válida') {
          return { ...s, status: 'fail' as const, at, message: 'Firma inválida: el secreto configurado en el proveedor no coincide con el de MagiCode (rota el secreto y actualízalo)' };
        }
        if (s.name === 'Procesado') return { ...s, status: 'skipped' as const, at, message: null };
        return s;
      });
      await this.repo.updateTest({ PK: run.PK, SK: run.SK }, { status: 'failed', steps, finished_at: at });
      await this.repo.clearPendingTest(lookup.integration_id, p.test_id);
      await this.repo.setLastTest(lookup.tenant_id, lookup.integration_id, { test_id: run.test_id, status: 'failed', finished_at: at }, at);
    } catch (err) {
      logger.warn('No se pudo marcar la prueba fallida', { integration_id: lookup.integration_id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── pruebas ───────────────────────────────────────────────────────────────

  /** Timeout perezoso: se evalúa al leer. */
  private async withTimeout(run: TestRunItem | null): Promise<TestRunItem | null> {
    if (!run || run.status !== 'pending') return run;
    const now = this.iso();
    if (now <= run.deadline_at) return run;
    const secs = Math.round((Date.parse(run.deadline_at) - Date.parse(run.started_at)) / 1000);
    const steps = run.steps.map((s) => (s.status === 'pending' ? { ...s, status: 'fail' as const, at: now, message: `No llegó ningún evento en ${secs} s` } : s));
    const updated: TestRunItem = { ...run, status: 'timeout', steps, finished_at: now };
    await this.repo.updateTest({ PK: run.PK, SK: run.SK }, { status: 'timeout', steps, finished_at: now });
    await this.repo.clearPendingTest(run.integration_id, run.test_id);
    await this.repo.setLastTest(run.tenant_id, run.integration_id, { test_id: run.test_id, status: 'timeout', finished_at: now }, now);
    return updated;
  }

  private async ownIntegration(t: string, id: string): Promise<{ integ: IntegrationItem; lookup: IntLookupItem }> {
    const integ = await this.integrations.get(t, id);
    const lookup = integ ? await this.integrations.getLookup(id) : null;
    if (!integ || !lookup || lookup.tenant_id !== t) throw new NotFoundException('Integración no encontrada', 'INTEGRATION_NOT_FOUND');
    return { integ, lookup };
  }

  private async credsFor(lookup: IntLookupItem): Promise<ProviderCredentials | null> {
    return lookup.credentials_configured_at ? this.credentials.get(lookup.integration_id) : null;
  }

  /** POST /integrations/:id/test */
  async startTest(t: string, id: string, body: unknown): Promise<IntegrationTestRun> {
    const req = IntegrationTestRequest.parse(body ?? {});
    const { integ, lookup } = await this.ownIntegration(t, id);
    if (integ.status === 'disabled') throw new NotFoundException('Integración deshabilitada', 'INTEGRATION_DISABLED');
    const provider = integ.provider;
    if (req.mode === 'auto' && provider === 'jira' && !req.test_issue_key) {
      throw new BadRequestException('test_issue_key es obligatorio para la prueba automática de Jira (p. ej. "MAG-1")', 'TEST_ISSUE_REQUIRED');
    }
    const creds = req.mode === 'auto' ? await this.credsFor(lookup) : null;
    const api = creds ? this.hookApi(creds, integ) : null;
    const autoKind: 'ping' | 'push' | 'jira_label' | 'api_only' | null =
      !api ? null : provider === 'github' ? 'ping' : provider === 'gitlab' ? 'push' : provider === 'jira' ? 'jira_label' : provider === 'bitbucket' ? 'api_only' : null;
    const mode = autoKind ? 'auto' : 'manual';

    const at = this.now();
    const startedAt = at.toISOString();
    const testId = `test_${randomBytes(6).toString('hex')}`;
    const key = keys.integrationTestRun(t, id, startedAt, testId);
    const triggerName =
      autoKind === 'ping' ? 'Ping enviado al proveedor' : autoKind === 'push' ? 'Push de prueba enviado' : autoKind === 'jira_label' ? `Etiqueta ${HEALTHCHECK_LABEL} agregada y quitada en ${req.test_issue_key}` : null;
    const pendingStep = (name: string) => ({ name, status: 'pending' as const, at: null, message: null });

    const run: TestRunItem = {
      ...key,
      entity: 'IntTestRun',
      tenant_id: t,
      test_id: testId,
      integration_id: id,
      mode,
      status: 'pending',
      steps: [...(triggerName ? [pendingStep(triggerName)] : []), ...WAIT_STEPS.map(pendingStep)],
      instructions: mode === 'manual' ? (MANUAL_INSTRUCTIONS[provider] ?? null) : null,
      started_at: startedAt,
      finished_at: null,
      latency_ms: null,
      expect: autoKind === 'ping' || autoKind === 'push' || autoKind === 'jira_label' ? autoKind : 'any',
      deadline_at: new Date(at.getTime() + (mode === 'auto' ? AUTO_TIMEOUT_MS : MANUAL_TIMEOUT_MS)).toISOString(),
      triggered_at: mode === 'manual' ? startedAt : null,
      expires_at: Math.floor(at.getTime() / 1000) + TEST_TTL_SECONDS,
    };

    // Bitbucket no tiene ping: verificación vía API + último evento recibido (resultado inmediato)
    if (autoKind === 'api_only') {
      const health = await this.repo.getHealth(t, id);
      let hookOk = false;
      let hookMsg = '';
      try {
        const hooks = await api!.listHooks();
        const hook = hooks.find((h) => h.id === lookup.provider_hook_id) ?? findHook(hooks, integ.webhook_url);
        hookOk = !!hook && hook.active;
        hookMsg = hook ? (hook.active ? `Webhook ${hook.id} activo` : 'El webhook existe pero está desactivado') : 'No hay webhook con la URL de MagiCode';
      } catch (err) {
        hookMsg = err instanceof Error ? err.message : String(err);
      }
      const recent = !!health?.last_valid_delivery_at && Date.parse(startedAt) - Date.parse(health.last_valid_delivery_at) <= 7 * DAY_MS;
      run.steps = [
        { name: 'Webhook verificado vía API', status: hookOk ? 'pass' : 'fail', at: startedAt, message: hookMsg },
        { name: 'Último evento recibido', status: recent ? 'pass' : 'fail', at: startedAt, message: recent ? `Último evento válido: ${health!.last_valid_delivery_at}` : 'Sin eventos válidos en 7 días: haz un push o reenvía una entrega' },
      ];
      run.status = hookOk && recent ? 'passed' : 'failed';
      run.finished_at = startedAt;
      await this.repo.putTest(run);
      await this.repo.setLastTest(t, id, { test_id: testId, status: run.status, finished_at: startedAt }, startedAt);
      return publicRun(run);
    }

    // Se persiste ANTES de disparar: el ping puede llegar en milisegundos.
    await this.repo.putTest(run);
    const pending: PendingTest = { test_id: testId, sk: key.SK, expect: run.expect, triggered_at: startedAt, deadline_at: run.deadline_at };
    await this.repo.setPendingTest(id, pending);
    await this.repo.setLastTest(t, id, { test_id: testId, status: 'pending', finished_at: null }, startedAt);

    if (mode === 'auto') {
      const triggeredAt = this.iso();
      try {
        if (autoKind === 'ping' || autoKind === 'push') {
          const hookId = lookup.provider_hook_id ?? findHook(await api!.listHooks(), integ.webhook_url)?.id;
          if (!hookId) throw new ProviderError('No hay webhook con la URL de MagiCode en el proveedor: regístralo primero', 404, false);
          await api!.ping!(hookId);
        } else if (autoKind === 'jira_label') {
          await (api as JiraHooks).toggleHealthcheckLabel(req.test_issue_key!, HEALTHCHECK_LABEL);
        }
        run.steps[0] = { ...run.steps[0]!, status: 'pass', at: this.iso(), message: null };
        run.triggered_at = triggeredAt;
        // la entrega pudo llegar mientras disparábamos: solo se actualiza el paso de disparo
        await this.repo.updateTest(key, { triggered_at: triggeredAt, steps: await this.mergeTriggerStep(t, id, key.SK, run.steps[0]!) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        run.steps = run.steps.map((s, i) => (i === 0 ? { ...s, status: 'fail', at: this.iso(), message } : { ...s, status: 'skipped' }));
        run.status = 'failed';
        run.finished_at = this.iso();
        await this.repo.updateTest(key, { status: 'failed', steps: run.steps, finished_at: run.finished_at });
        await this.repo.clearPendingTest(id, testId);
        await this.repo.setLastTest(t, id, { test_id: testId, status: 'failed', finished_at: run.finished_at }, run.finished_at);
        return publicRun(run);
      }
    }
    const current = await this.repo.getTest(t, id, key.SK);
    return publicRun(current ?? run);
  }

  private async mergeTriggerStep(t: string, id: string, sk: string, step: TestRunItem['steps'][number]) {
    const cur = await this.repo.getTest(t, id, sk);
    const steps = cur?.steps ?? [];
    return steps.map((s, i) => (i === 0 ? step : s));
  }

  /** GET /integrations/:id/tests/:testId */
  async getTest(t: string, id: string, testId: string): Promise<IntegrationTestRun> {
    await this.ownIntegration(t, id);
    const run = (await this.repo.tests(t, id, 50)).find((r) => r.test_id === testId) ?? null;
    if (!run) throw new NotFoundException('Prueba no encontrada', 'TEST_NOT_FOUND');
    return publicRun((await this.withTimeout(run))!);
  }

  // ── registro del webhook en el proveedor ──────────────────────────────────

  /** POST /integrations/:id/register-webhook */
  async registerWebhook(t: string, id: string): Promise<RegisterWebhookResult> {
    const { integ, lookup } = await this.ownIntegration(t, id);
    if (integ.status === 'disabled') throw new NotFoundException('Integración deshabilitada', 'INTEGRATION_DISABLED');
    const events = REQUIRED_WEBHOOK_EVENTS[integ.provider];
    const manual = {
      url: integ.webhook_url,
      events: events.join(', '),
      ...(integ.provider === 'jira' ? { jql: jqlFor(integ.task_project_keys) } : {}),
    };
    const creds = await this.credsFor(lookup);
    if (!creds) {
      throw new UnprocessableException('Agrega credenciales del proveedor para registrar el webhook automáticamente, o créalo a mano.', 'CREDENTIALS_MISSING', manual);
    }
    const api = this.hookApi(creds, integ);
    if (!api) {
      throw new BadRequestException(`${providerName(integ.provider)} no permite registrar el webhook desde MagiCode: créalo manualmente con esta URL y eventos.`, 'MANUAL_REGISTRATION', manual);
    }
    const spec = { url: integ.webhook_url, secret: lookup.secret, events, task_project_keys: integ.task_project_keys };
    try {
      const hooks = await api.listHooks();
      const existing = hooks.find((h) => h.id && h.id === lookup.provider_hook_id) ?? findHook(hooks, integ.webhook_url);
      const hook = existing ? await api.updateHook(existing.id, spec) : await api.createHook(spec);
      const hookId = hook.id || existing?.id || '';
      if (hookId) await this.repo.setProviderHookId(id, hookId, this.iso());
      logger.info('Webhook registrado en el proveedor', { tenant_id: t, integration_id: id, provider: integ.provider, created: !existing });
      return { provider_hook_id: hookId, created: !existing, events };
    } catch (err) {
      if (err instanceof ProviderError && err.status === 403) {
        throw new ForbiddenException(
          integ.provider === 'jira'
            ? 'Jira requiere permisos de administrador para crear webhooks. Créalo a mano en Configuración → Sistema → WebHooks con esta URL, los eventos indicados, el filtro JQL y el secreto que se mostró al crear la integración (o rótalo).'
            : `Las credenciales no tienen permiso para administrar webhooks en ${providerName(integ.provider)}. Créalo a mano con esta URL, los eventos indicados y el secreto de la integración.`,
          'PROVIDER_FORBIDDEN',
          manual,
        );
      }
      if (err instanceof ProviderError && err.status === 401) throw new UnprocessableException('El proveedor rechazó las credenciales', 'CREDENTIALS_REJECTED');
      if (err instanceof ProviderError) throw new BadGatewayException(err.message, 'PROVIDER_ERROR');
      throw err;
    }
  }

  // ── salud ─────────────────────────────────────────────────────────────────

  /** Checks contra la API del proveedor (solo con refresh=true y credenciales). */
  private async providerChecks(integ: IntegrationItem, lookup: IntLookupItem, role: Role, now: string): Promise<CheckResult[]> {
    const p = providerName(integ.provider);
    const creds = await this.credsFor(lookup);
    const base: LocalHealthInput = {
      now, role, provider: integ.provider, status: integ.status, health: null,
      deliveries_24h: { accepted: 0, duplicate: 0, ignored: 0, rejected_signature: 0, rejected_other: 0 },
      last_test: null, has_credentials: !!creds,
    };
    if (!creds) return providerPlaceholders(base);
    const api = this.hookApi(creds, integ);
    if (!api) {
      return (['credentials_valid', 'webhook_registered', 'webhook_events'] as const).map((id) =>
        mk(id, 'skipped', `${p} no expone sus webhooks por API: verifica la configuración en el proveedor.`, now, 'open_provider_settings'),
      );
    }
    const out: CheckResult[] = [];
    try {
      await api.verify();
      out.push(mk('credentials_valid', 'pass', `Credenciales de ${p} válidas.`, now));
    } catch (err) {
      const status = err instanceof ProviderError ? err.status : null;
      out.push(
        mk('credentials_valid', 'fail', status === 401 || status === 403 ? `${p} rechazó las credenciales (HTTP ${status}). Genera un token nuevo con permisos de webhooks.` : `No se pudo verificar con ${p}: ${err instanceof Error ? err.message : err}`, now, 'add_credentials'),
        mk('webhook_registered', 'skipped', 'Requiere credenciales válidas.', now, 'add_credentials'),
        mk('webhook_events', 'skipped', 'Requiere credenciales válidas.', now, 'add_credentials'),
      );
      if (role === 'repository') out.push(mk('provider_last_response', 'skipped', 'Requiere credenciales válidas.', now, 'add_credentials'));
      return out;
    }
    let hooks;
    try {
      hooks = await api.listHooks();
    } catch (err) {
      const forbidden = err instanceof ProviderError && err.status === 403;
      out.push(
        mk('webhook_registered', 'warn', forbidden ? `Sin permiso para listar webhooks en ${p}${integ.provider === 'jira' ? ' (requiere administrador de Jira)' : ''}: verifícalo manualmente.` : `No se pudo listar los webhooks: ${err instanceof Error ? err.message : err}`, now, 'open_provider_settings'),
        mk('webhook_events', 'skipped', 'No se pudo leer el webhook.', now),
      );
      if (role === 'repository') out.push(mk('provider_last_response', 'skipped', 'No se pudo leer el webhook.', now));
      return out;
    }
    const hook = hooks.find((h) => h.id && h.id === lookup.provider_hook_id) ?? findHook(hooks, integ.webhook_url);
    if (!hook) {
      out.push(
        mk('webhook_registered', 'fail', `${p} no tiene ningún webhook apuntando a ${integ.webhook_url}. Regístralo (botón) o créalo a mano.`, now, 'register_webhook'),
        mk('webhook_events', 'skipped', 'No hay webhook registrado.', now, 'register_webhook'),
      );
      if (role === 'repository') out.push(mk('provider_last_response', 'skipped', 'No hay webhook registrado.', now, 'register_webhook'));
      return out;
    }
    if (hook.id && hook.id !== lookup.provider_hook_id) await this.repo.setProviderHookId(lookup.integration_id, hook.id, now);
    out.push(
      hook.active
        ? mk('webhook_registered', 'pass', `Webhook ${hook.id} registrado y activo en ${p}.`, now, null, { hook_id: hook.id })
        : mk('webhook_registered', 'fail', `El webhook ${hook.id} existe en ${p} pero está desactivado: actívalo.`, now, 'open_provider_settings', { hook_id: hook.id }),
    );
    const required = REQUIRED_WEBHOOK_EVENTS[integ.provider];
    const missing = hook.events.includes('*') ? [] : required.filter((e) => !hook.events.includes(e));
    out.push(
      missing.length
        ? mk('webhook_events', 'warn', `Faltan eventos en el webhook: ${missing.join(', ')}. Vuelve a registrarlo para suscribirlos.`, now, 'register_webhook', { missing: missing.join(',') })
        : mk('webhook_events', 'pass', 'Suscrito a todos los eventos requeridos.', now),
    );
    if (role === 'repository') {
      if (!api.deliveries) {
        out.push(mk('provider_last_response', 'skipped', `${p} no expone el historial de entregas por API.`, now));
      } else {
        try {
          const last = (await api.deliveries(hook.id))[0];
          out.push(
            !last
              ? mk('provider_last_response', 'skipped', `${p} aún no registra entregas para este webhook.`, now, 'run_test')
              : last.status_code >= 400 || last.status_code === 0
                ? mk('provider_last_response', 'fail', `${p} reporta que nuestra última respuesta fue HTTP ${last.status_code} (evento ${last.event}, ${last.delivered_at}). Revisa el secreto y la URL del webhook.`, now, 'run_test', { status_code: last.status_code, event: last.event })
                : mk('provider_last_response', 'pass', `${p} reporta HTTP ${last.status_code} en la última entrega (${last.event}).`, now, null, { status_code: last.status_code }),
          );
        } catch (err) {
          out.push(mk('provider_last_response', 'warn', `No se pudo leer el historial de entregas: ${err instanceof Error ? err.message : err}`, now));
        }
      }
    }
    return out;
  }

  private async latestTest(t: string, id: string): Promise<TestRunItem | null> {
    return this.withTimeout((await this.repo.tests(t, id, 1))[0] ?? null);
  }

  /** Salud de una integración concreta. `ctx.sessions` = sesiones del proyecto ya cargadas (readiness). */
  async healthOf(t: string, integ: IntegrationItem, opts: { refresh?: boolean; ctx?: RepoContext } = {}): Promise<IntegrationHealth> {
    const now = this.iso();
    const role = roleOf(integ.provider);
    const lookup = await this.integrations.getLookup(integ.integration_id);
    const [health, buckets, lastTest] = await Promise.all([
      this.repo.getHealth(t, integ.integration_id),
      this.repo.buckets(t, integ.integration_id),
      this.latestTest(t, integ.integration_id),
    ]);
    const input: LocalHealthInput = {
      now,
      role,
      provider: integ.provider,
      status: integ.status,
      health,
      deliveries_24h: deliveries24h(buckets, now),
      last_test: lastTest,
      has_credentials: !!lookup?.credentials_configured_at,
    };

    if (role === 'repository' && integ.repository) {
      const sessions = opts.ctx?.sessions ?? (await this.repo.sessionsOf(t, integ.project_id));
      input.ide_sessions_7d = sessions.filter((s) => sameRepo(String(s.repository ?? ''), integ.repository) && !this.olderThan(String(s.started_at ?? ''), 7 * DAY_MS)).length;
      const commits = await this.repo.commitsOf(t, integ.repository);
      const hourAgo = new Date(Date.parse(now) - 3_600_000).toISOString();
      input.unverified_commits = commits.filter(
        (c) =>
          c.commit_source !== 'git-remote' &&
          c.remote_only !== true &&
          c.verified_remote !== true &&
          typeof c.committed_at === 'string' &&
          c.committed_at < hourAgo &&
          c.committed_at >= integ.created_at, // antes de existir el webhook no podía verificarse
      ).length;
    }
    if (role === 'tasks') {
      const prefixes = integ.task_project_keys ?? [];
      const branches = await this.repo.branchesOf(t, integ.project_id);
      const seen = [...new Set(branches.flatMap((b) => asArray(b.task_keys)))].filter((k) => !prefixes.length || prefixes.includes(k.split('-')[0]!));
      const found = new Set((await this.repo.tasksByKeys(t, seen.slice(0, 100))).filter((x) => x.deleted !== true).map((x) => String(x.task_key)));
      input.unknown_task_keys = seen.filter((k) => !found.has(k)).sort();
    }

    let providerChecks: CheckResult[];
    if (opts.refresh && lookup) {
      providerChecks = await this.providerChecks(integ, lookup, role, now);
      await this.repo.saveProviderChecks(t, integ.integration_id, providerChecks, now);
    } else {
      providerChecks = health?.provider_checks?.length ? health.provider_checks : providerPlaceholders(input);
    }
    const checks = sortChecks([...localChecks(input), ...providerChecks]);
    const lastEventAt: Record<string, string> = {};
    for (const [k, v] of Object.entries(health ?? {})) {
      if (k.startsWith('last_event_at:') && typeof v === 'string') lastEventAt[k.slice('last_event_at:'.length)] = v;
    }
    return {
      integration_id: integ.integration_id,
      role,
      provider: integ.provider,
      status: rollup(integ.status, checks, health?.last_valid_delivery_at),
      checks,
      deliveries_24h: input.deliveries_24h,
      last_event_at: lastEventAt,
      last_delivery_at: health?.last_delivery_at ?? null,
      last_error: health?.last_error ?? null,
      last_test: lastTest ? { test_id: lastTest.test_id, status: lastTest.status, finished_at: lastTest.finished_at ?? null } : null,
      can_auto_register: input.has_credentials && integ.provider !== 'linear',
    };
  }

  private olderThan(iso: string, ms: number) {
    return !iso || Date.parse(this.iso()) - Date.parse(iso) > ms;
  }

  /** GET /integrations/:id/health */
  async health(t: string, id: string, refresh = false): Promise<IntegrationHealth> {
    const integ = await this.integrations.get(t, id);
    if (!integ) throw new NotFoundException('Integración no encontrada', 'INTEGRATION_NOT_FOUND');
    return this.healthOf(t, integ, { refresh });
  }

  // ── readiness por repositorio ─────────────────────────────────────────────

  private pickBest(list: IntegrationItem[]): IntegrationItem | null {
    return [...list].sort((a, b) => Number(a.status === 'disabled') - Number(b.status === 'disabled') || b.created_at.localeCompare(a.created_at))[0] ?? null;
  }

  /** Repositorios de un proyecto: Project.repositories ∪ integraciones git ∪ sesiones. */
  private async repositoriesOf(t: string, project: string, integrations: IntegrationItem[], sessions: Item[]): Promise<string[]> {
    const proj = await this.store.get(keys.project(t, project));
    const out = new Map<string, string>();
    const add = (r: unknown) => {
      if (typeof r === 'string' && r && !out.has(r.toLowerCase())) out.set(r.toLowerCase(), r);
    };
    for (const i of integrations) if (i.project_id === project && isGit(i.provider)) add(i.repository);
    for (const r of asArray(proj?.repositories)) add(r);
    for (const s of sessions) add(s.repository);
    return [...out.values()].sort();
  }

  private async apiKeysFor(t: string, repository: string, sessions: Item[]): Promise<RepositoryApiKey[]> {
    const mine = sessions.filter((s) => sameRepo(String(s.repository ?? ''), repository));
    const byKey = new Map<string, Item[]>();
    for (const s of mine) {
      const k = String(s.key_id ?? '');
      if (k) byKey.set(k, [...(byKey.get(k) ?? []), s]);
    }
    return Promise.all(
      [...byKey.entries()].map(async ([keyId, rows]) => {
        // ¿la key se usó en otros repos? (peticiones recientes de la key, en cualquier proyecto)
        const reqs = await this.store.queryPrefix(keys.aiRequestGsi1(t, keyId, '').GSI1PK, 'R#', { index: 'GSI1', desc: true, limit: 500 });
        const otherRepo =
          reqs.some((r) => typeof r.repository === 'string' && !sameRepo(r.repository, repository)) ||
          sessions.some((s) => s.key_id === keyId && !sameRepo(String(s.repository ?? ''), repository));
        const last = rows.map((r) => String(r.last_activity_at ?? r.started_at ?? '')).sort().at(-1) ?? null;
        const withFp = rows.find((r) => typeof r.key_fingerprint === 'string');
        const withName = rows.find((r) => typeof r.key_name === 'string');
        return {
          key_id: keyId,
          key_fingerprint: (withFp?.key_fingerprint as string | undefined) ?? keyId,
          key_name: (withName?.key_name as string | undefined) ?? null,
          last_used_at: last || null,
          sessions_7d: rows.filter((r) => !this.olderThan(String(r.started_at ?? ''), 7 * DAY_MS)).length,
          usage: otherRepo ? ('shared' as const) : ('dedicated' as const),
        };
      }),
    );
  }

  private reasonFor(role: Role, h: IntegrationHealth): string | null {
    const who = role === 'repository' ? `El webhook del repositorio${h.provider ? ` (${providerName(h.provider)})` : ''}` : `El webhook del gestor de tareas${h.provider ? ` (${providerName(h.provider)})` : ''}`;
    switch (h.status) {
      case 'not_configured':
        return role === 'repository'
          ? 'Falta conectar el repositorio (GitHub, Bitbucket o GitLab): crea la integración y configura su webhook.'
          : 'Falta conectar el gestor de tareas (Jira o Linear): crea la integración y configura su webhook.';
      case 'disabled':
        return `${who} está deshabilitado: crea una integración nueva.`;
      case 'awaiting_first_delivery':
        return `${who} aún no envió ningún evento válido: regístralo y lanza la prueba de ida y vuelta.`;
      case 'failing':
        return `${who} está fallando: ${h.checks.find((c) => c.status === 'fail')?.message ?? 'revisa los checks'}`;
      default:
        return null;
    }
  }

  /** Integración de tareas que cubre al repo: la del proyecto cuyas claves aparecen en sus ramas. */
  private async tasksIntegrationFor(t: string, repository: string, candidates: IntegrationItem[]): Promise<IntegrationItem | null> {
    const live = candidates.filter((c) => c.status !== 'disabled');
    if (live.length <= 1) return this.pickBest(live.length ? live : candidates);
    const branches = await this.store.queryPrefix(keys.repoPk(t, repository), 'BRANCH#', { limit: 1000 });
    const prefixes = branches.flatMap((b) => asArray(b.task_keys)).map((k) => k.split('-')[0]!);
    const score = (i: IntegrationItem) => prefixes.filter((p) => i.task_project_keys?.includes(p)).length;
    return [...live].sort((a, b) => score(b) - score(a) || b.created_at.localeCompare(a.created_at))[0] ?? null;
  }

  private async repositoryReadinessIn(
    t: string,
    project: string,
    repository: string,
    integrations: IntegrationItem[],
    sessions: Item[],
    cache: Map<string, Promise<IntegrationHealth>>,
  ): Promise<RepositoryReadiness> {
    const now = this.iso();
    const projectInts = integrations.filter((i) => i.project_id === project);
    const gitInt = this.pickBest(projectInts.filter((i) => isGit(i.provider) && sameRepo(i.repository, repository)));
    const taskInt = await this.tasksIntegrationFor(t, repository, projectInts.filter((i) => isTask(i.provider)));
    const healthCached = (i: IntegrationItem) => {
      let p = cache.get(i.integration_id);
      if (!p) cache.set(i.integration_id, (p = this.healthOf(t, i, { ctx: { sessions } })));
      return p;
    };
    const [repoH, tasksH, apiKeys] = await Promise.all([
      gitInt ? healthCached(gitInt) : Promise.resolve(notConfigured('repository', now)),
      taskInt ? healthCached(taskInt) : Promise.resolve(notConfigured('tasks', now)),
      this.apiKeysFor(t, repository, sessions),
    ]);
    const mine = sessions.filter((s) => sameRepo(String(s.repository ?? ''), repository));
    const reasons = [this.reasonFor('repository', repoH), this.reasonFor('tasks', tasksH)].filter((r): r is string => !!r);
    return {
      repository,
      project_id: project,
      ready: !reasons.length,
      api_keys: apiKeys.sort((a, b) => (b.last_used_at ?? '').localeCompare(a.last_used_at ?? '')),
      repository_webhook: repoH,
      tasks_webhook: tasksH,
      ide: {
        last_event_at: mine.map((s) => String(s.last_activity_at ?? s.started_at ?? '')).filter(Boolean).sort().at(-1) ?? null,
        sessions_7d: mine.filter((s) => !this.olderThan(String(s.started_at ?? ''), 7 * DAY_MS)).length,
      },
      blocking_reasons: reasons,
      evaluated_at: now,
    };
  }

  /** GET /projects/:projectId/readiness — listo si TODOS sus repos lo están. Sin llamadas al proveedor. */
  async projectReadiness(t: string, project: string): Promise<ProjectReadiness> {
    const [integrations, sessions] = await Promise.all([this.integrations.listByTenant(t), this.repo.sessionsOf(t, project)]);
    const repos = await this.repositoriesOf(t, project, integrations, sessions);
    const cache = new Map<string, Promise<IntegrationHealth>>();
    const repositories = await Promise.all(repos.map((r) => this.repositoryReadinessIn(t, project, r, integrations, sessions, cache)));
    const reasons = repositories.flatMap((r) => r.blocking_reasons.map((b) => `${r.repository}: ${b}`));
    if (!repositories.length) {
      const hasTasks = integrations.some((i) => i.project_id === project && isTask(i.provider) && i.status !== 'disabled');
      reasons.push('El proyecto no tiene repositorios: conecta el webhook del repositorio (GitHub, Bitbucket o GitLab).');
      if (!hasTasks) reasons.push('Falta conectar el gestor de tareas (Jira o Linear).');
    }
    return { project_id: project, ready: repositories.length > 0 && repositories.every((r) => r.ready), repositories, blocking_reasons: reasons, evaluated_at: this.iso() };
  }

  /** Proyecto de un repo cuando la URL no lo trae: integración git → fila Project → sesiones. */
  private async projectOfRepository(t: string, repository: string, integrations: IntegrationItem[]): Promise<string | null> {
    const fromInt = this.pickBest(integrations.filter((i) => isGit(i.provider) && sameRepo(i.repository, repository)));
    if (fromInt) return fromInt.project_id;
    const projects = await this.store.queryPrefix(keys.project(t, 'x').PK, 'P#', { limit: 500 });
    const hit = projects.find((p) => asArray(p.repositories).some((r) => sameRepo(r, repository)));
    return hit ? String(hit.project_id) : null;
  }

  /** GET /repositories/:repository/readiness */
  async repositoryReadiness(t: string, repository: string, projectId?: string): Promise<RepositoryReadiness> {
    const integrations = await this.integrations.listByTenant(t);
    const project = projectId ?? (await this.projectOfRepository(t, repository, integrations));
    if (!project) throw new NotFoundException(`Repositorio ${repository} no encontrado en ningún proyecto`, 'REPOSITORY_NOT_FOUND');
    const sessions = await this.repo.sessionsOf(t, project);
    return this.repositoryReadinessIn(t, project, repository, integrations, sessions, new Map());
  }

  /** GET /repositories?project_id — opciones de la lista desplegable. */
  async repositoryOptions(t: string, projectId?: string): Promise<RepositoryOption[]> {
    const integrations = await this.integrations.listByTenant(t);
    const projects = projectId
      ? [projectId]
      : [...new Set([...integrations.map((i) => i.project_id), ...(await this.store.queryPrefix(keys.project(t, 'x').PK, 'P#', { limit: 500 })).map((p) => String(p.project_id))])].filter(Boolean);
    const all = await Promise.all(projects.map((p) => this.projectReadiness(t, p)));
    return all.flatMap((pr) =>
      pr.repositories.map((r) => ({
        repository: r.repository,
        project_id: r.project_id,
        ready: r.ready,
        status: worstStatus(r.repository_webhook.status, r.tasks_webhook.status),
      })),
    );
  }
}

export const integrationHealthService = new IntegrationHealthService();
