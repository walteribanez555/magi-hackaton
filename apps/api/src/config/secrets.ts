import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createLogger } from './logger';

const logger = createLogger('Secrets');
let client: SecretsManagerClient | undefined;
const sm = () => (client ??= new SecretsManagerClient({}));

/** Lee un secreto JSON de Secrets Manager. */
export async function getSecretJson<T = Record<string, unknown>>(arn: string): Promise<T> {
  const res = await sm().send(new GetSecretValueCommand({ SecretId: arn }));
  if (!res.SecretString) throw new Error(`Secret ${arn} exists but has no string value`);
  return JSON.parse(res.SecretString) as T;
}

/** APP_SECRET_ARN (opcional): JSON plano que se mezcla en process.env sin pisar lo existente. */
async function loadSecrets(): Promise<void> {
  const arn = process.env.APP_SECRET_ARN;
  if (!arn) {
    logger.debug('APP_SECRET_ARN not set — local dev mode');
    return;
  }
  const values = await getSecretJson<Record<string, string>>(arn);
  for (const [key, value] of Object.entries(values)) {
    if (!process.env[key]) process.env[key] = String(value);
  }
  logger.debug('Secrets loaded', { keys: Object.keys(values) });
}

// Si falla no se cachea el error: la siguiente petición reintenta.
let _ready: Promise<void> | null = null;

function ensureSecrets(): Promise<void> {
  if (!_ready) {
    _ready = loadSecrets().catch((error) => {
      _ready = null;
      logger.error('No se pudieron cargar los secretos; se reintentará en la próxima petición', error);
      throw error;
    });
  }
  return _ready;
}

export const waitForSecrets = (): Promise<void> => ensureSecrets();
