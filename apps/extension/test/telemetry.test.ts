import { describe, expect, it, vi } from 'vitest';
import { ProductivityEvent } from '@magicode/contracts';
import { nullLogger, type Logger } from '../src/log';
import { QUEUE_KEY, TelemetryClient, buildEvent, eventsUrl, isoWithOffset, validateEvent, type KeyValueStore } from '../src/telemetry';

class MemStore implements KeyValueStore {
  data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
}

const ctx = { session_id: 's-1', project_id: 'demo', repository: 'org/repo', branch: 'feature/mag-12-x', task_key: 'MAG-12' };
const reqPayload = (i: number) => ({ ai_request_id: `r-${i}`, status: 'ok' as const, latency_ms: 10 });

function client(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, opts: Partial<ConstructorParameters<typeof TelemetryClient>[0]> = {}) {
  const store = (opts.store as MemStore) ?? new MemStore();
  const logger: Logger = opts.logger ?? { ...nullLogger, warn: vi.fn() };
  let t = 1_000_000;
  const c = new TelemetryClient({
    getBaseUrl: () => 'http://api.local/api/v1',
    getApiKey: async () => 'mh_key_123456789',
    store,
    logger,
    fetchImpl: fetchImpl as never,
    autoFlush: false,
    now: () => new Date((t += 1)),
    ...opts,
  });
  return { c, store, logger, advance: (ms: number) => (t += ms) };
}

const ok = () => vi.fn(async (_u: string, _i?: RequestInit) => new Response('{"accepted":1}', { status: 202 }));

describe('envelope', () => {
  it('builds a valid event with offset timestamp and ide-extension source', () => {
    const e = buildEvent(ctx, 'ai.request.completed', reqPayload(1));
    const v = validateEvent(e);
    expect(v.ok).toBe(true);
    expect(e).toMatchObject({ schema_version: 1, source: 'ide-extension', session_id: 's-1', branch: 'feature/mag-12-x', task_key: 'MAG-12' });
    expect(String(e.occurred_at)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/);
  });

  it('isoWithOffset round-trips to the same instant', () => {
    const d = new Date('2026-10-20T15:04:05.678Z');
    expect(Date.parse(isoWithOffset(d))).toBe(d.getTime());
  });

  it('eventsUrl accepts bases with or without /api/v1', () => {
    expect(eventsUrl('http://x/api/v1')).toBe('http://x/api/v1/productivity/events');
    expect(eventsUrl('http://x/')).toBe('http://x/api/v1/productivity/events');
  });
});

describe('TelemetryClient', () => {
  it('drops events that fail contract validation with a warning', () => {
    const { c, logger } = client(ok());
    const r = c.track(ctx, 'reference.marked', {
      tag: 't',
      sha: 'abcdef1',
      kind: 'deployment', // sin evidence_url → inválido
      included_shas: [],
      surviving_lines: 0,
      surviving_effective_lines: 0,
    });
    expect(r).toBeUndefined();
    expect(c.pending).toBe(0);
    expect(c.dropped).toBe(1);
    expect(logger.warn).toHaveBeenCalled();
    expect(c.track({ ...ctx, task_key: 'bad key' }, 'session.ended', { reason: 'user' })).toBeUndefined();
  });

  it('batches up to 25 events per request with bearer auth', async () => {
    const f = ok();
    const { c } = client(f, { flushThreshold: 1000 });
    for (let i = 0; i < 30; i++) c.track(ctx, 'ai.request.completed', reqPayload(i));
    expect(c.pending).toBe(30);
    await c.flush();
    expect(f).toHaveBeenCalledTimes(2);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://api.local/api/v1/productivity/events');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer mh_key_123456789');
    const body = JSON.parse(String(init!.body));
    expect(body.events).toHaveLength(25);
    expect(JSON.parse(String(f.mock.calls[1]![1]!.body)).events).toHaveLength(5);
    for (const e of body.events) expect(ProductivityEvent.safeParse(e).success).toBe(true);
    expect(c.pending).toBe(0);
    expect(c.sent).toBe(30);
  });

  it('auto-flushes when the threshold (10) is reached', async () => {
    const f = ok();
    const { c } = client(f);
    for (let i = 0; i < 9; i++) c.track(ctx, 'ai.request.completed', reqPayload(i));
    expect(f).not.toHaveBeenCalled();
    c.track(ctx, 'ai.request.completed', reqPayload(9));
    await c.flush();
    expect(f).toHaveBeenCalledTimes(1);
    expect(c.pending).toBe(0);
  });

  it('keeps events and backs off on network/5xx errors, then retries', async () => {
    let fail = true;
    const f = vi.fn(async () => {
      if (fail) throw new Error('ECONNREFUSED');
      return new Response('{}', { status: 202 });
    });
    const { c, advance } = client(f, { flushThreshold: 1000 });
    c.track(ctx, 'session.ended', { reason: 'user' });
    await c.flush();
    expect(c.pending).toBe(1);
    expect(c.lastError).toMatch(/ECONNREFUSED/);
    fail = false;
    await c.flush(); // dentro del backoff: no intenta
    expect(f).toHaveBeenCalledTimes(1);
    advance(5_000);
    await c.flush();
    expect(f).toHaveBeenCalledTimes(2);
    expect(c.pending).toBe(0);
  });

  it('drops a batch the server rejects with 400 (poison) but keeps it on 503', async () => {
    const f503 = vi.fn(async () => new Response('', { status: 503 }));
    const a = client(f503, { flushThreshold: 1000 });
    a.c.track(ctx, 'session.ended', { reason: 'user' });
    await a.c.flush();
    expect(a.c.pending).toBe(1);

    const f400 = vi.fn(async () => new Response('', { status: 400 }));
    const b = client(f400, { flushThreshold: 1000 });
    b.c.track(ctx, 'session.ended', { reason: 'user' });
    await b.c.flush();
    expect(b.c.pending).toBe(0);
    expect(b.c.dropped).toBe(1);
  });

  it('waits when there is no API key', async () => {
    const f = ok();
    const { c } = client(f, { getApiKey: async () => undefined, flushThreshold: 1000 });
    c.track(ctx, 'session.ended', { reason: 'user' });
    await c.flush(true);
    expect(f).not.toHaveBeenCalled();
    expect(c.pending).toBe(1);
  });

  it('persists the unsent queue and restores it (re-validating)', async () => {
    const store = new MemStore();
    const failing = vi.fn(async () => new Response('', { status: 500 }));
    const first = client(failing, { store, flushThreshold: 1000 });
    first.c.track(ctx, 'session.ended', { reason: 'user' });
    first.c.track(ctx, 'ai.request.completed', reqPayload(1));
    await new Promise((r) => setTimeout(r, 0));
    expect((store.get<unknown[]>(QUEUE_KEY) ?? []).length).toBe(2);
    store.data.set(QUEUE_KEY, [...(store.get<unknown[]>(QUEUE_KEY) ?? []), { garbage: true }]);

    const f = ok();
    const second = client(f, { store, flushThreshold: 1000 });
    expect(second.c.pending).toBe(2);
    expect(second.c.dropped).toBe(1);
    await second.c.flush();
    expect(f).toHaveBeenCalledTimes(1);
    expect(store.get<unknown[]>(QUEUE_KEY)).toEqual([]);
  });

  it('never puts the API key in the body', async () => {
    const f = ok();
    const { c } = client(f, { flushThreshold: 1000 });
    c.track(ctx, 'session.ended', { reason: 'user' });
    await c.flush();
    expect(String(f.mock.calls[0]![1]!.body)).not.toContain('mh_key_123456789');
  });
});
