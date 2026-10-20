import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import { GitProviderCredentials, TaskProviderCredentials } from '@magicode/contracts';
import { config } from '../../config/config';

/** `magicode/<APP_ENV>/integrations/<integration_id>` — una entrada por integración. */
export const secretNameFor = (integrationId: string): string =>
  `magicode/${process.env.APP_ENV || config.getValue('environment')}/integrations/${integrationId}`;

const CACHE_TTL_MS = 5 * 60_000;

/** Credenciales de cualquier proveedor: gestor de tareas (write-back) o git (verificar/registrar webhook). */
export const ProviderCredentials = z.union([TaskProviderCredentials, GitProviderCredentials]);
export type ProviderCredentials = z.infer<typeof ProviderCredentials>;

export const isTaskCredentials = (c: ProviderCredentials): c is TaskProviderCredentials => c.provider === 'jira' || c.provider === 'linear';

/**
 * Credenciales del proveedor (gestor de tareas o git) en Secrets Manager (nunca en DynamoDB, logs ni respuestas).
 * Caché en memoria por contenedor (5 min) para no pagar un GetSecretValue por acción.
 */
export class CredentialsStore {
  private client?: SecretsManagerClient;
  private readonly cache = new Map<string, { value: ProviderCredentials; expiresAt: number }>();

  constructor(
    private readonly makeClient: () => SecretsManagerClient = () => new SecretsManagerClient({ region: config.getValue('region') }),
    private readonly now: () => number = Date.now,
  ) {}

  private sm(): SecretsManagerClient {
    return (this.client ??= this.makeClient());
  }

  async save(integrationId: string, tenantId: string, creds: ProviderCredentials): Promise<void> {
    const SecretId = secretNameFor(integrationId);
    const SecretString = JSON.stringify(creds);
    try {
      await this.sm().send(new PutSecretValueCommand({ SecretId, SecretString }));
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException) && (err as { name?: string })?.name !== 'ResourceNotFoundException') throw err;
      await this.sm().send(
        new CreateSecretCommand({
          Name: SecretId,
          SecretString,
          Description: 'MagiCode: credenciales del proveedor (webhooks / write-back)',
          Tags: [
            { Key: 'app', Value: 'magicode' },
            { Key: 'tenant_id', Value: tenantId.slice(0, 250) },
            { Key: 'integration_id', Value: integrationId },
          ],
        }),
      );
    }
    this.cache.set(integrationId, { value: creds, expiresAt: this.now() + CACHE_TTL_MS });
  }

  /** null si la integración no tiene credenciales guardadas. */
  async get(integrationId: string): Promise<ProviderCredentials | null> {
    const hit = this.cache.get(integrationId);
    if (hit && hit.expiresAt > this.now()) return hit.value;
    try {
      const res = await this.sm().send(new GetSecretValueCommand({ SecretId: secretNameFor(integrationId) }));
      if (!res.SecretString) return null;
      const value = ProviderCredentials.parse(JSON.parse(res.SecretString));
      this.cache.set(integrationId, { value, expiresAt: this.now() + CACHE_TTL_MS });
      return value;
    } catch (err) {
      if (err instanceof ResourceNotFoundException || (err as { name?: string })?.name === 'ResourceNotFoundException') return null;
      throw err;
    }
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export const credentialsStore = new CredentialsStore();
