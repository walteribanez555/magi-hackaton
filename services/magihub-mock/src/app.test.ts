import { describe, expect, it } from 'vitest';
import { KeyIdentity, UsageResponse } from '@magicode/contracts';
import { createApp } from './app';
import { MemoryUsageStore } from './store';

const H = { authorization: 'Bearer mh_demo_test', 'content-type': 'application/json' };
const chat = (app: ReturnType<typeof createApp>, content: string) =>
  app.request('/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify({ model: 'smart-auto', messages: [{ role: 'user', content }] }) });

describe('magihub-mock (SIMULADO)', () => {
  it('keys/self: mh_demo_* válida, resto 401; siempre x-magihub-simulated', async () => {
    const app = createApp(new MemoryUsageStore());
    const ok = await app.request('/v1/keys/self', { headers: H });
    expect(ok.headers.get('x-magihub-simulated')).toBe('true');
    const who = KeyIdentity.parse(await ok.json());
    expect(who).toMatchObject({ tenant_id: 'demo-tenant', governance: { allowed_models: ['smart-auto'] } });
    expect(who.key_id).toMatch(/^key_[0-9a-f]{8}$/);
    const bad = await app.request('/v1/keys/self', { headers: { authorization: 'Bearer sk-real' } });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('x-magihub-simulated')).toBe('true');
  });

  it('chat: determinista, x-request-id = id, usage ≈ chars/4, modelo enrutado', async () => {
    const app = createApp(new MemoryUsageStore());
    const a = await chat(app, 'Escribe la function sumPositive with unit test');
    const b = await chat(app, 'Escribe la function sumPositive with unit test');
    const ja = (await a.json()) as { id: string; model: string; usage: { total_tokens: number }; choices: Array<{ message: { content: string } }> };
    const jb = (await b.json()) as typeof ja;
    expect(a.headers.get('x-request-id')).toBe(ja.id);
    expect(ja.id).not.toBe(jb.id);
    expect(ja.choices[0]!.message.content).toBe(jb.choices[0]!.message.content);
    expect(ja.choices[0]!.message.content).toContain('describe(');
    expect(ja.model).toBe('mock-haiku');
    expect(ja.usage.total_tokens).toBeGreaterThan(0);
    const forbidden = await app.request('/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify({ model: 'gpt-4', messages: [{ role: 'user', content: 'x' }] }) });
    expect(forbidden.status).toBe(403);
  });

  it('usage: request y hour desde las completions guardadas', async () => {
    const app = createApp(new MemoryUsageStore());
    const from = new Date(Date.now() - 60_000).toISOString();
    await chat(app, 'consulta SQL');
    await chat(app, 'componente React Counter');
    const to = new Date(Date.now() + 60_000).toISOString();
    const req = UsageResponse.parse(await (await app.request(`/v1/usage?from=${from}&to=${to}&granularity=request`, { headers: H })).json());
    expect(req.simulated).toBe(true);
    expect(req.records).toHaveLength(2);
    expect(req.records.every((r) => r.request_id?.startsWith('mhreq_'))).toBe(true);
    const hour = UsageResponse.parse(await (await app.request(`/v1/usage?from=${from}&to=${to}&granularity=hour`, { headers: H })).json());
    expect(hour.records.reduce((a, r) => a + r.usage.total_tokens, 0)).toBe(req.records.reduce((a, r) => a + r.usage.total_tokens, 0));
  });
});
