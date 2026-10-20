import { describe, expect, it, vi } from 'vitest';
import {
  SmartAutoError,
  buildMessages,
  callSmartAuto,
  conformText,
  extractCodeBlock,
  fetchKeyIdentity,
  parseSmartAutoResponse,
  parseUsage,
  pickRequestId,
} from '../src/smartAuto';

const headers = (h: Record<string, string> = {}) => new Headers(h);
const localId = () => 'L1';

describe('extractCodeBlock', () => {
  it('extracts a single fenced block with language', () => {
    const r = extractCodeBlock('Here you go:\n```ts\nexport const a = 1;\n```\nDone');
    expect(r).toEqual({ code: 'export const a = 1;', fenced: true, truncated: false });
  });

  it('picks the longest block when there are several', () => {
    const r = extractCodeBlock('```\nx\n```\ntext\n```typescript\nline1\nline2\n```');
    expect(r?.code).toBe('line1\nline2');
  });

  it('supports ~~~ fences, CRLF and unterminated blocks', () => {
    expect(extractCodeBlock('~~~py\r\nprint(1)\r\n~~~')?.code).toBe('print(1)');
    const t = extractCodeBlock('```js\nconst a = 1;\nconst b');
    expect(t).toMatchObject({ code: 'const a = 1;\nconst b', truncated: true });
  });

  it('keeps inner shorter fences inside a longer fence', () => {
    const r = extractCodeBlock('````md\n# Title\n```js\nx()\n```\n````');
    expect(r?.code).toBe('# Title\n```js\nx()\n```');
  });

  it('falls back to the whole text when there is no fence', () => {
    expect(extractCodeBlock('  const x = 1;\n')).toEqual({ code: 'const x = 1;', fenced: false, truncated: false });
    expect(extractCodeBlock('   ')).toBeNull();
  });
});

describe('conformText', () => {
  it('applies EOL and trailing newline of the original', () => {
    expect(conformText('a\nb\n\n', '\n', true)).toBe('a\nb\n');
    expect(conformText('a\nb', '\r\n', true)).toBe('a\r\nb\r\n');
    expect(conformText('a\n', '\n', false)).toBe('a');
  });
});

describe('response parsing', () => {
  const body = {
    id: 'chatcmpl-123',
    model: 'magihub/gpt-x',
    choices: [{ message: { role: 'assistant', content: '```ts\nx\n```' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 2 } },
  };

  it('prefers x-request-id header over body.id', () => {
    expect(pickRequestId(headers({ 'x-request-id': 'req-abc' }), body, localId)).toEqual({ requestId: 'req-abc', requestIdSource: 'header' });
    expect(pickRequestId(headers(), body, localId)).toEqual({ requestId: 'chatcmpl-123', requestIdSource: 'body' });
    expect(pickRequestId(headers(), {}, localId)).toEqual({ requestId: 'local-L1', requestIdSource: 'local' });
  });

  it('parses model, usage (with cached tokens), content and simulated flag', () => {
    const p = parseSmartAutoResponse(headers({ 'x-magihub-simulated': 'true' }), body, localId);
    expect(p).toMatchObject({
      requestId: 'chatcmpl-123',
      model: 'magihub/gpt-x',
      content: '```ts\nx\n```',
      finishReason: 'stop',
      simulated: true,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cached_tokens: 2 },
    });
    expect(parseSmartAutoResponse(headers(), { ...body, simulated: true }, localId).simulated).toBe(true);
    expect(parseSmartAutoResponse(headers(), body, localId).simulated).toBe(false);
  });

  it('normalizes partial usage and rejects garbage', () => {
    expect(parseUsage({ prompt_tokens: 3, completion_tokens: 4 })).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
    expect(parseUsage({ input_tokens: 1, output_tokens: 2, total_tokens: 3 })).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    expect(parseUsage(undefined)).toBeUndefined();
    expect(parseUsage({ foo: 1 })).toBeUndefined();
  });

  it('builds messages forcing a single fenced block with the full file', () => {
    const msgs = buildMessages({ path: 'src/a.ts', languageId: 'typescript', fileContent: 'x', instruction: ' add y ', selection: { startLine: 1, endLine: 1, text: 'x' } });
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toMatch(/ÚNICAMENTE/);
    expect(msgs[0]!.content).toMatch(/UN SOLO bloque/);
    expect(msgs[1]!.content).toContain('Instrucción: add y');
    expect(msgs[1]!.content).toContain('líneas 1–1');
  });
});

describe('callSmartAuto', () => {
  it('POSTs to /v1/chat/completions with smart-auto and bearer key', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: 'b1', model: 'm', choices: [{ message: { content: '```\nok\n```' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), {
        status: 200,
        headers: { 'x-request-id': 'h1', 'content-type': 'application/json' },
      }),
    );
    let t = 1000;
    const r = await callSmartAuto({ baseUrl: 'http://mh/', apiKey: 'mh_secret_key', messages: [], fetchImpl, localId, now: () => (t += 25) });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://mh/v1/chat/completions');
    expect(JSON.parse(String(init!.body))).toMatchObject({ model: 'smart-auto', stream: false });
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer mh_secret_key');
    expect(r).toMatchObject({ requestId: 'h1', requestIdSource: 'header', latencyMs: 25, usage: { total_tokens: 2 }, httpStatus: 200 });
  });

  it('throws SmartAutoError with request id and usage on HTTP errors', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { message: 'quota' }, usage: { prompt_tokens: 4, completion_tokens: 0, total_tokens: 4 } }), {
        status: 429,
        headers: { 'x-request-id': 'h2' },
      });
    const err = await callSmartAuto({ baseUrl: 'http://mh', apiKey: 'k', messages: [], fetchImpl, localId }).catch((e) => e);
    expect(err).toBeInstanceOf(SmartAutoError);
    expect(err).toMatchObject({ status: 'error', requestId: 'h2', httpStatus: 429, usage: { total_tokens: 4 } });
    expect(err.message).toContain('quota');
  });

  it('reports cancellation as status cancelled', async () => {
    const ac = new AbortController();
    const fetchImpl = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => init!.signal!.addEventListener('abort', () => rej(new Error('aborted'))));
    const p = callSmartAuto({ baseUrl: 'http://mh', apiKey: 'k', messages: [], fetchImpl, localId, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ status: 'cancelled', requestId: 'local-L1' });
  });
});

describe('fetchKeyIdentity', () => {
  it('validates the key via /v1/keys/self (plain or {data} envelope)', async () => {
    const id = { tenant_id: 't1', key_id: 'k1', key_name: 'demo', scopes: [] };
    const ok = await fetchKeyIdentity('http://mh', 'k', async () => new Response(JSON.stringify({ data: id })));
    expect(ok).toEqual({ ok: true, identity: id });
    const bad = await fetchKeyIdentity('http://mh', 'k', async () => new Response('no', { status: 401 }));
    expect(bad).toMatchObject({ ok: false, status: 401 });
  });
});
