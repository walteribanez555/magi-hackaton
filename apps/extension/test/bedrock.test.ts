import { describe, expect, it } from 'vitest';
import { ProductivityEvent } from '@magicode/contracts';
import { modelLabel } from '../src/format';
import { emptyStats, recordModel } from '../src/session';
import { SmartAutoError, callSmartAuto, parseSmartAutoResponse, pickProvider, usageSourceFor } from '../src/smartAuto';
import { buildEvent } from '../src/telemetry';

const body = {
  id: 'chatcmpl-1',
  model: 'us.meta.llama3-3-70b-instruct-v1:0',
  choices: [{ message: { role: 'assistant', content: '```ts\nx\n```' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
};
const localId = () => 'L1';

describe('Bedrock provider', () => {
  it('reads x-magihub-provider (case-insensitive) into the parsed response', () => {
    expect(pickProvider(new Headers({ 'x-magihub-provider': ' Bedrock ' }))).toBe('bedrock');
    expect(pickProvider(new Headers())).toBeUndefined();
    const p = parseSmartAutoResponse(new Headers({ 'x-magihub-provider': 'bedrock' }), body, localId);
    expect(p).toMatchObject({ provider: 'bedrock', simulated: false, model: body.model });
  });

  it('bedrock usage is real even on localhost; mock detection is kept', () => {
    expect(usageSourceFor({ simulated: false, provider: 'bedrock' }, 'http://localhost:4010')).toBe('bedrock');
    expect(usageSourceFor({ simulated: false, provider: 'bedrock' }, 'https://magihub.example.com')).toBe('bedrock');
    expect(usageSourceFor({ simulated: true, provider: 'bedrock' }, 'https://magihub.example.com')).toBe('magihub-mock');
    expect(usageSourceFor({ simulated: false }, 'http://localhost:4010')).toBe('magihub-mock');
    expect(usageSourceFor({ simulated: true }, 'https://magihub.example.com')).toBe('magihub-mock');
    expect(usageSourceFor({ simulated: false }, 'https://magihub.example.com')).toBe('magihub-response');
  });

  it('callSmartAuto carries the provider on success and on HTTP errors', async () => {
    const ok = await callSmartAuto({
      baseUrl: 'http://localhost:4010',
      apiKey: 'k',
      messages: [],
      localId,
      fetchImpl: (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'x-magihub-provider': 'bedrock' } })) as never,
    });
    expect(ok.provider).toBe('bedrock');
    await expect(
      callSmartAuto({
        baseUrl: 'http://localhost:4010',
        apiKey: 'k',
        messages: [],
        localId,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ ...body, error: { message: 'throttled' } }), { status: 429, headers: { 'x-magihub-provider': 'bedrock' } })) as never,
      }),
    ).rejects.toMatchObject({ provider: 'bedrock', name: 'SmartAutoError' } satisfies Partial<SmartAutoError>);
  });

  it("ai.request.completed with usage_source 'bedrock' validates", () => {
    const e = buildEvent({ session_id: 's', project_id: 'p', repository: 'org/repo' }, 'ai.request.completed', {
      ai_request_id: 'r-1',
      model: body.model,
      status: 'ok',
      latency_ms: 4200,
      usage: body.usage,
      usage_source: 'bedrock',
    });
    expect(ProductivityEvent.safeParse(e).success).toBe(true);
  });
});

describe('routed model in session stats', () => {
  it('tracks last model, source and per-model counts', () => {
    const st = emptyStats();
    expect(modelLabel(st)).toBe('—');
    recordModel(st, 'model-a', 'bedrock');
    expect(modelLabel(st)).toBe('model-a · Bedrock (real)');
    recordModel(st, 'model-b', 'bedrock');
    recordModel(st, 'model-a', 'bedrock');
    recordModel(st, undefined);
    expect(st.models).toEqual({ 'model-a': 2, 'model-b': 1 });
    expect(st.last_model).toBe('model-a');
    expect(modelLabel(st)).toBe('model-a · Bedrock (real) (model-a×2, model-b×1)');
  });
});
