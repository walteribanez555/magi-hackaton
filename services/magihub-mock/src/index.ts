import { handle } from 'hono/aws-lambda';
import { app } from './app';

/** Lambda handler del MagiHub SIMULADO (API Gateway HTTP API v2). Usage en DynamoDB si MOCK_TABLE_NAME. */
export const handler = handle(app);
