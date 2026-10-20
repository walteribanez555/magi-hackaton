import { createHash } from 'node:crypto';
import {
  GitProvider,
  IntegrationProvider,
  keys,
  TaskProvider,
  WEBHOOK_SIGNATURE_HEADERS,
  type NormalizedWebhookEvent,
} from '@magicode/contracts';
import { createLogger } from '../../config/logger';
import { BadRequestException, HttpException, NotFoundException, UnauthorizedException } from '../../common/exceptions';
import { integrationHealthService, type DeliverySignal, type IntegrationHealthService } from '../integration-health/integration-health.service';
import type { DeliveryOutcome } from '../integration-health/integration-health.types';
import { integrationsRepository, type IntegrationsRepository } from '../integrations/integrations.repository';
import type { IntLookupItem } from '../integrations/integrations.types';
import { adaptWebhook } from './adapters';
import { DEFAULT_STORY_POINTS_FIELD } from './adapters/jira.adapter';
import { webhookProjector, type ProjectionContext, type WebhookProjector } from './webhooks.projection';
import { webhooksRepository, type WebhooksRepository } from './webhooks.repository';
import { verifyWebhookSignature } from './webhooks.signature';
import { taskSyncService } from '../task-sync/task-sync.service';
import type { FireTrigger } from '../task-sync/task-sync.types';
import type { WebhookOutcome, WebhookRequest } from './webhooks.types';

const logger = createLogger('WebhooksService');

const sameRepo = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Delivery id del header del proveedor; si no viene, huella del cuerpo (reintentos idénticos ⇒ mismo id). */
export function deliveryIdOf(provider: IntegrationProvider, headers: Record<string, string | undefined>, rawBody: string): string {
  const h = headers[WEBHOOK_SIGNATURE_HEADERS[provider].delivery]?.trim();
  if (h) return h.slice(0, 200);
  return `body-sha256:${createHash('sha256').update(rawBody).digest('hex').slice(0, 40)}`;
}

export interface WebhooksServiceDeps {
  integrations?: IntegrationsRepository;
  repo?: WebhooksRepository;
  projector?: WebhookProjector;
  fireTrigger?: FireTrigger;
  health?: DeliveryHealth;
  now?: () => Date;
}

/** Lo que el webhook necesita del módulo de salud (inyectable en tests). */
export type DeliveryHealth = Pick<IntegrationHealthService, 'recordDelivery' | 'onValidDelivery' | 'onInvalidSignature'>;

/** Resultado de la entrega para la contabilidad de salud. */
export function outcomeOf(out: WebhookOutcome): DeliveryOutcome {
  const b = out.body as Record<string, unknown>;
  if (b.duplicate) return 'duplicate';
  if (b.ignored) return 'ignored';
  return 'accepted';
}

export class WebhooksService {
  private readonly integrations: IntegrationsRepository;
  private readonly repo: WebhooksRepository;
  private readonly projector: WebhookProjector;
  private readonly now: () => Date;
  private readonly fireTrigger: FireTrigger;
  private readonly health: DeliveryHealth;

