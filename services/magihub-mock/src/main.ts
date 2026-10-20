import { serve } from '@hono/node-server';
import { app } from './app';

const PORT = Number(process.env.PORT) || 4010;

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(
    JSON.stringify({
      level: 'info',
      msg: `⚠️  MagiHub SIMULADO escuchando en http://localhost:${info.port} (x-magihub-simulated: true)`,
      store: process.env.MOCK_TABLE_NAME ? `dynamodb:${process.env.MOCK_TABLE_NAME}` : 'memory',
    }),
  );
});
