import { Pool } from 'pg';
import { config } from './config';
import { getSecretJson } from './secrets';
import { createLogger } from './logger';

const logger = createLogger('Database');

/** Formato del secreto que genera RDS (o el que adjunta CDK a la instancia). */
interface RdsSecret {
  host: string;
  port?: number | string;
  username: string;
  password: string;
  dbname?: string;
}

let pool: Pool | undefined;
let pending: Promise<Pool> | undefined;

/**
 * Pool de PostgreSQL (réplica analítica). Credenciales desde DB_SECRET_ARN (Lambda) o
 * DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME (local). SSL obligatorio salvo DB_SSL=false.
 */
export async function getPgPool(): Promise<Pool> {
  if (pool) return pool;
  pending ??= (async () => {
    const arn = config.getValue('dbSecretArn');
    const s: RdsSecret = arn
      ? await getSecretJson<RdsSecret>(arn)
      : {
          host: process.env.DB_HOST || 'localhost',
          port: process.env.DB_PORT || 5432,
          username: process.env.DB_USER || process.env.DB_USERNAME || 'postgres',
          password: process.env.DB_PASSWORD || process.env.DB_PASS || 'postgres',
          dbname: process.env.DB_NAME || 'magicode',
        };
    const sslOff = process.env.DB_SSL === 'false';
    const p = new Pool({
      host: s.host,
      port: Number(s.port ?? 5432),
      user: s.username,
      password: s.password,
      database: s.dbname || process.env.DB_NAME || 'postgres',
      max: Number(process.env.DB_POOL_MAX ?? 2),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // RDS exige TLS; no se valida la CA aquí (el tráfico va por la VPC).
      ssl: sslOff ? undefined : { rejectUnauthorized: false },
    });
    p.on('error', (err) => logger.error('Unexpected PG pool error', err));
    logger.info('PostgreSQL pool created', { host: s.host, db: s.dbname, ssl: !sslOff });
    pool = p;
    return p;
  })().catch((err) => {
    pending = undefined;
    throw err;
  });
  return pending;
}

export async function closePgPool(): Promise<void> {
  if (pool) await pool.end();
  pool = undefined;
  pending = undefined;
}
