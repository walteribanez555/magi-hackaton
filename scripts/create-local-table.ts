/**
 * Crea la single-table de MagiCode en dynamodb-local, EXACTAMENTE como en packages/contracts/src/keys.ts:
 * PK/SK (S) · GSI1 (GSI1PK, GSI1SK; projection ALL) · Stream NEW_AND_OLD_IMAGES · TTL `expires_at`.
 *
 *   DYNAMO_ENDPOINT=http://localhost:8000 TABLE_NAME=magicode-dev-productivity npx tsx scripts/create-local-table.ts
 *   (--recreate borra y vuelve a crear)
 */
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';

const endpoint = process.env.DYNAMO_ENDPOINT || 'http://localhost:8000';
const TableName = process.env.TABLE_NAME || 'magicode-dev-productivity';
const recreate = process.argv.includes('--recreate');

const client = new DynamoDBClient({
  endpoint,
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

async function exists(): Promise<boolean> {
  try {
    await client.send(new DescribeTableCommand({ TableName }));
    return true;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return false;
    throw err;
  }
}

async function main(): Promise<void> {
  if (await exists()) {
    if (!recreate) {
      console.log(`✓ La tabla ${TableName} ya existe en ${endpoint} (usa --recreate para recrearla)`);
      return;
    }
    await client.send(new DeleteTableCommand({ TableName }));
    console.log(`… borrada ${TableName}`);
  }
  await client.send(
    new CreateTableCommand({
      TableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'GSI1PK', AttributeType: 'S' },
        { AttributeName: 'GSI1SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
      StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' },
    }),
  );
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName });
  try {
    await client.send(new UpdateTimeToLiveCommand({ TableName, TimeToLiveSpecification: { Enabled: true, AttributeName: 'expires_at' } }));
  } catch {
    /* dynamodb-local acepta TTL pero no lo ejecuta */
  }
  console.log(`✓ Creada ${TableName} en ${endpoint} (PK/SK, GSI1, stream NEW_AND_OLD_IMAGES, TTL expires_at)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
