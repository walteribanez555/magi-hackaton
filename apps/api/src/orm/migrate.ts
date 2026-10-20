try {
  process.loadEnvFile('.env');
} catch {
  /* .env es opcional */
}

import { getPgPool, closePgPool } from '../config/database';
import { MIGRATIONS } from './migrations';
import { MigrationRunner } from './migration-runner';

/**
 * CLI local: `npm run migrate -w @magicode/api [up|down|status]`.
 * Usa DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME (o DB_SECRET_ARN) y DB_SSL=false para docker local.
 */
async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'up';
  const pool = await getPgPool();
  const client = await pool.connect();
  try {
    const runner = new MigrationRunner(client, MIGRATIONS);
    if (cmd === 'down') {
      const v = await runner.down();
      console.log(v ? `Rolled back: ${v}` : 'Nothing to roll back');
    } else if (cmd === 'status') {
      for (const r of await runner.status()) console.log(`${r.applied ? '[x]' : '[ ]'} ${r.version}${r.drift ? '  DRIFT' : ''}`);
    } else {
      const done = await runner.up();
      console.log(done.length ? `Applied: ${done.join(', ')}` : 'No pending migrations');
    }
  } finally {
    client.release();
    await closePgPool();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
