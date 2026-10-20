import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  SMART_AUTO_MODEL,
  UsageGranularity,
  type KeyIdentity,
  type UsageRecord,
  type UsageResponse,
} from '@magicode/contracts';
import { costOf, generateCompletion, routeModel, textOf, tokensOf, type ChatMessage } from './completions';
import { identityOf, readBearer } from './identity';
import { createStore, type StoredUsage, type UsageStore } from './store';

/**
 * ⚠️ MagiHub SIMULADO (services/magihub-mock). Implementa el contrato que MagiCode necesita de
 * MagiHub para desarrollo y demo. TODA respuesta lleva `x-magihub-simulated: true` y el consumo
 * `simulated: true`: nada de lo que sale de aquí es una medición real.
 */

type Env = { Variables: { identity: KeyIdentity } };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const err = (c: Context, status: 400 | 401 | 403 | 404, message: string, type: string) =>
  c.json({ error: { message, type, code: type }, simulated: true }, status);

export function createApp(store: UsageStore = createStore()) {
  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    await next();
    c.header('x-magihub-simulated', 'true');
  });

  app.get('/', (c) => c.json({ service: 'magihub-mock', simulated: true, docs: 'services/magihub-mock/README.md' }));
  app.get('/health', (c) => c.json({ status: 'ok', simulated: true }));

  // Auth: Bearer mh_demo_* (simulado)
  app.use('/v1/*', async (c, next) => {
    const identity = identityOf(readBearer(c.req.header('authorization')));
    if (!identity) return err(c, 401, 'Invalid API key (mock: usa una key que empiece con mh_demo_)', 'invalid_api_key');
    c.set('identity', identity);
    await next();
  });

  app.get('/v1/keys/self', (c) => c.json(c.get('identity')));

  // ── POST /v1/chat/completions (OpenAI-compatible) ─────────────────────────
  app.post('/v1/chat/completions', async (c) => {
    let body: { model?: string; messages?: ChatMessage[]; stream?: boolean; stream_options?: { include_usage?: boolean } };
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, 'Invalid JSON body', 'invalid_request_error');
    }
    const identity = c.get('identity');
    const requested = body.model ?? SMART_AUTO_MODEL;
    if (!identity.governance?.allowed_models?.includes(requested)) {
      return err(c, 403, `Model "${requested}" not allowed by key governance (allowed: ${SMART_AUTO_MODEL})`, 'model_not_allowed');
    }
    if (!Array.isArray(body.messages) || !body.messages.length) {
      return err(c, 400, '`messages` is required', 'invalid_request_error');
    }

    const promptChars = body.messages.reduce((a, m) => a + textOf(m).length, 0);
    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
    const content = generateCompletion(lastUser ? textOf(lastUser) : '');
    const model = routeModel(promptChars);
    const prompt_tokens = tokensOf(promptChars);
    const completion_tokens = tokensOf(content.length);
    const usage = { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
    const id = `mhreq_${randomUUID().replace(/-/g, '')}`;
    const created = Math.floor(Date.now() / 1000);

    const record: StoredUsage = {
      request_id: id,
      key_id: identity.key_id,
      ts: new Date().toISOString(),
      model,
      usage,
      cost_usd: costOf(model, prompt_tokens, completion_tokens),
    };
    await store.put(record);

    c.header('x-request-id', id);
    c.header('x-magihub-routed-model', model);
    c.header('x-magihub-simulated', 'true');

    if (body.stream) {
      return streamSSE(c, async (s) => {
        const pieces = content.match(/[\s\S]{1,48}/g) ?? [''];
        for (const [i, piece] of pieces.entries()) {
          await s.writeSSE({
            data: JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: i === 0 ? { role: 'assistant', content: piece } : { content: piece }, finish_reason: null }],
            }),
          });
        }
        await s.writeSSE({
          data: JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        });
        // Igual que OpenAI con stream_options.include_usage: un chunk final con usage y choices vacío.
        await s.writeSSE({
          data: JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage, simulated: true }),
        });
        await s.writeSSE({ data: '[DONE]' });
      });
    }

    return c.json({
      id,
      object: 'chat.completion',
      created,
      model,
      requested_model: requested,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage,
      simulated: true,
    });
  });

  // ── GET /v1/usage?from&to&granularity ─────────────────────────────────────
  app.get('/v1/usage', async (c) => {
    const from = c.req.query('from');
    const to = c.req.query('to') ?? new Date().toISOString();
    const g = UsageGranularity.safeParse(c.req.query('granularity') ?? 'request');
    if (!from || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
      return err(c, 400, '`from` and `to` must be ISO-8601 dates', 'invalid_request_error');
    }
    if (!g.success) return err(c, 400, 'granularity must be request|hour|day', 'invalid_request_error');
    // MOCK_USAGE_GRANULARITIES=hour,day simula un MagiHub sin granularidad por petición.
    const supported = (process.env.MOCK_USAGE_GRANULARITIES || 'request,hour,day').split(',');
    if (!supported.includes(g.data)) return err(c, 400, `granularity=${g.data} not supported`, 'unsupported_granularity');

    const delayMin = Number(process.env.MOCK_INGESTION_DELAY_MINUTES || 0);
    const cutoff = new Date(Date.now() - delayMin * 60_000).toISOString();
    const fromIso = new Date(from).toISOString();
    const toIso = new Date(Math.min(Date.parse(to), Date.parse(cutoff))).toISOString();
    const identity = c.get('identity');
    const rows = await store.list(identity.key_id, fromIso, toIso);

    let records: UsageRecord[];
    if (g.data === 'request') {
      records = rows.map((r) => ({
        request_id: r.request_id,
        window_start: r.ts,
        window_end: r.ts,
        model: r.model,
        usage: r.usage,
        requests: 1,
        cost_usd: r.cost_usd,
      }));
    } else {
      const size = g.data === 'hour' ? HOUR : DAY;
      const buckets = new Map<string, UsageRecord>();
      for (const r of rows) {
        const start = Math.floor(Date.parse(r.ts) / size) * size;
        const k = `${start}|${r.model}`;
        const b = buckets.get(k) ?? {
          window_start: new Date(start).toISOString(),
          window_end: new Date(start + size).toISOString(),
          model: r.model,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          requests: 0,
          cost_usd: 0,
        };
        b.usage.prompt_tokens += r.usage.prompt_tokens;
        b.usage.completion_tokens += r.usage.completion_tokens;
        b.usage.total_tokens += r.usage.total_tokens;
        b.requests += 1;
        b.cost_usd = Math.round(((b.cost_usd ?? 0) + r.cost_usd) * 1e6) / 1e6;
        buckets.set(k, b);
      }
      records = [...buckets.values()].sort((a, b) => a.window_start.localeCompare(b.window_start));
    }

    const res: UsageResponse = {
      key_id: identity.key_id,
      from: fromIso,
      to: new Date(to).toISOString(),
      granularity: g.data,
      records,
      simulated: true,
      ingestion_delay_minutes: delayMin,
    };
    return c.json(res);
  });

  app.notFound((c) => err(c, 404, 'Not found (magihub-mock)', 'not_found'));
  return app;
}

export const app = createApp();
