import { handle } from 'hono/aws-lambda';
import { waitForSecrets } from './config/secrets';
import { config } from './config/config';
import { app } from './app';

const honoHandler = handle(app);

let configReloaded = false;

/** Lambda handler (API Gateway HTTP API v2 → Hono). */
export const handler = async (
  event: Parameters<typeof honoHandler>[0],
  context: Parameters<typeof honoHandler>[1],
) => {
  // 1. APP_SECRET_ARN (opcional) se mezcla en process.env en el cold start
  await waitForSecrets();
  // 2. La config se relee una vez con los secretos ya cargados
  if (!configReloaded) {
    config.reload();
    configReloaded = true;
  }
  return honoHandler(event, context);
};
