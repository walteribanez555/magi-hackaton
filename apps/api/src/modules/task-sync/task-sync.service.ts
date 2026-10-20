import { randomBytes } from 'node:crypto';
import { ZodError } from 'zod';
import {
  AutomationRuleUpsert,
  GitProvider,
  GitProviderCredentials,
  keys,
  TaskActionRequest,
  TaskKey,
  TaskProvider,
  TaskProviderCredentials,
  type AutomationRule,
  type AvailableTransition,
  type OutboxAction,
  type RuleTrigger,
  type TaskAction,
} from '@magicode/contracts';
import { createLogger } from '../../config/logger';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableException,
} from '../../common/exceptions';
import { integrationsRepository, type IntegrationsRepository } from '../integrations/integrations.repository';
import type { CallerScope, IntegrationItem } from '../integrations/integrations.types';
import { tasksRepository, type TasksRepository } from '../tasks/tasks.repository';
import { tasksService, type TasksService } from '../tasks/tasks.service';
import { DEFAULT_STORY_POINTS_FIELD } from '../webhooks/adapters/jira.adapter';
import { hookApiFor } from '../integration-health/provider-hooks.client';
import { credentialsStore, isTaskCredentials, type CredentialsStore } from './credentials.store';
import { JiraClient } from './jira.client';
import { LinearClient } from './linear.client';
import { ProviderError, type HttpOptions } from './provider-http';
import { commitUrlFromRemote, evaluateRules, needsMetrics, seedRules, triggerRefFor } from './rules.engine';
import { taskSyncRepository, type TaskSyncRepository } from './task-sync.repository';
import type {
  AutomationRuleItem,
  OutboxItem,
  RuleVars,
  TaskProviderClient,
  TriggerInput,
} from './task-sync.types';

const logger = createLogger('TaskSync');

export const MAX_ATTEMPTS = 5;

/** Error transitorio: el handler del stream devuelve el registro en batchItemFailures. */
export class RetryableOutboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableOutboxError';
  }
}

const newActionId = () => `act_${randomBytes(8).toString('hex')}`;
const newRuleId = () => `rule_${randomBytes(6).toString('hex')}`;

/** AutomationRuleUpsert (la URL de remote_link admite plantillas {{…}}; se valida absoluta al disparar). */
export function parseRuleUpsert(body: unknown): AutomationRuleUpsert {
  return AutomationRuleUpsert.parse(body);
}

export function toOutboxAction(i: OutboxItem): OutboxAction {
  return {
    action_id: i.action_id,
    tenant_id: i.tenant_id,
    integration_id: i.integration_id,
    provider: i.provider,
    task_key: i.task_key,
    action: i.action,
    origin: i.origin,
    idempotency_key: i.idempotency_key,
    status: i.status,
    attempts: i.attempts ?? 0,
    last_error: i.last_error ?? null,
    result: i.result ?? null,
    created_at: i.created_at,
    updated_at: i.updated_at,
  };
}

export function toRule(i: AutomationRuleItem): AutomationRule {
  return {
    rule_id: i.rule_id,
    integration_id: i.integration_id,
    name: i.name,
    enabled: i.enabled,
    trigger: i.trigger,
    when: i.when ?? {},
    action: i.action,
    created_at: i.created_at,
    updated_at: i.updated_at,
  };
}

const isTaskProvider = (p: string) => TaskProvider.safeParse(p).success;

export interface TaskSyncDeps {
  repo?: TaskSyncRepository;
  integrations?: IntegrationsRepository;
  tasks?: TasksRepository;
  taskMetrics?: Pick<TasksService, 'metricsFor'>;
  credentials?: CredentialsStore;
  http?: HttpOptions;
  now?: () => Date;
  clientFor?: (creds: TaskProviderCredentials) => TaskProviderClient;
}

export class TaskSyncService {
  private readonly repo: TaskSyncRepository;
  private readonly integrations: IntegrationsRepository;
  private readonly tasks: TasksRepository;
  private readonly taskMetrics: Pick<TasksService, 'metricsFor'>;
  private readonly credentials: CredentialsStore;
  private readonly now: () => Date;
  private readonly makeClient: (creds: TaskProviderCredentials) => TaskProviderClient;
  private readonly http: HttpOptions;