  constructor(deps: WebhooksServiceDeps = {}) {
    this.health = deps.health ?? integrationHealthService;
    this.fireTrigger = deps.fireTrigger ?? ((trigger, input) => taskSyncService.fireTrigger(trigger, input));
    this.integrations = deps.integrations ?? integrationsRepository;
    this.repo = deps.repo ?? webhooksRepository;
    this.projector = deps.projector ?? webhookProjector;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * 1) IntLookup (404 si no existe / deshabilitada; 400 si el proveedor no coincide)
   * 2) firma HMAC con el secreto de ESA integración (401) — el tenant sale de aquí, nunca del payload
   * 3) adaptador puro → NormalizedWebhookEvent[] (zod) · ping → 200 · no soportado → 202
   * 4) dedupe por delivery id (condicional, TTL 30 d) · duplicado → 200 {duplicate:true}
   * 5) proyección + Integration.last_delivery_at/status=active
   */
  async handle(req: WebhookRequest): Promise<WebhookOutcome> {
    const parsedProvider = IntegrationProvider.safeParse(req.provider);
    if (!parsedProvider.success) throw new NotFoundException('Proveedor de webhook no soportado', 'UNKNOWN_PROVIDER');
    const provider = parsedProvider.data;

    const lookup = /^int_[0-9a-f]{16}$/.test(req.integration_id) ? await this.integrations.getLookup(req.integration_id) : null;
    if (!lookup) throw new NotFoundException('Integración no encontrada', 'INTEGRATION_NOT_FOUND');

    // Contabilidad de entregas (sin payloads) contra la integración de la URL — también las rechazadas.
    const at = this.now();
    const headerEvent = req.headers[WEBHOOK_SIGNATURE_HEADERS[provider].event];
    try {
      const { out, signal } = await this.process(provider, lookup, req, at);
      await this.health.recordDelivery(lookup, outcomeOf(out), { at: signal.at, event: signal.event });
      await this.health.onValidDelivery(lookup, signal);
      return out;
    } catch (err) {
      const badSignature = err instanceof HttpException && err.code === 'INVALID_SIGNATURE';
      const message = err instanceof HttpException ? `${err.statusCode} ${err.code ?? ''} ${err.message}`.trim() : 'error interno al procesar la entrega';
      await this.health.recordDelivery(lookup, badSignature ? 'rejected_signature' : 'rejected_other', {
        at: at.toISOString(),
        ...(headerEvent ? { event: headerEvent } : {}),
        error: message,
      });
      if (badSignature) await this.health.onInvalidSignature(lookup, at.toISOString());
      throw err;
    }
  }

  private async process(
    provider: IntegrationProvider,
    lookup: IntLookupItem,
    req: WebhookRequest,
    at: Date,
  ): Promise<{ out: WebhookOutcome; signal: DeliverySignal }> {
    if (lookup.status === 'disabled') throw new NotFoundException('Integración deshabilitada', 'INTEGRATION_NOT_FOUND');
    if (lookup.provider !== provider) {
      throw new BadRequestException('El proveedor no coincide con la integración', 'PROVIDER_MISMATCH');
    }

    const sig = verifyWebhookSignature(provider, req.headers, req.raw_body, lookup.secret);
    const log = logger.child({ tenant_id: lookup.tenant_id, integration_id: lookup.integration_id, provider });
    if (!sig.ok) {
      log.warn('Firma de webhook inválida', { reason: sig.reason });
      throw new UnauthorizedException('Firma de webhook inválida', 'INVALID_SIGNATURE');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(req.raw_body);
    } catch {
      throw new BadRequestException('El cuerpo no es JSON válido (configura Content type: application/json)', 'INVALID_JSON');
    }

    const receivedAt = at.toISOString();
    const deliveryId = deliveryIdOf(provider, req.headers, req.raw_body);
    const event = req.headers[WEBHOOK_SIGNATURE_HEADERS[provider].event];
    const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    // nombre del evento para last_event_at: Jira lo trae en el cuerpo; GitLab también (object_kind)
    const eventName =
      provider === 'jira' ? String(p.webhookEvent ?? event ?? 'jira') : provider === 'gitlab' ? String(p.object_kind ?? event ?? 'gitlab') : (event ?? provider);
    const signal = (o: Partial<DeliverySignal> = {}): DeliverySignal => ({ at: receivedAt, event: eventName, ping: false, kinds: [], jira_test: false, ...o });

    const adapted = adaptWebhook(provider, {
      event,
      payload,
      delivery_id: deliveryId,
      integration_id: lookup.integration_id,
      received_at: receivedAt,
      options: {
        base_url: lookup.base_url,
        story_points_field: process.env.JIRA_STORY_POINTS_FIELD?.trim() || DEFAULT_STORY_POINTS_FIELD,
        service_account_id: lookup.service_account_id,
        managed_field_ids: lookup.managed_field_ids,
      },
    });

    if (adapted.type === 'ping') {
      await this.integrations.markDelivery(lookup.tenant_id, lookup.integration_id, receivedAt);
      log.info('Webhook ping', { delivery_id: deliveryId });
      return { out: { status: 200, body: { ok: true, ping: true } }, signal: signal({ ping: true }) };
    }
    if (adapted.type === 'test') {
      // prueba de ida y vuelta de Jira (etiqueta magicode-healthcheck): no es un cambio real de la tarea
      await this.repo.update(keys.task(lookup.tenant_id, adapted.task_key), { set: { updated_at: receivedAt } }, { expression: 'attribute_exists(PK)' });
      await this.integrations.markDelivery(lookup.tenant_id, lookup.integration_id, receivedAt);
      log.info('Entrega de prueba (healthcheck)', { delivery_id: deliveryId });
      return { out: { status: 200, body: { ok: true, test: true } }, signal: signal({ jira_test: true }) };
    }
    if (adapted.type === 'ignored' && adapted.self) {
      // eco de nuestro propio write-back (anti-bucle): 200 para que Jira no lo marque como fallo
      await this.integrations.markDelivery(lookup.tenant_id, lookup.integration_id, receivedAt);
      log.info('Webhook propio ignorado (anti-bucle)', { delivery_id: deliveryId });
      return { out: { status: 200, body: { ok: true, ignored: 'self' } }, signal: signal() };
    }
    if (adapted.type === 'ignored') {
      await this.integrations.markDelivery(lookup.tenant_id, lookup.integration_id, receivedAt);
      log.info('Webhook ignorado', { delivery_id: deliveryId, event, reason: adapted.reason });
      return { out: { status: 202, body: { ok: true, ignored: true, reason: adapted.reason } }, signal: signal() };
    }

    const { accepted, rejectedReason } = this.scope(adapted.events, lookup);
    if (!accepted.length) {
      log.info('Webhook fuera del alcance de la integración', { delivery_id: deliveryId, reason: rejectedReason });
      return { out: { status: 202, body: { ok: true, ignored: true, reason: rejectedReason ?? 'out of scope' } }, signal: signal() };
    }

    const deliveryKey = `${provider}:${deliveryId}`;
    const kinds = [...new Set(accepted.map((e) => e.kind))];
    const fresh = await this.repo.putDelivery({
      tenant_id: lookup.tenant_id,
      delivery_key: deliveryKey,
      integration_id: lookup.integration_id,
      provider,
      received_at: receivedAt,
      kinds,
      now_epoch_s: Math.floor(at.getTime() / 1000),
    });
    if (!fresh) {
      log.info('Webhook duplicado', { delivery_id: deliveryId });
      return { out: { status: 200, body: { ok: true, duplicate: true } }, signal: signal({ kinds }) };
    }

    const ctx: ProjectionContext = {
      tenant_id: lookup.tenant_id,
      key_id: lookup.key_id,
      project_id: lookup.project_id,
      integration_id: lookup.integration_id,
      repository: lookup.repository,
      task_prefixes: await this.taskPrefixes(lookup),
      now: receivedAt,
    };
    try {
      const results = [];
      for (const ev of accepted) results.push(await this.projector.project(ev, ctx));
      await this.integrations.markDelivery(lookup.tenant_id, lookup.integration_id, receivedAt);
      // reglas de write-back (pr.opened, pr.merged, deployment.success, reference.marked); nunca lanza
      for (const tr of results.flatMap((r) => r.triggers ?? [])) {
        await this.fireTrigger(tr.trigger, { tenant_id: lookup.tenant_id, project_id: lookup.project_id, ...tr.input });
      }
      log.info('Webhook procesado', {
        delivery_id: deliveryId,
        kinds,
        task_keys: [...new Set(results.flatMap((r) => r.task_keys))].slice(0, 20),
        notes: results.map((r) => r.note).filter(Boolean),
      });
      return { out: { status: 200, body: { ok: true, processed: accepted.length, kinds } }, signal: signal({ kinds }) };
    } catch (err) {
      // se libera el dedupe para que el reintento del proveedor vuelva a intentarlo
      await this.repo.deleteDelivery(lookup.tenant_id, deliveryKey).catch(() => undefined);
      log.error('Fallo al proyectar webhook', err instanceof Error ? { name: err.name, message: err.message } : err);
      throw err;
    }
  }

  /**
   * Aislamiento extra: aunque la firma sea válida, solo se aceptan eventos del repositorio /
   * proyectos de tareas configurados en la integración (p. ej. un webhook de organización).
   */
  private scope(events: NormalizedWebhookEvent[], lookup: IntLookupItem) {
    let rejectedReason: string | undefined;
    const accepted = events.filter((e) => {
      if ('repository' in e && lookup.repository && !sameRepo(e.repository, lookup.repository)) {
        rejectedReason = `repository ${e.repository} is not ${lookup.repository}`;
        return false;
      }
      if ((e.kind === 'task.upserted' || e.kind === 'task.deleted') && lookup.task_project_keys?.length) {
        const prefix = e.task_key.split('-')[0]!;
        if (!lookup.task_project_keys.includes(prefix)) {
          rejectedReason = `task project ${prefix} not in ${lookup.task_project_keys.join(',')}`;
          return false;
        }
      }
      return true;
    });
    return { accepted, rejectedReason };
  }

  /** Prefijos de tareas del proyecto (integraciones Jira/Linear activas) para filtrar claves en commits/ramas. */
  private async taskPrefixes(lookup: IntLookupItem): Promise<string[] | null> {
    if (TaskProvider.safeParse(lookup.provider).success) return lookup.task_project_keys ?? null;
    if (!GitProvider.safeParse(lookup.provider).success) return null;
    const all = await this.integrations.listByTenant(lookup.tenant_id);
    const prefixes = all
      .filter((i) => i.project_id === lookup.project_id && i.status !== 'disabled')
      .flatMap((i) => i.task_project_keys ?? []);
    return prefixes.length ? [...new Set(prefixes)] : null;
  }
}

export const webhooksService = new WebhooksService();
