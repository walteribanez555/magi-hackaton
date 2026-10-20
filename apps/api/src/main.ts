try {
  process.loadEnvFile('.env');
} catch {
  /* .env es opcional */
}

import { serve } from '@hono/node-server';
import { app } from './app';
import { config, createLogger } from './config';

const logger = createLogger('Server');
const PORT = Number(process.env.PORT) || 3000;
config.reload();

serve({ fetch: app.fetch, port: PORT }, (info) => {
  const cfg = config.get();
  logger.info(`MagiCode API escuchando en http://localhost:${info.port}/api/v1`, {
    magihub: cfg.magihub.baseUrl,
    magihub_mode: cfg.magihub.mode,
    table: cfg.tableName,
    dynamo: cfg.dynamoEndpoint ?? 'aws',
  });
});
