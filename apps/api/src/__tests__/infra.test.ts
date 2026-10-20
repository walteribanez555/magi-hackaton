import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../orm/migrations';
import { parseMigration } from '../orm/migration-runner';
import { mapItem, upsertSql } from '../projector/projector.mapper';
import { redact } from '../config/logger';
import { needsSync, mergeCoverage, reaggregate } from '../modules/usage/usage.service';

describe('migraciones embebidas', () => {
  it('src/orm/migrations.ts está sincronizado con migrations/*.sql (npm run migrations:gen)', () => {
    const dir = join(__dirname, '..', '..', 'migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    expect(MIGRATIONS.map((m) => m.version)).toEqual(files.map((f) => f.replace(/\.sql$/, '')));
    for (const f of files) {
      expect(MIGRATIONS.find((m) => `${m.version}.sql` === f)!.sql).toBe(readFileSync(join(dir, f), 'utf8'));
    }
  });

  it('cada migración tiene up y down', () => {
    for (const m of MIGRATIONS) {
      const { up, down } = parseMigration(m.sql);
      expect(up).toContain('CREATE TABLE');
      expect(down).toContain('DROP TABLE');
    }
  });
});

describe('projector mapper', () => {
  it('omite EventDedupe, RawEvent y el marcador de sync', () => {
    expect(mapItem({ entity: 'EventDedupe' })).toBeNull();
    expect(mapItem({ entity: 'RawEvent' })).toBeNull();
    expect(mapItem({ entity: 'UsageSnapshot', kind: 'sync-marker', granularity: 'request' })).toBeNull();
  });

  it('Change → changes con jsonb y arrays; UPSERT guardado por updated_at', () => {
    const row = mapItem({
      entity: 'Change', tenant_id: 't', key_id: 'k', session_id: 's', change_id: 'c', project_id: 'p', repository: 'r',
      status: 'committed', first_seen_at: '2026-10-20T10:00:00Z', reference_tags: new Set(['v1']), provenance: 'real',
      created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:01:00Z', accepted_files: [{ path: 'a', added: 1, deleted: 0 }],
    })!;
    expect(row.table).toBe('changes');
    expect(row.values.reference_tags).toEqual(['v1']);
    expect(row.values.files).toBe('[{"path":"a","added":1,"deleted":0}]');
    const { text, values } = upsertSql(row);
    expect(text).toContain('ON CONFLICT ("tenant_id", "session_id", "change_id") DO UPDATE');
    expect(text).toContain('WHERE "changes"."updated_at" <= EXCLUDED."updated_at"');
    expect(values).toHaveLength(Object.keys(row.values).length);
  });

  it('UsageSnapshot → usage_snapshots con window_key desde el SK', () => {
    const row = mapItem({
      entity: 'UsageSnapshot', SK: 'U#request#2026-10-20T10:00:00.000Z#req1', tenant_id: 't', key_id: 'k', granularity: 'request',
      window_start: '2026-10-20T10:00:00.000Z', window_end: '2026-10-20T10:00:00.000Z', request_id: 'req1',
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }, requests: 1, simulated: true, source: 'magihub-mock',
      provenance: 'simulated', synced_at: 'x', created_at: 'x', updated_at: 'x',
    })!;
    expect(row.values).toMatchObject({ window_key: '2026-10-20T10:00:00.000Z#req1', total_tokens: 3, simulated: true });
  });
});

describe('logger', () => {
  it('redacta Authorization y valores con forma de key', () => {
    const out = redact({ headers: { Authorization: 'Bearer mh_demo_x' }, note: 'mh_demo_walter', total_tokens: 10 }) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(out.headers.Authorization).toBe('[REDACTED]');
    expect(out.note).toBe('[REDACTED]');
    expect(out.total_tokens).toBe(10);
  });
});

describe('usage sync', () => {
  const marker = {
    granularity: 'request' as const, covered_from: '2026-10-20T00:00:00.000Z', covered_to: '2026-10-20T10:00:00.000Z',
    synced_at: '2026-10-20T10:00:00.000Z', provenance: 'real' as const, source: 'magihub-usage-api' as const,
  };
  const now = Date.parse('2026-10-20T10:03:00.000Z');
  it('sin marcador o fuera de cobertura ⇒ sync', () => {
    expect(needsSync(undefined, marker.covered_from, marker.covered_to, now, 300)).toBe(true);
    expect(needsSync(marker, '2026-10-19T00:00:00.000Z', '2026-10-20T01:00:00.000Z', now, 300)).toBe(true);
  });
  it('ventana cubierta ⇒ no sync; ventana más reciente con sync < 5 min ⇒ no sync; > 5 min ⇒ sync', () => {
    expect(needsSync(marker, '2026-10-20T01:00:00.000Z', '2026-10-20T09:00:00.000Z', now, 300)).toBe(false);
    expect(needsSync(marker, '2026-10-20T01:00:00.000Z', '2026-10-20T12:00:00.000Z', now, 300)).toBe(false);
    expect(needsSync(marker, '2026-10-20T01:00:00.000Z', '2026-10-20T12:00:00.000Z', now + 3 * 60_000, 300)).toBe(true);
  });
  it('mergeCoverage une ventanas solapadas', () => {
    expect(mergeCoverage(marker, '2026-10-20T09:00:00.000Z', '2026-10-20T11:00:00.000Z', 'request')).toEqual({
      covered_from: '2026-10-20T00:00:00.000Z', covered_to: '2026-10-20T11:00:00.000Z',
    });
    expect(mergeCoverage(marker, '2026-10-21T09:00:00.000Z', '2026-10-21T11:00:00.000Z', 'request').covered_from).toBe('2026-10-21T09:00:00.000Z');
  });
  it('reaggregate request → hour', () => {
    const rec = (ts: string, t: number) => ({ request_id: ts, window_start: ts, window_end: ts, usage: { prompt_tokens: 0, completion_tokens: t, total_tokens: t }, requests: 1 });
    const out = reaggregate([rec('2026-10-20T10:01:00.000Z', 5), rec('2026-10-20T10:59:00.000Z', 7), rec('2026-10-20T11:00:00.000Z', 1)], 'hour');
    expect(out.records.map((r) => [r.window_start, r.usage.total_tokens, r.requests])).toEqual([
      ['2026-10-20T10:00:00.000Z', 12, 2],
      ['2026-10-20T11:00:00.000Z', 1, 1],
    ]);
  });
});
