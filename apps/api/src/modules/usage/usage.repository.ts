import { BatchWriteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { keys, type UsageGranularity } from '@magicode/contracts';
import { getDynamo, tableName } from '../../config/dynamo';
import { chunk } from '../../common/utils/dynamo-expr';
import type { UsageSnapshotItem, UsageSyncMarker } from './usage.types';

const markerKey = (t: string, keyId: string) => keys.usage(t, keyId, 'sync', 'latest');

/** UsageSnapshot items: PK T#{t}#K#{key}, SK U#{granularity}#{window_start}[#request_id]. */
export class UsageRepository {
  private get db() {
    return getDynamo();
  }
  private get table() {
    return tableName();
  }

  async getMarker(t: string, keyId: string): Promise<UsageSyncMarker | undefined> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: markerKey(t, keyId) }));
    return res.Item as UsageSyncMarker | undefined;
  }

  async putMarker(t: string, keyId: string, marker: UsageSyncMarker, now: string): Promise<void> {
    await this.db.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          ...markerKey(t, keyId),
          entity: 'UsageSnapshot',
          kind: 'sync-marker',
          tenant_id: t,
          key_id: keyId,
          ...marker,
          created_at: now,
          updated_at: now,
        },
      }),
    );
  }

  async putRecords(items: UsageSnapshotItem[]): Promise<void> {
    for (const part of chunk(items, 25)) {
      let pending = part.map((Item) => ({ PutRequest: { Item } }));
      for (let attempt = 0; pending.length && attempt < 6; attempt++) {
        const res = await this.db.send(new BatchWriteCommand({ RequestItems: { [this.table]: pending } }));
        pending = (res.UnprocessedItems?.[this.table] as typeof pending | undefined) ?? [];
        if (pending.length) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      }
      if (pending.length) throw new Error(`No se pudieron guardar ${pending.length} snapshots de usage`);
    }
  }

  async listRecords(t: string, keyId: string, granularity: UsageGranularity, from: string, to: string): Promise<UsageSnapshotItem[]> {
    const pk = keys.usage(t, keyId, granularity, '').PK;
    const out: UsageSnapshotItem[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await this.db.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'PK = :pk AND SK BETWEEN :a AND :b',
          ExpressionAttributeValues: { ':pk': pk, ':a': `U#${granularity}#${from}`, ':b': `U#${granularity}#${to}￿` },
          ExclusiveStartKey,
        }),
      );
      out.push(...((res.Items ?? []) as UsageSnapshotItem[]));
      ExclusiveStartKey = res.LastEvaluatedKey;
      if (!ExclusiveStartKey) break;
    }
    return out;
  }
}

export const usageRepository = new UsageRepository();
