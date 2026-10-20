import type { TokenUsage } from '@magicode/contracts';

/**
 * Registro de consumo por petición. `provider` = 'bedrock' ⇒ tokens REALES medidos por Bedrock;
 * ausente o 'mock' ⇒ SIMULADO (registros previos al modo bedrock no traen el campo).
 */
export interface StoredUsage {
  request_id: string;
  key_id: string;
  ts: string;
  model: string;
  usage: TokenUsage;
  /** undefined ⇒ sin precio conocido para el modelo */
  cost_usd?: number;
  provider?: 'bedrock' | 'mock';
  /** solo bedrock: modelo pedido ("smart-auto") y latencia de la llamada */
  requested_model?: string;
  latency_ms?: number;
}

export const isRealUsage = (r: StoredUsage): boolean => r.provider === 'bedrock';

export interface UsageStore {
  put(r: StoredUsage): Promise<void>;
  list(keyId: string, from: string, to: string): Promise<StoredUsage[]>;
}

/** En memoria (local / tests). Se pierde al reiniciar. */
export class MemoryUsageStore implements UsageStore {
  private readonly items: StoredUsage[] = [];
  async put(r: StoredUsage): Promise<void> {
    this.items.push(r);
  }
  async list(keyId: string, from: string, to: string): Promise<StoredUsage[]> {
    return this.items.filter((r) => r.key_id === keyId && r.ts >= from && r.ts <= to).sort((a, b) => a.ts.localeCompare(b.ts));
  }
}

/**
 * DynamoDB (Lambda): PK `MOCK#K#{key_id}`, SK `REQ#{ts}#{request_id}` en la tabla MOCK_TABLE_NAME
 * (puede ser la misma single-table: el prefijo MOCK# no choca con las entidades de MagiCode).
 * El SDK lo provee el runtime de Lambda; se carga de forma perezosa.
 */
export class DynamoUsageStore implements UsageStore {
  private doc: Promise<import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient> | undefined;
  private libs: Promise<typeof import('@aws-sdk/lib-dynamodb')> | undefined;

  constructor(private readonly table: string) {}

  private lib() {
    return (this.libs ??= import('@aws-sdk/lib-dynamodb'));
  }

  private client(): Promise<import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient> {
    this.doc ??= (async () => {
      const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
      const { DynamoDBDocumentClient } = await this.lib();
      const endpoint = process.env.DYNAMO_ENDPOINT;
      const raw = new DynamoDBClient({
        region: process.env.AWS_REGION || 'us-east-1',
        ...(endpoint ? { endpoint, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
      });
      return DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
    })();
    return this.doc;
  }

  async put(r: StoredUsage): Promise<void> {
    const { PutCommand } = await this.lib();
    await (await this.client()).send(
      new PutCommand({
        TableName: this.table,
        Item: { PK: `MOCK#K#${r.key_id}`, SK: `REQ#${r.ts}#${r.request_id}`, entity: 'MockUsage', simulated: !isRealUsage(r), ...r },
      }),
    );
  }

  async list(keyId: string, from: string, to: string): Promise<StoredUsage[]> {
    const { QueryCommand } = await this.lib();
    const out: StoredUsage[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await (await this.client()).send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'PK = :pk AND SK BETWEEN :a AND :b',
          ExpressionAttributeValues: { ':pk': `MOCK#K#${keyId}`, ':a': `REQ#${from}`, ':b': `REQ#${to}￿` },
          ExclusiveStartKey,
        }),
      );
      for (const it of res.Items ?? []) out.push(it as StoredUsage);
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }
}

export const createStore = (): UsageStore =>
  process.env.MOCK_TABLE_NAME ? new DynamoUsageStore(process.env.MOCK_TABLE_NAME) : new MemoryUsageStore();
