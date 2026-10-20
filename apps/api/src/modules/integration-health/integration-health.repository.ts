import { ENTITY, keys } from '@magicode/contracts';
import { webhooksRepository, type Item, type WebhooksRepository } from '../webhooks/webhooks.repository';
import type { DeliveryOutcome, HealthBucketItem, IntHealthItem, PendingTest, TestRunItem } from './integration-health.types';

export const BUCKET_TTL_SECONDS = 3 * 24 * 3600;
export const TEST_TTL_SECONDS = 30 * 24 * 3600;

/** 2026-10-20T20:15:00Z → 2026-10-20T20 */
export const hourOf = (iso: string): string => iso.slice(0, 13);

export class IntegrationHealthRepository {
  constructor(private readonly store: WebhooksRepository = webhooksRepository) {}

  private pk(t: string, id: string) {
    return keys.integrationHealth(t, id).PK;
  }

  /**
   * Contabiliza UNA entrega: contador horario (ADD atómico, TTL 3 d) + último estado en IntHealth.
   * Nunca guarda el cuerpo ni el secreto; `error` es un texto corto generado por nosotros.
   */
  async recordDelivery(input: {
    tenant_id: string;
    integration_id: string;
    outcome: DeliveryOutcome;
    at: string;
    event?: string;
    error?: string;
  }): Promise<void> {
    const { tenant_id: t, integration_id: id, outcome, at } = input;
    const hour = hourOf(at);
    const validSignature = outcome === 'accepted' || outcome === 'duplicate' || outcome === 'ignored';
    const set: Record<string, unknown> = {
      entity: ENTITY.integrationHealth,
      tenant_id: t,
      integration_id: id,
      last_delivery_at: at,
      updated_at: at,
      ...(validSignature ? { last_valid_delivery_at: at } : {}),
      ...(outcome === 'accepted' ? { last_accepted_at: at } : {}),
      ...(outcome === 'rejected_signature' ? { last_rejected_signature_at: at } : {}),
      ...(input.error ? { last_error: input.error.slice(0, 300), last_error_at: at } : {}),
      ...(input.event && validSignature ? { [`last_event_at:${input.event.slice(0, 80)}`]: at } : {}),
    };
    await Promise.all([
      this.store.update(
        { PK: this.pk(t, id), SK: `HEALTH#H#${hour}` },
        {
          set: { entity: 'IntHealthBucket', tenant_id: t, integration_id: id, hour, updated_at: at },
          setIfNotExists: { expires_at: Math.floor(Date.parse(`${hour}:00:00.000Z`) / 1000) + BUCKET_TTL_SECONDS },
          add: { [outcome]: 1 },
        },
      ),
      this.store.update(keys.integrationHealth(t, id), { set, setIfNotExists: { created_at: at, provenance: 'real' } }),
    ]);
  }

  async getHealth(t: string, id: string): Promise<IntHealthItem | null> {
    return (await this.store.get(keys.integrationHealth(t, id))) as IntHealthItem | null;
  }

  async buckets(t: string, id: string): Promise<HealthBucketItem[]> {
    return this.store.queryPrefix<HealthBucketItem>(this.pk(t, id), 'HEALTH#H#', { limit: 200 });
  }

  async saveProviderChecks(t: string, id: string, checks: unknown[], at: string): Promise<void> {
    await this.store.update(keys.integrationHealth(t, id), {
      set: { entity: ENTITY.integrationHealth, tenant_id: t, integration_id: id, provider_checks: checks, checked_at: at, updated_at: at },
      setIfNotExists: { created_at: at, provenance: 'real' },
    });
  }

  async setLastTest(t: string, id: string, last: { test_id: string; status: string; finished_at: string | null }, at: string): Promise<void> {
    await this.store.update(keys.integrationHealth(t, id), {
      set: { entity: ENTITY.integrationHealth, tenant_id: t, integration_id: id, last_test: last, updated_at: at },
      setIfNotExists: { created_at: at, provenance: 'real' },
    });
  }

  // ── pruebas de ida y vuelta ───────────────────────────────────────────────

  async putTest(run: TestRunItem): Promise<void> {
    const { PK, SK, ...rest } = run;
    await this.store.update({ PK, SK }, { set: rest as Record<string, unknown> });
  }

  async updateTest(key: { PK: string; SK: string }, set: Partial<TestRunItem>): Promise<void> {
    await this.store.update(key, { set: set as Record<string, unknown> });
  }

  async tests(t: string, id: string, limit = 20): Promise<TestRunItem[]> {
    return this.store.queryPrefix<TestRunItem>(this.pk(t, id), 'TEST#', { desc: true, limit });
  }

  async getTest(t: string, id: string, sk: string): Promise<TestRunItem | null> {
    return (await this.store.get({ PK: this.pk(t, id), SK: sk })) as TestRunItem | null;
  }

  /** La prueba pendiente vive en IntLookup para que el webhook la vea sin lecturas extra. */
  async setPendingTest(integrationId: string, pending: PendingTest): Promise<void> {
    await this.store.update(keys.integrationLookup(integrationId), { set: { pending_test: pending } }, { expression: 'attribute_exists(PK)' });
  }

  /** Limpia la prueba pendiente SOLO si sigue siendo la misma (otra prueba más nueva no se pisa). */
  async clearPendingTest(integrationId: string, testId: string): Promise<boolean> {
    return this.store.update(
      keys.integrationLookup(integrationId),
      { set: { pending_test: null } },
      { expression: 'pending_test.test_id = :tid', values: { ':tid': testId } },
    );
  }

  async setProviderHookId(integrationId: string, hookId: string, at: string): Promise<void> {
    await this.store.update(keys.integrationLookup(integrationId), { set: { provider_hook_id: hookId, updated_at: at } }, { expression: 'attribute_exists(PK)' });
  }

  // ── datos para checks de reconciliación ──────────────────────────────────

  commitsOf(t: string, repository: string): Promise<Item[]> {
    return this.store.queryPrefix(keys.repoPk(t, repository), 'COMMIT#', { limit: 2000 });
  }

  sessionsOf(t: string, project: string): Promise<Item[]> {
    return this.store.queryPrefix(keys.sessionGsi1(t, project, '', '').GSI1PK, 'S#', { index: 'GSI1', desc: true, limit: 500 });
  }

  branchesOf(t: string, project: string): Promise<Item[]> {
    return this.store.queryPrefix(keys.branchGsi1(t, project, '').GSI1PK, 'BRANCH#', { index: 'GSI1', desc: true, limit: 1000 });
  }

  tasksByKeys(t: string, taskKeys: string[]): Promise<Item[]> {
    return this.store.batchGet(taskKeys.map((k) => keys.task(t, k)));
  }
}

export const integrationHealthRepository = new IntegrationHealthRepository();
