import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { config } from './config';

let doc: DynamoDBDocumentClient | undefined;

/** DynamoDBDocumentClient singleton (reutilizado entre invocaciones warm). */
export function getDynamo(): DynamoDBDocumentClient {
  if (doc) return doc;
  const { region, dynamoEndpoint } = config.get();
  const local = !!dynamoEndpoint;
  const client = new DynamoDBClient({
    region,
    ...(local
      ? {
          endpoint: dynamoEndpoint,
          // dynamodb-local acepta cualquier credencial
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'local',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'local',
          },
        }
      : {}),
  });
  doc = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true, convertEmptyValues: false },
  });
  return doc;
}

export const tableName = (): string => config.getValue('tableName');

/** Solo tests: reinicia el singleton. */
export function resetDynamo(): void {
  doc = undefined;
}
