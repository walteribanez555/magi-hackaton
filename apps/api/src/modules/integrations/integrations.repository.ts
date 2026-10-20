import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { keys } from '@magicode/contracts';
import { getDynamo, tableName } from '../../config/dynamo';
import type { IntegrationItem, IntLookupItem } from './integrations.types';

const isConditionalFailure = (err: unknown): boolean =>
  !!err &&
  typeof err === 'object' &&
  ['ConditionalCheckFailedException', 'TransactionCanceledException'].includes((err as { name?: string }).name ?? '');

/** Acceso a las filas Integration (por tenant) + IntLookup (por id, con el secreto). */
export class IntegrationsRepository {
  constructor(private readonly db: () => DynamoDBDocumentClient = getDynamo) {}

  /** Alta atómica de ambas filas; falla si el id ya existe (colisión prácticamente imposible). */
  async create(item: IntegrationItem, lookup: IntLookupItem): Promise<void> {
    await this.db().send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: tableName(), Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
          { Put: { TableName: tableName(), Item: lookup, ConditionExpression: 'attribute_not_exists(PK)' } },
        ],
      }),
    );
  }

  async listByTenant(tenantId: string): Promise<IntegrationItem[]> {
    const { PK } = keys.integration(tenantId, 'x');
    const out: IntegrationItem[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.db().send(
        new QueryCommand({
          TableName: tableName(),
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: { ':pk': PK, ':sk': 'INT#' },
          ExclusiveStartKey,
        }),
      );
      out.push(...((res.Items ?? []) as IntegrationItem[]));
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }

  async get(tenantId: string, integrationId: string): Promise<IntegrationItem | null> {
    const res = await this.db().send(
      new GetCommand({ TableName: tableName(), Key: keys.integration(tenantId, integrationId) }),
    );
    return (res.Item as IntegrationItem | undefined) ?? null;
  }

  /** Lectura consistente: el webhook necesita el secreto vigente justo después de rotarlo. */
  async getLookup(integrationId: string): Promise<IntLookupItem | null> {
    const res = await this.db().send(
      new GetCommand({
        TableName: tableName(),
        Key: keys.integrationLookup(integrationId),
        ConsistentRead: true,
      }),
    );
    return (res.Item as IntLookupItem | undefined) ?? null;
  }

  /** Deshabilita ambas filas (no se borran: auditoría + los datos ya proyectados siguen visibles). */
  async disable(tenantId: string, integrationId: string, at: string): Promise<boolean> {
    const values = { ':d': 'disabled', ':at': at, ':t': tenantId };
    try {
      await this.db().send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: tableName(),
                Key: keys.integration(tenantId, integrationId),
                UpdateExpression: 'SET #s = :d, disabled_at = :at, updated_at = :at',
                ConditionExpression: 'attribute_exists(PK)',
                ExpressionAttributeNames: { '#s': 'status' },
                ExpressionAttributeValues: { ':d': values[':d'], ':at': at },
              },
            },
            {
              Update: {
                TableName: tableName(),
                Key: keys.integrationLookup(integrationId),
                UpdateExpression: 'SET #s = :d, updated_at = :at',
                // el lookup debe pertenecer al MISMO tenant (aislamiento)
                ConditionExpression: 'attribute_exists(PK) AND tenant_id = :t',
                ExpressionAttributeNames: { '#s': 'status' },
                ExpressionAttributeValues: values,
              },
            },
          ],
        }),
      );
      return true;
    } catch (err) {
      if (isConditionalFailure(err)) return false;
      throw err;
    }
  }

  /** Sustituye el secreto (solo en IntLookup). Devuelve false si no existe / es de otro tenant / está deshabilitada. */
  async rotateSecret(tenantId: string, integrationId: string, secret: string, at: string): Promise<boolean> {
    try {
      await this.db().send(
        new UpdateCommand({
          TableName: tableName(),
          Key: keys.integrationLookup(integrationId),
          UpdateExpression: 'SET secret = :s, secret_rotated_at = :at, updated_at = :at',
          ConditionExpression: 'attribute_exists(PK) AND tenant_id = :t AND #s <> :d',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':s': secret, ':at': at, ':t': tenantId, ':d': 'disabled' },
        }),
      );
      return true;
    } catch (err) {
      if (isConditionalFailure(err)) return false;
      throw err;
    }
  }

  /** Tras una entrega válida: last_delivery_at + status active (salvo que se haya deshabilitado). */
  async markDelivery(tenantId: string, integrationId: string, at: string): Promise<void> {
    const update = (Key: Record<string, string>, withTime: boolean) =>
      this.db()
        .send(
          new UpdateCommand({
            TableName: tableName(),
            Key,
            UpdateExpression: withTime
              ? 'SET #s = :a, last_delivery_at = :at, updated_at = :at'
              : 'SET #s = :a, updated_at = :at',
            ConditionExpression: 'attribute_exists(PK) AND #s <> :d',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':a': 'active', ':d': 'disabled', ':at': at },
          }),
        )
        .catch((err) => {
          if (!isConditionalFailure(err)) throw err;
        });
    await Promise.all([
      update(keys.integration(tenantId, integrationId), true),
      update(keys.integrationLookup(integrationId), false),
    ]);
  }
}

export const integrationsRepository = new IntegrationsRepository();
