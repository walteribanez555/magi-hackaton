import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { ENTITY, keys, type OutboxStatus } from '@magicode/contracts';
import { getDynamo, tableName } from '../../config/dynamo';
import { isConditionalFailure } from '../webhooks/webhooks.repository';
import type { AutomationRuleItem, OutboxItem } from './task-sync.types';

export const IDEM_TTL_SECONDS = 7 * 24 * 3600;
/** Un "sending" sin terminar más viejo que esto se considera huérfano (Lambda caída) y se puede re-tomar. */
export const CLAIM_STALE_MS = 2 * 60_000;

const cancelledByCondition = (err: unknown, index: number): boolean => {
  const e = err as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  return e?.name === 'TransactionCanceledException' && e.CancellationReasons?.[index]?.Code === 'ConditionalCheckFailed';
};

export class TaskSyncRepository {
  constructor(private readonly db: () => DynamoDBDocumentClient = getDynamo) {}

  // ── Outbox ──────────────────────────────────────────────────────────────

  /**
   * Alta idempotente: ActionIdem (condicional, TTL 7 d) + OutboxAction en UNA transacción.
   * Si la clave ya existía devuelve la acción original (duplicate=true).
   */
  async enqueue(item: OutboxItem, nowEpochS: number): Promise<{ item: OutboxItem; duplicate: boolean }> {
    const idemKey = keys.actionIdem(item.tenant_id, item.idempotency_key);
    try {
      await this.db().send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName(),
                Item: {
                  ...idemKey,
                  entity: ENTITY.actionIdem,
                  tenant_id: item.tenant_id,
                  key_id: item.key_id,
                  action_id: item.action_id,
                  task_key: item.task_key,
                  outbox_pk: item.PK,
                  outbox_sk: item.SK,
                  created_at: item.created_at,
                  updated_at: item.created_at,
                  provenance: 'real',
                  expires_at: nowEpochS + IDEM_TTL_SECONDS,
                },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            { Put: { TableName: tableName(), Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
          ],
        }),
      );
      return { item, duplicate: false };
    } catch (err) {
      if (!cancelledByCondition(err, 0)) throw err;
      const idem = await this.db().send(new GetCommand({ TableName: tableName(), Key: idemKey, ConsistentRead: true }));
      const pk = idem.Item?.outbox_pk as string | undefined;
      const sk = idem.Item?.outbox_sk as string | undefined;
      const existing = pk && sk ? await this.getOutbox({ PK: pk, SK: sk }) : null;
      if (!existing) throw err;
      return { item: existing, duplicate: true };
    }
  }

  async getOutbox(key: { PK: string; SK: string }): Promise<OutboxItem | null> {
    const res = await this.db().send(new GetCommand({ TableName: tableName(), Key: key, ConsistentRead: true }));
    return (res.Item as OutboxItem | undefined) ?? null;
  }

  /** Auditoría de una tarea, más reciente primero. */
  async listActions(tenantId: string, taskKey: string, limit = 100): Promise<OutboxItem[]> {
    const res = await this.db().send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': keys.taskPk(tenantId, taskKey), ':sk': 'ACT#' },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (res.Items ?? []) as OutboxItem[];
  }

  /** pending → sending (o re-toma de un sending huérfano). false ⇒ otro worker la tiene / ya terminó. */
  async claim(item: OutboxItem, now: Date): Promise<OutboxItem | null> {
    const at = now.toISOString();
    try {
      const res = await this.db().send(
        new UpdateCommand({
          TableName: tableName(),
          Key: { PK: item.PK, SK: item.SK },
          UpdateExpression: 'SET #s = :sending, GSI1PK = :g, claimed_at = :at, updated_at = :at ADD attempts :one',
          ConditionExpression: '#s = :pending OR (#s = :sending AND claimed_at < :stale)',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':sending': 'sending',
            ':pending': 'pending',
            ':g': keys.outboxGsi1(item.tenant_id, 'sending', item.created_at).GSI1PK,
            ':at': at,
            ':one': 1,
            ':stale': new Date(now.getTime() - CLAIM_STALE_MS).toISOString(),
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return (res.Attributes as OutboxItem | undefined) ?? null;
    } catch (err) {
      if (isConditionalFailure(err)) return null;
      throw err;
    }
  }

  /** Cierra el intento: sent | skipped | failed | pending (reintento). Mueve también el GSI1 de estado. */
  async finish(
    item: OutboxItem,
    status: OutboxStatus,
    patch: { result?: Record<string, unknown> | null; last_error?: string | null },
    now: Date,
  ): Promise<void> {
    const at = now.toISOString();
    const values: Record<string, unknown> = {
      ':s': status,
      ':g': keys.outboxGsi1(item.tenant_id, status, item.created_at).GSI1PK,
      ':at': at,
      ':sending': 'sending',
    };
    const sets = ['#s = :s', 'GSI1PK = :g', 'updated_at = :at'];
    if (patch.result !== undefined) {
      sets.push('#r = :r');
      values[':r'] = patch.result;
    }
    if (patch.last_error !== undefined) {
      sets.push('last_error = :e');
      values[':e'] = patch.last_error;
    }
    await this.db().send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { PK: item.PK, SK: item.SK },
        UpdateExpression: `SET ${sets.join(', ')} REMOVE claimed_at`,
        ConditionExpression: '#s = :sending',
        ExpressionAttributeNames: { '#s': 'status', ...(patch.result !== undefined ? { '#r': 'result' } : {}) },
        ExpressionAttributeValues: values,
      }),
    );
  }

  /** Refleja localmente el estado resultante de una transición hecha por MagiCode (su webhook se ignora por anti-bucle). */
  async setTaskStatus(tenantId: string, taskKey: string, status: string, category: string, at: string): Promise<void> {
    try {
      await this.db().send(
        new UpdateCommand({
          TableName: tableName(),
          Key: keys.task(tenantId, taskKey),
          UpdateExpression: 'SET #s = :s, status_category = :c, updated_at = :at, status_set_by = :by',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':s': status, ':c': category, ':at': at, ':by': 'magicode' },
        }),
      );
    } catch (err) {
      if (!isConditionalFailure(err)) throw err;
    }
  }

  // ── Reglas ──────────────────────────────────────────────────────────────

  async listRules(tenantId: string, integrationId: string): Promise<AutomationRuleItem[]> {
    const { PK } = keys.automationRule(tenantId, integrationId, 'x');
    const res = await this.db().send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': PK, ':sk': 'RULE#' },
      }),
    );
    return (res.Items ?? []) as AutomationRuleItem[];
  }

  async getRule(tenantId: string, integrationId: string, ruleId: string): Promise<AutomationRuleItem | null> {
    const res = await this.db().send(
      new GetCommand({ TableName: tableName(), Key: keys.automationRule(tenantId, integrationId, ruleId) }),
    );
    return (res.Item as AutomationRuleItem | undefined) ?? null;
  }

  async putRule(item: AutomationRuleItem, mustExist: boolean): Promise<boolean> {
    try {
      await this.db().send(
        new PutCommand({
          TableName: tableName(),
          Item: item,
          ConditionExpression: mustExist ? 'attribute_exists(PK)' : 'attribute_not_exists(PK)',
        }),
      );
      return true;
    } catch (err) {
      if (isConditionalFailure(err)) return false;
      throw err;
    }
  }

  async deleteRule(tenantId: string, integrationId: string, ruleId: string): Promise<boolean> {
    try {
      await this.db().send(
        new DeleteCommand({
          TableName: tableName(),
          Key: keys.automationRule(tenantId, integrationId, ruleId),
          ConditionExpression: 'attribute_exists(PK)',
        }),
      );
      return true;
    } catch (err) {
      if (isConditionalFailure(err)) return false;
      throw err;
    }
  }

  // ── Integración (credenciales) ──────────────────────────────────────────

  /** Guarda en IntLookup la cuenta de servicio (anti-bucle) y los campos gestionados; marca la Integration. */
  async markCredentials(
    tenantId: string,
    integrationId: string,
    input: { service_account_id?: string; managed_field_ids: string[]; base_url?: string },
    at: string,
  ): Promise<void> {
    await this.db().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName(),
              Key: keys.integrationLookup(integrationId),
              UpdateExpression:
                'SET managed_field_ids = :m, credentials_configured_at = :at, updated_at = :at' +
                (input.service_account_id ? ', service_account_id = :a' : '') +
                (input.base_url ? ', base_url = if_not_exists(base_url, :b)' : ''),
              ConditionExpression: 'attribute_exists(PK) AND tenant_id = :t',
              ExpressionAttributeValues: {
                ...(input.service_account_id ? { ':a': input.service_account_id } : {}),
                ':m': input.managed_field_ids,
                ':at': at,
                ':t': tenantId,
                ...(input.base_url ? { ':b': input.base_url } : {}),
              },
            },
          },
          {
            Update: {
              TableName: tableName(),
              Key: keys.integration(tenantId, integrationId),
              UpdateExpression: 'SET credentials_configured_at = :at, updated_at = :at',
              ConditionExpression: 'attribute_exists(PK)',
              ExpressionAttributeValues: { ':at': at },
            },
          },
        ],
      }),
    );
  }
}

export const taskSyncRepository = new TaskSyncRepository();
