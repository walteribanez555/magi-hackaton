import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { getPgPool } from './config/database';
import { createLogger } from './config/logger';
import { mapItem, upsertSql } from './projector/projector.mapper';

const logger = createLogger('Projector');

/**
 * DynamoDB Streams (NEW_AND_OLD_IMAGES) → PostgreSQL (réplica analítica en RDS).
 * - UPSERT idempotente por PK de cada tabla y guardado por updated_at (reintentos/desorden no corrompen).
 * - Se omiten EventDedupe y RawEvent (y entidades sin tabla). Los REMOVE (TTL) se ignoran.
 * - Requiere `reportBatchItemFailures` en el event source mapping: se corta en el primer fallo y se
 *   reporta su SequenceNumber para que Lambda reintente desde ahí, manteniendo el orden.
 */
export const handler = async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
  const pool = await getPgPool();
  let upserted = 0;
  let skipped = 0;
  for (const record of event.Records) {
    try {
      if (record.eventName === 'REMOVE' || !record.dynamodb?.NewImage) {
        skipped++;
        continue;
      }
      const item = unmarshall(record.dynamodb.NewImage as Record<string, AttributeValue>);
      const row = mapItem(item);
      if (!row) {
        skipped++;
        continue;
      }
      const { text, values } = upsertSql(row);
      await pool.query(text, values);
      upserted++;
    } catch (err) {
      logger.error('projector record failed', { eventID: record.eventID, seq: record.dynamodb?.SequenceNumber, err });
      const id = record.dynamodb?.SequenceNumber ?? record.eventID ?? '';
      logger.info('projector batch partial', { upserted, skipped });
      return { batchItemFailures: [{ itemIdentifier: id }] };
    }
  }
  logger.info('projector batch', { records: event.Records.length, upserted, skipped });
  return { batchItemFailures: [] };
};
