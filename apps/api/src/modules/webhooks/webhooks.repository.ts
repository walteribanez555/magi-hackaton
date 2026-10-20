import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { ENTITY, keys } from '@magicode/contracts';
import { getDynamo, tableName } from '../../config/dynamo';
import { buildUpdate, chunk, type UpdateSpec } from '../../common/utils/dynamo-expr';

export type Key = { PK: string; SK: string };
export type Item = Record<string, unknown>;

export const DELIVERY_TTL_SECONDS = 30 * 24 * 3600;

export const isConditionalFailure = (err: unknown): boolean =>
  !!err && typeof err === 'object' && (err as { name?: string }).name === 'ConditionalCheckFailedException';

/** Operaciones DynamoDB que usa la proyección de webhooks (sin lógica de negocio). */
export class WebhooksRepository {
  constructor(private readonly db: () => DynamoDBDocumentClient = getDynamo) {}

  /** Dedupe por delivery id: true si es nueva, false si ya se había recibido. */
  async putDelivery(input: {
    tenant_id: string;
    delivery_key: string;
    integration_id: string;
    provider: string;
    received_at: string;
    kinds: string[];
    now_epoch_s: number;
  }): Promise<boolean> {
    try {
      await this.db().send(
        new PutCommand({
          TableName: tableName(),
          Item: {
            ...keys.webhookDelivery(input.tenant_id, input.delivery_key),
            entity: ENTITY.webhookDelivery,
            tenant_id: input.tenant_id,
            integration_id: input.integration_id,
            provider: input.provider,
            kinds: input.kinds,
            received_at: input.received_at,
            created_at: input.received_at,
            updated_at: input.received_at,
            provenance: 'real',
            expires_at: input.now_epoch_s + DELIVERY_TTL_SECONDS,
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
      return true;
    } catch (err) {
      if (isConditionalFailure(err)) return false;
      throw err;
    }
  }

  /** Si la proyección falla se borra el dedupe para que el reintento del proveedor sí se procese. */
  async deleteDelivery(tenantId: string, deliveryKey: string): Promise<void> {
    await this.db().send(new DeleteCommand({ TableName: tableName(), Key: keys.webhookDelivery(tenantId, deliveryKey) }));
  }

  async get(key: Key): Promise<Item | null> {
    const res = await this.db().send(new GetCommand({ TableName: tableName(), Key: key }));
    return (res.Item as Item | undefined) ?? null;
  }

  async batchGet<T = Item>(keyList: Key[]): Promise<T[]> {
    const unique = [...new Map(keyList.map((k) => [`${k.PK}|${k.SK}`, k])).values()];
    const out: T[] = [];
    for (const part of chunk(unique, 100)) {
      let request: Record<string, { Keys: Key[] }> | undefined = { [tableName()]: { Keys: part } };
      for (let attempt = 0; request && attempt < 5; attempt++) {
        const res = await this.db().send(new BatchGetCommand({ RequestItems: request }));
        out.push(...((res.Responses?.[tableName()] ?? []) as T[]));
        const left = res.UnprocessedKeys?.[tableName()]?.Keys as Key[] | undefined;
        request = left?.length ? { [tableName()]: { Keys: left } } : undefined;
      }
    }
    return out;
  }

  /**
   * UpdateItem con el builder compartido. `condition` usa sus propios placeholders (#c*, :c*).
   * Devuelve false si la condición falló (el llamador decide si es "obsoleto/inexistente").
   */
  async update(
    key: Key,
    spec: UpdateSpec,
    condition?: { expression: string; names?: Record<string, string>; values?: Record<string, unknown> },
  ): Promise<boolean> {
    const u = buildUpdate(spec);
    if (!u.UpdateExpression) return true;
    try {
      await this.db().send(
        new UpdateCommand({
          TableName: tableName(),
          Key: key,
          UpdateExpression: u.UpdateExpression,
          ExpressionAttributeNames: { ...u.ExpressionAttributeNames, ...(condition?.names ?? {}) },
          ExpressionAttributeValues: { ...u.ExpressionAttributeValues, ...(condition?.values ?? {}) },
          ...(condition ? { ConditionExpression: condition.expression } : {}),
        }),
      );
      return true;
    } catch (err) {
      if (condition && isConditionalFailure(err)) return false;
      throw err;
    }
  }

  /** Query por PK + prefijo de SK (paginado, con tope). */
  async queryPrefix<T = Item>(
    pk: string,
    skPrefix: string,
    opts: { index?: 'GSI1'; limit?: number; desc?: boolean } = {},
  ): Promise<T[]> {
    const pkName = opts.index ? 'GSI1PK' : 'PK';
    const skName = opts.index ? 'GSI1SK' : 'SK';
    const max = opts.limit ?? 1000;
    const out: T[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.db().send(
        new QueryCommand({
          TableName: tableName(),
          ...(opts.index ? { IndexName: opts.index } : {}),
          KeyConditionExpression: `${pkName} = :pk AND begins_with(${skName}, :sk)`,
          ExpressionAttributeValues: { ':pk': pk, ':sk': skPrefix },
          ScanIndexForward: !opts.desc,
          ExclusiveStartKey,
        }),
      );
      out.push(...((res.Items ?? []) as T[]));
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey && out.length < max);
    return out.slice(0, max);
  }
}

export const webhooksRepository = new WebhooksRepository();
