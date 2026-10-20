import { randomBytes } from 'node:crypto';
import {
  GitProvider,
  IntegrationCreate,
  keys,
  type Integration,
  type IntegrationCreated,
  type IntegrationProvider,
} from '@magicode/contracts';
import { createLogger } from '../../config/logger';
import { NotFoundException } from '../../common/exceptions';
import { integrationsRepository, type IntegrationsRepository } from './integrations.repository';
import type { CallerScope, IntegrationItem, IntLookupItem } from './integrations.types';

const logger = createLogger('IntegrationsService');

export const newIntegrationId = (): string => `int_${randomBytes(8).toString('hex')}`;
export const newWebhookSecret = (): string => randomBytes(32).toString('hex');

/**
 * "org/repo" canónico: acepta también la URL del repo (https/ssh, con o sin .git).
 * Se conserva la capitalización escrita por el usuario (debe coincidir con el `repository` que
 * reporta la extensión); la comparación con el payload del webhook es case-insensitive.
 */
export function normalizeRepository(input: string): string {
  let r = input.trim();
  r = r.replace(/^[a-z]+:\/\/[^/]+\//i, ''); // https://github.com/org/repo
  r = r.replace(/^[^@\s]+@[^:]+:/, ''); // git@github.com:org/repo
  r = r.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  return r;
}

/** Base pública de la API: PUBLIC_API_URL (infra) o el origen de la petición. */
export function publicBaseUrl(requestOrigin?: string): string {
  const env = process.env.PUBLIC_API_URL?.trim();
  return (env || requestOrigin || '').replace(/\/+$/, '');
}

export const webhookUrlFor = (base: string, provider: IntegrationProvider, integrationId: string): string =>
  `${base}/api/v1/webhooks/${provider}/${integrationId}`;

/** Vista pública (contrato `Integration`): sin claves Dynamo, sin secreto, sin metadatos internos. */
export function toIntegration(item: IntegrationItem): Integration {
  return {
    integration_id: item.integration_id,
    tenant_id: item.tenant_id,
    project_id: item.project_id,
    provider: item.provider,
    ...(item.repository ? { repository: item.repository } : {}),
    ...(item.task_project_keys ? { task_project_keys: item.task_project_keys } : {}),
    webhook_url: item.webhook_url,
    status: item.status,
    last_delivery_at: item.last_delivery_at ?? null,
    created_at: item.created_at,
  };
}

export class IntegrationsService {
  constructor(
    private readonly repo: IntegrationsRepository = integrationsRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(scope: CallerScope, body: unknown, requestOrigin?: string): Promise<IntegrationCreated> {
    const input = IntegrationCreate.parse(body);
    const at = this.now().toISOString();
    const integrationId = newIntegrationId();
    const secret = newWebhookSecret();
    const webhook_url = webhookUrlFor(publicBaseUrl(requestOrigin), input.provider, integrationId);

    const isGit = GitProvider.safeParse(input.provider).success;
    const repository = 'repository' in input ? normalizeRepository(input.repository) : undefined;
    const task_project_keys = 'task_project_keys' in input ? [...new Set(input.task_project_keys)] : undefined;
    const base_url = 'base_url' in input && input.base_url ? input.base_url.replace(/\/+$/, '') : undefined;

    const common = {
      integration_id: integrationId,
      tenant_id: scope.tenant_id,
      key_id: scope.key_id,
      project_id: input.project_id,
      provider: input.provider,
      ...(isGit ? { repository } : { task_project_keys }),
      ...(base_url ? { base_url } : {}),
      status: 'pending' as const,
      created_at: at,
      updated_at: at,
    };
    const item: IntegrationItem = {
      ...keys.integration(scope.tenant_id, integrationId),
      entity: 'Integration',
      ...common,
      webhook_url,
      last_delivery_at: null,
      provenance: 'real',
    };
    const lookup: IntLookupItem = {
      ...keys.integrationLookup(integrationId),
      SK: 'META',
      entity: 'IntLookup',
      ...common,
      secret,
    };
    await this.repo.create(item, lookup);
    logger.info('Integración creada', {
      tenant_id: scope.tenant_id,
      integration_id: integrationId,
      provider: input.provider,
      project_id: input.project_id,
    });
    // El secreto se devuelve UNA sola vez; no hay endpoint para volver a leerlo.
    return { ...toIntegration(item), webhook_secret: secret };
  }

  async list(tenantId: string, projectId?: string): Promise<Integration[]> {
    const items = await this.repo.listByTenant(tenantId);
    return items
      .filter((i) => !projectId || i.project_id === projectId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(toIntegration);
  }

  async disable(tenantId: string, integrationId: string): Promise<Integration> {
    const at = this.now().toISOString();
    const ok = await this.repo.disable(tenantId, integrationId, at);
    if (!ok) throw new NotFoundException('Integración no encontrada', 'INTEGRATION_NOT_FOUND');
    const item = await this.repo.get(tenantId, integrationId);
    if (!item) throw new NotFoundException('Integración no encontrada', 'INTEGRATION_NOT_FOUND');
    logger.info('Integración deshabilitada', { tenant_id: tenantId, integration_id: integrationId });
    return toIntegration(item);
  }

  async rotateSecret(tenantId: string, integrationId: string): Promise<IntegrationCreated> {
    const item = await this.repo.get(tenantId, integrationId);
    if (!item || item.status === 'disabled') {
      throw new NotFoundException('Integración no encontrada o deshabilitada', 'INTEGRATION_NOT_FOUND');
    }
    const secret = newWebhookSecret();
    const ok = await this.repo.rotateSecret(tenantId, integrationId, secret, this.now().toISOString());
    if (!ok) throw new NotFoundException('Integración no encontrada o deshabilitada', 'INTEGRATION_NOT_FOUND');
    logger.info('Secreto de webhook rotado', { tenant_id: tenantId, integration_id: integrationId });
    return { ...toIntegration(item), webhook_secret: secret };
  }
}

export const integrationsService = new IntegrationsService();