  constructor(deps: TaskSyncDeps = {}) {
    this.http = deps.http ?? {};
    this.repo = deps.repo ?? taskSyncRepository;
    this.integrations = deps.integrations ?? integrationsRepository;
    this.tasks = deps.tasks ?? tasksRepository;
    this.taskMetrics = deps.taskMetrics ?? tasksService;
    this.credentials = deps.credentials ?? credentialsStore;
    this.now = deps.now ?? (() => new Date());
    this.makeClient =
      deps.clientFor ??
      ((creds) => (creds.provider === 'jira' ? new JiraClient(creds, deps.http, this.now) : new LinearClient(creds, deps.http)));
  }

  // ── resolución de integración ─────────────────────────────────────────────

  private async activeTaskIntegrations(tenantId: string): Promise<IntegrationItem[]> {
    return (await this.integrations.listByTenant(tenantId)).filter((i) => isTaskProvider(i.provider) && i.status !== 'disabled');
  }

  /** La integración Jira/Linear de la tarea: la que la sincronizó o, si no, la que declara su prefijo. */
  pickIntegration(list: IntegrationItem[], taskKey: string, opts: { integration_id?: string; project_id?: string } = {}) {
    if (opts.integration_id) {
      const byId = list.find((i) => i.integration_id === opts.integration_id);
      if (byId) return byId;
    }
    const prefix = taskKey.split('-')[0]!;
    const candidates = list.filter((i) => i.task_project_keys?.includes(prefix));
    return candidates.find((i) => i.project_id === opts.project_id) ?? candidates[0] ?? null;
  }

  private async integrationForTask(tenantId: string, taskKey: string): Promise<IntegrationItem> {
    const [list, task] = await Promise.all([this.activeTaskIntegrations(tenantId), this.tasks.get(tenantId, taskKey)]);
    const integ = this.pickIntegration(list, taskKey, {
      integration_id: task?.integration_id,
      project_id: task?.project_id,
    });
    if (!integ) throw new NotFoundException(`No hay integración Jira/Linear activa para ${taskKey}`, 'NO_TASK_INTEGRATION');
    return integ;
  }

  private async clientForIntegration(integrationId: string): Promise<TaskProviderClient> {
    const creds = await this.credentials.get(integrationId);
    if (!creds || !isTaskCredentials(creds)) {
      throw new UnprocessableException('La integración no tiene credenciales de write-back', 'CREDENTIALS_MISSING');
    }
    return this.makeClient(creds);
  }

  private normalizeKey(raw: string): string {
    const key = raw.toUpperCase();
    if (!TaskKey.safeParse(key).success) throw new BadRequestException('Clave de tarea inválida', 'INVALID_TASK_KEY');
    return key;
  }

  // ── acciones manuales ─────────────────────────────────────────────────────

  async enqueue(input: {
    tenant_id: string;
    key_id: string;
    project_id?: string;
    integration: Pick<IntegrationItem, 'integration_id' | 'provider'>;
    task_key: string;
    action: TaskAction;
    origin: OutboxAction['origin'];
    idempotency_key: string;
    /** se registra directamente como skipped (auditoría) y el stream no lo procesa */
    skip_reason?: string;
  }): Promise<{ item: OutboxAction; duplicate: boolean }> {
    const at = this.now();
    const status = input.skip_reason ? 'skipped' : 'pending';
    const createdAt = at.toISOString();
    const actionId = newActionId();
    const item: OutboxItem = {
      ...keys.outboxAction(input.tenant_id, input.task_key, createdAt, actionId),
      ...keys.outboxGsi1(input.tenant_id, status, createdAt),
      entity: 'OutboxAction',
      action_id: actionId,
      tenant_id: input.tenant_id,
      key_id: input.key_id,
      ...(input.project_id ? { project_id: input.project_id } : {}),
      integration_id: input.integration.integration_id,
      provider: input.integration.provider as OutboxAction['provider'],
      task_key: input.task_key,
      action: input.action,
      origin: input.origin,
      idempotency_key: input.idempotency_key,
      status,
      attempts: 0,
      last_error: input.skip_reason ?? null,
      result: null,
      created_at: createdAt,
      updated_at: createdAt,
      provenance: 'real',
    };
    const res = await this.repo.enqueue(item, Math.floor(at.getTime() / 1000));
    return { item: toOutboxAction(res.item), duplicate: res.duplicate };
  }

