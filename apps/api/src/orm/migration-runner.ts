import { createHash } from 'node:crypto';
import type { ClientBase } from 'pg';
import type { EmbeddedMigration } from './migrations';

const UP = '-- migrate:up';
const DOWN = '-- migrate:down';
/** Lock global para que dos deploys/migradores no corran a la vez. */
const ADVISORY_LOCK = 774_211_001;

export function parseMigration(sql: string): { up: string; down: string } {
  const upIdx = sql.indexOf(UP);
  const downIdx = sql.indexOf(DOWN);
  if (upIdx === -1) return { up: sql.trim(), down: '' };
  const up = (downIdx === -1 ? sql.slice(upIdx + UP.length) : sql.slice(upIdx + UP.length, downIdx)).trim();
  const down = downIdx === -1 ? '' : sql.slice(downIdx + DOWN.length).trim();
  return { up, down };
}

export const checksum = (sql: string): string => createHash('sha256').update(sql).digest('hex');

export interface MigrationStatus {
  version: string;
  applied: boolean;
  drift: boolean;
}

/**
 * Runner SQL mínimo (sin ORM): mismas secciones `-- migrate:up` / `-- migrate:down` que coolfix,
 * pero el SQL llega embebido (src/orm/migrations.ts) → funciona dentro del bundle de Lambda.
 */
export class MigrationRunner {
  constructor(
    private readonly conn: ClientBase,
    private readonly migrations: EmbeddedMigration[],
    private readonly table = 'schema_migrations',
  ) {}

  private async ensureTable(): Promise<void> {
    await this.conn.query(
      `CREATE TABLE IF NOT EXISTS "${this.table}" (
         version           VARCHAR(255) PRIMARY KEY,
         checksum          CHAR(64)     NOT NULL,
         applied_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
         execution_time_ms INTEGER
       )`,
    );
  }

  private async applied(): Promise<Map<string, string>> {
    const { rows } = await this.conn.query<{ version: string; checksum: string }>(`SELECT version, checksum FROM "${this.table}"`);
    return new Map(rows.map((r) => [r.version, r.checksum]));
  }

  async up(): Promise<string[]> {
    await this.conn.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK]);
    try {
      await this.ensureTable();
      const done = await this.applied();
      const out: string[] = [];
      for (const m of [...this.migrations].sort((a, b) => a.version.localeCompare(b.version))) {
        if (done.has(m.version)) continue;
        const { up } = parseMigration(m.sql);
        const start = Date.now();
        await this.conn.query('BEGIN');
        try {
          if (up) await this.conn.query(up);
          await this.conn.query(
            `INSERT INTO "${this.table}" (version, checksum, execution_time_ms) VALUES ($1, $2, $3)`,
            [m.version, checksum(m.sql), Date.now() - start],
          );
          await this.conn.query('COMMIT');
        } catch (err) {
          await this.conn.query('ROLLBACK').catch(() => undefined);
          throw err;
        }
        out.push(m.version);
      }
      return out;
    } finally {
      await this.conn.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK]).catch(() => undefined);
    }
  }

  async down(): Promise<string | null> {
    await this.ensureTable();
    const { rows } = await this.conn.query<{ version: string }>(
      `SELECT version FROM "${this.table}" ORDER BY version DESC LIMIT 1`,
    );
    const last = rows[0]?.version;
    if (!last) return null;
    const m = this.migrations.find((x) => x.version === last);
    if (!m) throw new Error(`Migración ${last} aplicada pero no existe en el código`);
    const { down } = parseMigration(m.sql);
    await this.conn.query('BEGIN');
    try {
      if (down) await this.conn.query(down);
      await this.conn.query(`DELETE FROM "${this.table}" WHERE version = $1`, [last]);
      await this.conn.query('COMMIT');
    } catch (err) {
      await this.conn.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
    return last;
  }

  async status(): Promise<MigrationStatus[]> {
    await this.ensureTable();
    const done = await this.applied();
    return this.migrations.map((m) => ({
      version: m.version,
      applied: done.has(m.version),
      drift: done.has(m.version) && done.get(m.version) !== checksum(m.sql),
    }));
  }
}
