import { describe, expect, it } from 'vitest';
import type { ConverseCommand, ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { UsageResponse } from '@magicode/contracts';
import { createApp } from './app';
import {
  bedrockCostOf,
  mapBedrockError,
  routeSmartAuto,
  smartAutoConfig,
  toConverse,
  type BedrockLike,
  type SmartAutoConfig,
} from './bedrock';
import { MemoryUsageStore } from './store';

const CFG: SmartAutoConfig = {
  fastModel: 'global.fast-model-v1:0',
  strongModel: 'us.strong-model-v1:0',
  maxTokens: 4096,
  shortPromptChars: 1500,
  timeoutMs: 5_000,
};

/** Cliente Bedrock falso: registra los comandos y devuelve una respuesta Converse fija. */
function fakeBedrock(overrides: Partial<ConverseCommandOutput> = {}, fail?: Error) {
  const calls: ConverseCommand[] = [];
  let n = 0;
  const client: BedrockLike = {
    async send(cmd) {
      calls.push(cmd);
      if (fail) throw fail;
      n += 1;
      return {
        $metadata: { httpStatusCode: 200, requestId: `aaaa-bbbb-${n}` },
        output: { message: { role: 'assistant', content: [{ text: 'export const add = (a: number, b: number) => a + b;' }] } },
        stopReason: 'end_turn',
        usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
        metrics: { latencyMs: 812 },
        ...overrides,
      } as ConverseCommandOutput;
    },
  };
  return { client, calls };
}

const H = { authorization: 'Bearer mh_demo_test', 'content-type': 'application/json' };
const post = (app: ReturnType<typeof createApp>, body: unknown) =>
  app.request('/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify(body) });

describe('Smart Auto routing', () => {
  it('prompt corto y simple → fast; largo → strong; señales → strong', () => {
    expect(routeSmartAuto([{ role: 'user', content: 'función add en TS' }], CFG)).toMatchObject({ tier: 'fast', model: CFG.fastModel, reason: 'short_prompt' });
    expect(routeSmartAuto([{ role: 'user', content: 'x'.repeat(1500) }], CFG)).toMatchObject({ tier: 'strong', model: CFG.strongModel, reason: 'long_prompt' });
    for (const p of ['Refactoriza este módulo', 'propón una arquitectura hexagonal', 'cambia varios archivos', 'refactor the auth layer']) {
      expect(routeSmartAuto([{ role: 'user', content: p }], CFG).reason).toBe('strong_signal');
    }
    // el tamaño cuenta todos los mensajes (system incluido)
    expect(routeSmartAuto([{ role: 'system', content: 'y'.repeat(1400) }, { role: 'user', content: 'z'.repeat(200) }], CFG).tier).toBe('strong');
  });

  it('config por env: overrides de modelos y maxTokens', () => {
    const cfg = smartAutoConfig({ SMART_AUTO_FAST_MODEL: 'a', SMART_AUTO_STRONG_MODEL: 'b', SMART_AUTO_MAX_TOKENS: '1024' } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ fastModel: 'a', strongModel: 'b', maxTokens: 1024 });
    expect(smartAutoConfig({} as NodeJS.ProcessEnv).maxTokens).toBe(4096);
  });
});

describe('mapeo OpenAI → Converse', () => {
  it('system aparte, roles consecutivos unidos, vacíos fuera, arranca en user', () => {
    const out = toConverse([
      { role: 'system', content: 'Eres un asistente de código.' },
      { role: 'assistant', content: 'Hola' },
      { role: 'user', content: [{ type: 'text', text: 'parte 1' }, { type: 'text', text: ' parte 2' }] },
      { role: 'user', content: 'otra' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: 'ok' },
    ]);
    expect(out.system).toEqual([{ text: 'Eres un asistente de código.' }]);
    expect(out.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(out.messages[2]!.content).toEqual([{ text: 'parte 1 parte 2' }, { text: 'otra' }]);
  });

  it('errores Bedrock → status OpenAI', () => {
    expect(mapBedrockError(Object.assign(new Error('slow'), { name: 'ThrottlingException' })).status).toBe(429);
    expect(mapBedrockError(Object.assign(new Error('bad'), { name: 'ValidationException' })).status).toBe(400);
    expect(mapBedrockError(Object.assign(new Error('no'), { name: 'AccessDeniedException' })).status).toBe(403);
    expect(mapBedrockError(new Error('boom')).status).toBe(502);
  });

  it('costo: tabla por modelo; desconocido ⇒ undefined', () => {
    const usage = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 };
    expect(bedrockCostOf('global.anthropic.claude-haiku-4-5-20251001-v1:0', usage)).toBe(6);
    expect(bedrockCostOf('modelo-sin-precio', usage)).toBeUndefined();
  });
});

describe('POST /v1/chat/completions en modo bedrock', () => {
  it('llama a Converse con el modelo enrutado y responde en formato OpenAI con usage real', async () => {
    const { client, calls } = fakeBedrock({ usage: { inputTokens: 120, outputTokens: 30, totalTokens: 160, cacheReadInputTokens: 10 } });
    const store = new MemoryUsageStore();
    const app = createApp(store, { provider: 'bedrock', bedrock: client, config: CFG });
    const res = await post(app, {
      model: 'smart-auto',
      max_tokens: 99_999,
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'Responde solo con código.' },
        { role: 'user', content: 'función add en TypeScript' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-magihub-provider')).toBe('bedrock');
    expect(res.headers.get('x-magihub-simulated')).toBeNull();
    expect(res.headers.get('x-request-id')).toBe('req_aaaa-bbbb-1');
    const j = (await res.json()) as Record<string, any>;
    expect(j).toMatchObject({
      id: 'req_aaaa-bbbb-1',
      object: 'chat.completion',
      model: CFG.fastModel,
      requested_model: 'smart-auto',
      choices: [{ message: { role: 'assistant', content: expect.stringContaining('add') }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 160, cached_tokens: 10 },
    });
    expect(j).not.toHaveProperty('simulated');

    const input = calls[0]!.input;
    expect(input.modelId).toBe(CFG.fastModel);
    expect(input.system).toEqual([{ text: 'Responde solo con código.' }]);
    expect(input.messages).toEqual([{ role: 'user', content: [{ text: 'función add en TypeScript' }] }]);
    expect(input.inferenceConfig).toEqual({ maxTokens: 4096, temperature: 0.2 }); // tope = maxTokens

    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const usage = UsageResponse.parse(await (await app.request(`/v1/usage?from=${from}&to=${to}&granularity=request`, { headers: H })).json());
    expect(usage.simulated).toBe(false);
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]).toMatchObject({
      request_id: 'req_aaaa-bbbb-1',
      model: CFG.fastModel,
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 160, cached_tokens: 10 },
      requests: 1,
    });
    expect(usage.records[0]!.cost_usd).toBeUndefined(); // modelo de test sin precio
  });

  it('prompt largo → modelo fuerte; costo conocido se guarda; usage no mezcla registros simulados', async () => {
    const strong = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
    const { client, calls } = fakeBedrock();
    const store = new MemoryUsageStore();
    // registro simulado previo de la misma key (modo mock)
    await createApp(store, { provider: 'mock' }).request('/v1/chat/completions', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ model: 'smart-auto', messages: [{ role: 'user', content: 'consulta SQL' }] }),
    });
    const app = createApp(store, { provider: 'bedrock', bedrock: client, config: { ...CFG, strongModel: strong } });
    const res = await post(app, { model: 'smart-auto', messages: [{ role: 'user', content: 'Refactoriza el módulo de pagos' }] });
    expect(res.status).toBe(200);
    expect(calls[0]!.input.modelId).toBe(strong);
    expect(res.headers.get('x-magihub-route')).toBe('strong:strong_signal');

    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const hour = UsageResponse.parse(await (await app.request(`/v1/usage?from=${from}&to=${to}&granularity=hour`, { headers: H })).json());
    expect(hour.simulated).toBe(false);
    expect(hour.records).toHaveLength(1);
    expect(hour.records[0]).toMatchObject({ model: strong, requests: 1, usage: { total_tokens: 150 } });
    expect(hour.records[0]!.cost_usd).toBeCloseTo((120 * 3.3 + 30 * 16.5) / 1e6, 9);
  });

  it('governance y errores de Bedrock', async () => {
    const throttled = fakeBedrock({}, Object.assign(new Error('Too many requests'), { name: 'ThrottlingException', $metadata: { requestId: 'zzz' } }));
    const store = new MemoryUsageStore();
    const app = createApp(store, { provider: 'bedrock', bedrock: throttled.client, config: CFG });
    expect((await post(app, { model: 'gpt-4', messages: [{ role: 'user', content: 'x' }] })).status).toBe(403);
    const res = await post(app, { model: 'smart-auto', messages: [{ role: 'user', content: 'x' }] });
    expect(res.status).toBe(429);
    expect(res.headers.get('x-request-id')).toBe('req_zzz');
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe('rate_limit_exceeded');
    expect(await store.list('key_', '0', '9')).toEqual([]);
  });

  it('stream: true → SSE OpenAI con chunk final de usage', async () => {
    const { client } = fakeBedrock();
    const app = createApp(new MemoryUsageStore(), { provider: 'bedrock', bedrock: client, config: CFG });
    const res = await post(app, { model: 'smart-auto', stream: true, messages: [{ role: 'user', content: 'add' }] });
    const text = await res.text();
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('"usage":{"prompt_tokens":120,"completion_tokens":30,"total_tokens":150}');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('keys/self sigue funcionando (auth del gateway) sin header simulado', async () => {
    const app = createApp(new MemoryUsageStore(), { provider: 'bedrock', bedrock: fakeBedrock().client, config: CFG });
    const ok = await app.request('/v1/keys/self', { headers: H });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-magihub-provider')).toBe('bedrock');
    expect((await app.request('/v1/keys/self', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
  });
});
