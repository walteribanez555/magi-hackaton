import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProductivityEvent } from '@magicode/contracts';
import { git, gitUserIdentity, resolveDeveloper } from '../src/git';
import { nullLogger } from '../src/log';
import { TelemetryClient, buildEvent, type KeyValueStore, type TelemetryContext } from '../src/telemetry';

const base: TelemetryContext = { session_id: 's-1', project_id: 'demo', repository: 'org/repo', branch: 'feature/mag-12-x', task_key: 'MAG-12' };

describe('resolveDeveloper', () => {
  it('lowercases and trims the git email and keeps the name', () => {
    expect(resolveDeveloper({ email: '  Jane.Doe@Example.COM ', name: '  Jane   Doe ' })).toEqual({ developer: 'jane.doe@example.com', developer_name: 'Jane Doe' });
  });

  it('prefers the magicode.developerEmail override', () => {
    expect(resolveDeveloper({ email: 'personal@home.dev', name: 'Jane' }, ' Jane@Corp.com ')).toEqual({ developer: 'jane@corp.com', developer_name: 'Jane' });
    expect(resolveDeveloper({}, 'only@setting.dev')).toEqual({ developer: 'only@setting.dev' });
  });

  it('returns nothing when git has no identity and there is no override', () => {
    expect(resolveDeveloper({})).toEqual({});
    expect(resolveDeveloper({ email: '   ' }, '  ')).toEqual({});
  });

  it('clamps to contract limits', () => {
    const d = resolveDeveloper({ email: `${'a'.repeat(300)}@x.dev`, name: 'n'.repeat(200) });
    expect(d.developer!.length).toBe(254);
    expect(d.developer_name!.length).toBe(120);
  });
});

describe('envelopes carry the developer', () => {
  const ctx: TelemetryContext = { ...base, ...resolveDeveloper({ email: 'Dev@Example.com', name: 'Dev Person' }) };

  it('buildEvent includes developer/developer_name and validates with ProductivityEvent', () => {
    const types = [
      ['session.started', { editor: 'vscode 1.105.0', extension_version: '0.1.0' }],
      ['ai.request.completed', { ai_request_id: 'r-1', status: 'ok', latency_ms: 5 }],
      ['session.ended', { reason: 'user' }],
    ] as const;
    for (const [type, payload] of types) {
      const e = buildEvent(ctx, type, payload as never);
      expect(e).toMatchObject({ developer: 'dev@example.com', developer_name: 'Dev Person' });
      const parsed = ProductivityEvent.safeParse(e);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.developer).toBe('dev@example.com');
        expect(parsed.data.developer_name).toBe('Dev Person');
      }
    }
  });

  it('omits the fields when unknown (still valid)', () => {
    const e = buildEvent(base, 'session.ended', { reason: 'user' });
    expect(e).not.toHaveProperty('developer');
    expect(e).not.toHaveProperty('developer_name');
    expect(ProductivityEvent.safeParse(e).success).toBe(true);
  });

  it('TelemetryClient queues and sends envelopes with the developer', async () => {
    const data = new Map<string, unknown>();
    const store: KeyValueStore = { get: <T>(k: string) => data.get(k) as T | undefined, update: async (k, v) => void data.set(k, v) };
    let body = '';
    const c = new TelemetryClient({
      getBaseUrl: () => 'http://api.local/api/v1',
      getApiKey: async () => 'mh_key_123456789',
      store,
      logger: nullLogger,
      autoFlush: false,
      fetchImpl: (async (_u: string, init?: RequestInit) => {
        body = String(init?.body ?? '');
        return new Response('{}', { status: 202 });
      }) as never,
    });
    expect(c.track(ctx, 'session.ended', { reason: 'user' })?.developer).toBe('dev@example.com');
    await c.flush(true);
    const sent = JSON.parse(body).events[0];
    expect(sent).toMatchObject({ developer: 'dev@example.com', developer_name: 'Dev Person' });
    expect(ProductivityEvent.safeParse(sent).success).toBe(true);
  });
});

describe('gitUserIdentity against a real repo', () => {
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'magicode-dev-'));
    await git(dir, ['init', '-q']);
    await git(dir, ['config', 'user.email', ' Walter.Example@Corp.IO ']);
    await git(dir, ['config', 'user.name', 'Walter Example']);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads user.email / user.name from the repo config', async () => {
    const id = await gitUserIdentity(dir);
    expect(id.name).toBe('Walter Example');
    expect(resolveDeveloper(id)).toEqual({ developer: 'walter.example@corp.io', developer_name: 'Walter Example' });
  });
});
