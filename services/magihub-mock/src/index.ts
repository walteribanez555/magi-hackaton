import { handle } from 'hono/aws-lambda';
import { app } from './app';

/** Lambda handler del adaptador MagiHub (Function URL o HTTP API v2). MAGIHUB_PROVIDER=bedrock|mock; usage en DynamoDB si MOCK_TABLE_NAME. */
export const handler = handle(app);
