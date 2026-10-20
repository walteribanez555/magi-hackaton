import { getPgPool } from './config/database';
import { createLogger } from './config/logger';
import { MIGRATIONS } from './orm/migrations';
import { MigrationRunner } from './orm/migration-runner';

const logger = createLogger('Migrator');

/**
 * Lambda de migraciones (CDK `triggers.Trigger` en cada deploy). Credenciales desde DB_SECRET_ARN.
 * El SQL va embebido en el bundle (src/orm/migrations.ts, generado desde migrations/*.sql).
 * Si falla, lanza → el deploy de CDK falla (no se publica una API con esquema viejo).
 */
export const handler = async (): Promise<{ applied: string[]; total: number }> => {
  const pool = await getPgPool();
  const client = await pool.connect();
  try {
    const applied = await new MigrationRunner(client, MIGRATIONS).up();
    logger.info('migrations done', { applied, total: MIGRATIONS.length });
    return { applied, total: MIGRATIONS.length };
  } finally {
    client.release();
  }
};
