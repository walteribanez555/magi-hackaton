import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from 'aws-lambda';
import { config } from './config/config';
import { waitForSecrets } from './config/secrets';
import { processStreamBatch } from './modules/task-sync/task-sync.handler';

let configReloaded = false;

/**
 * Lambda task-sync: DynamoDB Streams (filtro entity=OutboxAction ∧ status=pending) → API de Jira/Linear.
 * Event source mapping: reportBatchItemFailures=true, batchSize pequeño (≤10), retryAttempts≈5.
 */
export const handler = async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
  await waitForSecrets();
  if (!configReloaded) {
    config.reload();
    configReloaded = true;
  }
  return processStreamBatch(event);
};
