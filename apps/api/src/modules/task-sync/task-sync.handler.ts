import type { DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';
import { createLogger } from '../../config/logger';
import { RetryableOutboxError, taskSyncService, type TaskSyncService } from './task-sync.service';

const logger = createLogger('TaskSyncHandler');

/** ¿El registro es una OutboxAction pendiente? (el filtro del event source mapping ya lo hace; esto es defensa). */
export function isPendingOutbox(record: DynamoDBRecord): boolean {
  if (record.eventName === 'REMOVE') return false;
  const img = record.dynamodb?.NewImage;
  return img?.entity?.S === 'OutboxAction' && img?.status?.S === 'pending' && !!record.dynamodb?.Keys?.PK?.S;
}

/**
 * Procesa el lote EN ORDEN (una transición antes que su comentario). Al primer error transitorio
 * se devuelve ese registro en batchItemFailures y se corta: Lambda reintenta desde ahí y los ya
 * procesados son no-op (su estado ya no es pending). Requiere `reportBatchItemFailures` en el mapping.
 */
export async function processStreamBatch(
  event: DynamoDBStreamEvent,
  service: Pick<TaskSyncService, 'processOutbox'> = taskSyncService,
): Promise<DynamoDBBatchResponse> {
  for (const record of event.Records ?? []) {
    if (!isPendingOutbox(record)) continue;
    const PK = record.dynamodb!.Keys!.PK!.S!;
    const SK = record.dynamodb!.Keys!.SK!.S!;
    try {
      await service.processOutbox({ PK, SK });
    } catch (err) {
      if (!(err instanceof RetryableOutboxError)) {
        logger.error('Error inesperado procesando OutboxAction', err instanceof Error ? { name: err.name, message: err.message } : err);
      }
      const id = record.dynamodb?.SequenceNumber;
      return { batchItemFailures: id ? [{ itemIdentifier: id }] : [] };
    }
  }
  return { batchItemFailures: [] };
}