  /** POST /tasks/:taskKey/actions → 202 (nueva) | 200 (duplicada: devuelve la original). */
  async enqueueManual(scope: CallerScope, rawKey: string, body: unknown): Promise<{ item: OutboxAction; duplicate: boolean }> {
    const taskKey = this.normalizeKey(rawKey);
    const req = TaskActionRequest.parse(body);
    const integ = await this.integrationForTask(scope.tenant_id, taskKey);
    const res = await this.enqueue({
      tenant_id: scope.tenant_id,
      key_id: scope.key_id,
      project_id: integ.project_id,
      integration: integ,
      task_key: taskKey,
      action: req.action,
      origin: { type: 'manual', key_id: scope.key_id },
      idempotency_key: `manual:${req.idempotency_key}`,
    });
    logger.info('Acción encolada', {
      tenant_id: scope.tenant_id,
      task_key: taskKey,
      action_id: res.item.action_id,
      kind: req.action.kind,
      duplicate: res.duplicate,
    });
    return res;
  }

  async listActions(tenantId: string, rawKey: string): Promise<OutboxAction[]> {
    return (await this.repo.listActions(tenantId, this.normalizeKey(rawKey))).map(toOutboxAction);
  }

  /** GET /tasks/:taskKey/transitions — consulta en vivo al proveedor. */
  async transitions(tenantId: string, rawKey: string): Promise<AvailableTransition[]> {
    const taskKey = this.normalizeKey(rawKey);
    const integ = await this.integrationForTask(tenantId, taskKey);
    const client = await this.clientForIntegration(integ.integration_id);
    try {
      return await client.transitions(taskKey);
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) throw new NotFoundException(`${taskKey} no existe en el proveedor`, 'TASK_NOT_FOUND_REMOTE');
      if (err instanceof ProviderError) throw new BadGatewayException(err.message, 'TASK_PROVIDER_ERROR');
      throw err;
    }
  }

  // ── credenciales ──────────────────────────────────────────────────────────

  private async ownTaskIntegration(tenantId: string, integrationId: string): Promise<IntegrationItem> {
    const integ = await this.integrations.get(tenantId, integrationId);
    if (!integ || integ.status === 'disabled') throw new NotFoundException('Integración no encontrada', 'INTEGRATION_NOT_FOUND');
    if (!isTaskProvider(integ.provider)) {
      throw new BadRequestException('Solo las integraciones Jira/Linear admiten write-back', 'NOT_TASK_PROVIDER');
    }
    return integ;
  }

  /** PUT /integrations/:id/credentials → verifica contra el proveedor, guarda en Secrets Manager, 204. */
  /**
   * PUT /integrations/:id/credentials → verifica contra el proveedor, guarda en Secrets Manager, 204.
   * Jira/Linear: TaskProviderCredentials (write-back). GitHub/Bitbucket/GitLab: GitProviderCredentials
   * (verificar/registrar el webhook, ping, historial de entregas).
   */
  async saveCredentials(scope: CallerScope, integrationId: string, body: unknown): Promise<void> {
    const found = await this.integrations.get(scope.tenant_id, integrationId);
    if (found && found.status !== 'disabled' && GitProvider.safeParse(found.provider).success) {
      return this.saveGitCredentials(scope, found, body);
    }
    const integ = await this.ownTaskIntegration(scope.tenant_id, integrationId);
    const creds = TaskProviderCredentials.parse(body);
    if (creds.provider !== integ.provider) {
      throw new BadRequestException('Las credenciales no corresponden al proveedor de la integración', 'PROVIDER_MISMATCH');
    }
    let me: { account_id: string };
    try {
      me = await this.makeClient(creds).whoami();
    } catch (err) {
      if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) {
        throw new UnprocessableException('El proveedor rechazó las credenciales', 'CREDENTIALS_REJECTED');
      }
      if (err instanceof ProviderError) throw new BadGatewayException('No se pudo verificar las credenciales con el proveedor', 'TASK_PROVIDER_ERROR');
      throw err;
    }
    await this.credentials.save(integrationId, scope.tenant_id, creds);

    const managed =
      creds.provider === 'jira'
        ? [
            creds.field_ids?.story_points || process.env.JIRA_STORY_POINTS_FIELD || DEFAULT_STORY_POINTS_FIELD,
            creds.field_ids?.magicode_tokens,
            creds.field_ids?.magicode_effective_lines,
            creds.field_ids?.magicode_criticality,
          ].filter((x): x is string => !!x)
        : [];
    const at = this.now().toISOString();
    await this.repo.markCredentials(
      scope.tenant_id,
      integrationId,
      {
        service_account_id: me.account_id,
        managed_field_ids: managed,
        ...(creds.provider === 'jira' ? { base_url: creds.site_url.replace(/\/+$/, '') } : {}),
      },
      at,
    );
    // primera vez ⇒ reglas por defecto (las desactivadas quedan listas para activar)
    if (!(await this.repo.listRules(scope.tenant_id, integrationId)).length) {
      for (const r of seedRules()) await this.createRule(scope, integrationId, r, false);
    }
    logger.info('Credenciales de write-back guardadas', { tenant_id: scope.tenant_id, integration_id: integrationId, provider: creds.provider });
  }

  /** Credenciales git: GET repo + GET hooks (permiso de webhooks) antes de guardarlas. */
  private async saveGitCredentials(scope: CallerScope, integ: IntegrationItem, body: unknown): Promise<void> {
    const creds = GitProviderCredentials.parse(body);
    if (creds.provider !== integ.provider) {
      throw new BadRequestException('Las credenciales no corresponden al proveedor de la integración', 'PROVIDER_MISMATCH');
    }
    const api = hookApiFor(creds, integ, this.http);
    if (!api) throw new BadRequestException('La integración no tiene repositorio configurado', 'NO_REPOSITORY');
    try {
      await api.verify();
    } catch (err) {
      if (err instanceof ProviderError && (err.status === 401 || err.status === 403 || err.status === 404)) {
        throw new UnprocessableException(
          err.status === 404
            ? `El token no ve el repositorio ${integ.repository} (¿nombre correcto y acceso al repo?)`
            : 'El proveedor rechazó las credenciales o faltan permisos de webhooks',
          'CREDENTIALS_REJECTED',
        );
      }
      if (err instanceof ProviderError) throw new BadGatewayException('No se pudo verificar las credenciales con el proveedor', 'GIT_PROVIDER_ERROR');
      throw err;
    }
    await this.credentials.save(integ.integration_id, scope.tenant_id, creds);
    await this.repo.markCredentials(scope.tenant_id, integ.integration_id, { managed_field_ids: [] }, this.now().toISOString());
    logger.info('Credenciales git guardadas', { tenant_id: scope.tenant_id, integration_id: integ.integration_id, provider: creds.provider });
  }

  // ── reglas ────────────────────────────────────────────────────────────────

  async listRules(tenantId: string, integrationId: string): Promise<AutomationRule[]> {
    await this.ownTaskIntegration(tenantId, integrationId);
    return (await this.repo.listRules(tenantId, integrationId)).map(toRule).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async createRule(scope: CallerScope, integrationId: string, body: unknown, check = true): Promise<AutomationRule> {
    if (check) await this.ownTaskIntegration(scope.tenant_id, integrationId);
    const input = parseRuleUpsert(body);
    const at = this.now().toISOString();
    const ruleId = newRuleId();
    const item: AutomationRuleItem = {
      ...keys.automationRule(scope.tenant_id, integrationId, ruleId),
      entity: 'AutomationRule',
      tenant_id: scope.tenant_id,
      key_id: scope.key_id,
      provenance: 'real',
      rule_id: ruleId,
      integration_id: integrationId,
      ...input,
      when: input.when ?? {},
      created_at: at,
      updated_at: at,
    };
    if (!(await this.repo.putRule(item, false))) throw new ConflictException('Regla duplicada', 'RULE_EXISTS');
    return toRule(item);
  }

  async updateRule(scope: CallerScope, integrationId: string, ruleId: string, body: unknown): Promise<AutomationRule> {
    await this.ownTaskIntegration(scope.tenant_id, integrationId);
    const existing = await this.repo.getRule(scope.tenant_id, integrationId, ruleId);
    if (!existing) throw new NotFoundException('Regla no encontrada', 'RULE_NOT_FOUND');
    const input = parseRuleUpsert(body);
    const item: AutomationRuleItem = { ...existing, ...input, when: input.when ?? {}, key_id: scope.key_id, updated_at: this.now().toISOString() };
    if (!(await this.repo.putRule(item, true))) throw new NotFoundException('Regla no encontrada', 'RULE_NOT_FOUND');
    return toRule(item);
  }

  async deleteRule(tenantId: string, integrationId: string, ruleId: string): Promise<void> {
    await this.ownTaskIntegration(tenantId, integrationId);
    if (!(await this.repo.deleteRule(tenantId, integrationId, ruleId))) throw new NotFoundException('Regla no encontrada', 'RULE_NOT_FOUND');
  }

  // ── motor de reglas (impuro: carga reglas/tarea y encola) ─────────────────

  /**
   * Disparo de reglas. Lo llaman la proyección de webhooks (pr.opened, pr.merged, deployment.success,
   * reference.marked) y —cableado por el lead— productivity (commit.linked, session.started, reference.marked).
   * Nunca lanza: un fallo de reglas no debe romper la ingesta.
   */
  fireTrigger = async (trigger: RuleTrigger, input: TriggerInput): Promise<void> => {
    try {
      const taskKeys = [...new Set(input.task_keys)].filter((k) => TaskKey.safeParse(k).success);
      if (!taskKeys.length) return;
      const list = await this.activeTaskIntegrations(input.tenant_id);
      if (!list.length) return;
      const rulesCache = new Map<string, Promise<AutomationRule[]>>();
      const dashboard = process.env.DASHBOARD_URL?.replace(/\/+$/, '');

      for (const taskKey of taskKeys) {
        const task = await this.tasks.get(input.tenant_id, taskKey);
        const integ = this.pickIntegration(list, taskKey, { integration_id: task?.integration_id, project_id: input.project_id ?? task?.project_id });
        if (!integ) continue;
        let rulesP = rulesCache.get(integ.integration_id);
        if (!rulesP) {
          rulesP = this.repo.listRules(input.tenant_id, integ.integration_id).then((rs) => rs.map(toRule));
          rulesCache.set(integ.integration_id, rulesP);
        }
        const rules = (await rulesP).filter((r) => r.enabled && r.trigger === trigger);
        if (!rules.length) continue;

        const vars: RuleVars = {
          ...(input.vars ?? {}),
          ...(input.environment ? { environment: input.environment } : {}),
          ...(dashboard ? { dashboard_url: `${dashboard}/tasks/${encodeURIComponent(taskKey)}` } : {}),
        };
        // {{commit_url}}: primero el remote_url del Commit (lo reporta la extensión); si no, el del webhook
        if (vars.sha && vars.repository && JSON.stringify(rules).includes('{{commit_url}}')) {
          const [commit] = await this.tasks.commits(input.tenant_id, [{ repository: String(vars.repository), sha: String(vars.sha) }]);
          const fromRemote = commitUrlFromRemote(commit?.remote_url as string | undefined, String(vars.sha));
          if (fromRemote) vars.commit_url = fromRemote;
        }
        if (needsMetrics(rules)) {
          const { metrics } = await this.taskMetrics.metricsFor(input.tenant_id, taskKey);
          Object.assign(vars, {
            tokens: metrics.tokens.value ?? '',
            effective_lines: metrics.effective_lines,
            criticality: metrics.criticality ?? '',
          });
        }
        const { planned, skipped } = evaluateRules(trigger, {
          task_key: taskKey,
          trigger_ref: triggerRefFor(taskKey, input.ref),
          status_category: task?.status_category,
          environment: input.environment,
          target_branch: input.target_branch,
          vars,
          rules,
        });
        for (const p of planned) {
          const res = await this.enqueue({
            tenant_id: input.tenant_id,
            key_id: integ.key_id,
            project_id: integ.project_id,
            integration: integ,
            task_key: taskKey,
            action: p.action,
            origin: { type: 'rule', rule_id: p.rule_id, trigger_ref: p.trigger_ref },
            idempotency_key: p.idempotency_key,
            ...(p.skip_reason ? { skip_reason: p.skip_reason } : {}),
          });
          logger.info('Regla disparada', { tenant_id: input.tenant_id, trigger, task_key: taskKey, rule_id: p.rule_id, duplicate: res.duplicate });
        }
        if (skipped.length) logger.debug('Reglas omitidas', { trigger, task_key: taskKey, skipped });
      }
    } catch (err) {
      logger.error('Fallo evaluando reglas', err instanceof Error ? { name: err.name, message: err.message } : err);
    }
  };

  // ── outbox (task-sync Lambda) ─────────────────────────────────────────────

  /**
   * Procesa UNA OutboxAction: pending → sending → sent | skipped | failed. Errores transitorios
   * (429/5xx/red) vuelven a pending y lanzan RetryableOutboxError (máx. MAX_ATTEMPTS intentos);
   * 4xx (salvo 429) y errores de configuración ⇒ failed definitivo.
   */
  async processOutbox(key: { PK: string; SK: string }): Promise<'sent' | 'skipped' | 'failed' | 'noop'> {
    const current = await this.repo.getOutbox(key);
    if (!current || current.entity !== 'OutboxAction' || (current.status !== 'pending' && current.status !== 'sending')) return 'noop';
    const item = await this.repo.claim(current, this.now());
    if (!item) return 'noop';
    const log = logger.child({ tenant_id: item.tenant_id, action_id: item.action_id, task_key: item.task_key, kind: item.action.kind });

    const fail = async (message: string) => {
      await this.repo.finish(item, 'failed', { last_error: message.slice(0, 500), result: null }, this.now());
      log.warn('Acción fallida', { attempts: item.attempts, error: message.slice(0, 200) });
      return 'failed' as const;
    };

    try {
      const lookup = await this.integrations.getLookup(item.integration_id);
      if (!lookup || lookup.status === 'disabled' || lookup.tenant_id !== item.tenant_id) {
        return await fail('Integración deshabilitada o inexistente');
      }
      const creds = await this.credentials.get(item.integration_id);
      if (!creds || !isTaskCredentials(creds)) return await fail('La integración no tiene credenciales de write-back');
      const res = await this.makeClient(creds).execute(item.task_key, item.action, item.action_id);
      await this.repo.finish(item, res.status, { result: res.result, last_error: null }, this.now());
      if (res.task_status) {
        await this.repo.setTaskStatus(item.tenant_id, item.task_key, res.task_status.status, res.task_status.status_category, this.now().toISOString());
      }
      log.info('Acción enviada', { status: res.status, attempts: item.attempts });
      return res.status;
    } catch (err) {
      const transient = err instanceof ProviderError ? err.transient : !(err instanceof ZodError);
      const message = err instanceof Error ? `${err.name === 'ProviderError' ? '' : `${err.name}: `}${err.message}` : String(err);
      if (transient && item.attempts < MAX_ATTEMPTS) {
        await this.repo.finish(item, 'pending', { last_error: message.slice(0, 500) }, this.now());
        log.warn('Acción con error transitorio; se reintentará', { attempts: item.attempts, error: message.slice(0, 200) });
        throw new RetryableOutboxError(message);
      }
      return fail(transient ? `${message} (agotados ${MAX_ATTEMPTS} intentos)` : message);
    }
  }
}

export const taskSyncService = new TaskSyncService();
