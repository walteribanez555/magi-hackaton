import { describe, expect, it } from 'vitest';
import { JiraClient, resolveTransition, toAvailableTransition, type JiraTransition } from '../jira.client';
import { ProviderError, retryAfterMs } from '../provider-http';
import { JIRA_CREDS, mockFetch } from './helpers';

const TRANSITIONS: JiraTransition[] = [
  { id: '11', name: 'Volver a Por hacer', to: { name: 'Por hacer', statusCategory: { key: 'new' } } },
  { id: '21', name: 'Iniciar revisión', to: { name: 'En Revisión', statusCategory: { key: 'indeterminate' } } },
  { id: '31', name: 'Done', to: { name: 'Hecho', statusCategory: { key: 'done' } } },
];

const noSleep = async () => {};
const client = (routes: Parameters<typeof mockFetch>[0]) => {
  const m = mockFetch(routes);
  return { ...m, jira: new JiraClient(JIRA_CREDS, { fetch: m.fetch, sleep: noSleep }, () => new Date('2026-10-20T20:00:00.000Z')) };
};

describe('resolveTransition', () => {
  it('por nombre de estado destino sin mayúsculas ni acentos', () => {
    expect(resolveTransition(TRANSITIONS, { to_status: 'en revision' })?.id).toBe('21');
    expect(resolveTransition(TRANSITIONS, { to_status: '  HECHO ' })?.id).toBe('31');
  });
  it('por nombre de la transición o por id exacto', () => {
    expect(resolveTransition(TRANSITIONS, { to_status: 'iniciar revisión' })?.id).toBe('21');
    expect(resolveTransition(TRANSITIONS, { transition_id: '11' })?.id).toBe('11');
    expect(resolveTransition(TRANSITIONS, { transition_id: '99' })).toBeNull();
  });
  it('null si no está disponible', () => {
    expect(resolveTransition(TRANSITIONS, { to_status: 'Bloqueado' })).toBeNull();
    expect(resolveTransition(TRANSITIONS, {})).toBeNull();
  });
  it('AvailableTransition mapea statusCategory', () => {
    expect(TRANSITIONS.map(toAvailableTransition).map((t) => t.to_category)).toEqual(['todo', 'in_progress', 'done']);
  });
});

describe('JiraClient', () => {
  it('whoami usa Basic email:api_token contra /myself', async () => {
    const { jira, calls } = client([{ method: 'GET', path: /\/rest\/api\/3\/myself$/, body: { accountId: 'fake-svc-1', displayName: 'MagiCode bot' } }]);
    expect(await jira.whoami()).toEqual({ account_id: 'fake-svc-1', display_name: 'MagiCode bot' });
    expect(calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from('bot@example.com:fake-token-not-real-123').toString('base64')}`);
  });

  it('transition: resuelve, transiciona, comenta en ADF y marca la propiedad anti-bucle', async () => {
    const { jira, calls } = client([
      { method: 'GET', path: /\/issue\/MAG-123\/transitions$/, body: { transitions: TRANSITIONS } },
      { method: 'POST', path: /\/issue\/MAG-123\/transitions$/, status: 204 },
      { method: 'POST', path: /\/issue\/MAG-123\/comment$/, status: 201, body: { id: '10001' } },
      { method: 'PUT', path: /\/issue\/MAG-123\/properties\/magicode\.last_action$/, status: 200, body: {} },
    ]);
    const out = await jira.execute('MAG-123', { kind: 'transition', to_status: 'En revisión', comment: 'PR abierto: https://github.com/acme/shop/pull/43' }, 'act_1');
    expect(out).toEqual({
      status: 'sent',
      result: { transition_id: '21', to_status: 'En Revisión', to_category: 'in_progress', comment_id: '10001' },
      task_status: { status: 'En Revisión', status_category: 'in_progress' },
    });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'POST', 'PUT']);
    expect(calls[1]!.body).toEqual({ transition: { id: '21' } });
    expect((calls[2]!.body as { body: { type: string } }).body.type).toBe('doc');
    expect(calls[3]!.body).toEqual({ action_id: 'act_1', at: '2026-10-20T20:00:00.000Z' });
  });

  it('transition no disponible → ProviderError permanente con las disponibles', async () => {
    const { jira } = client([{ method: 'GET', path: /\/transitions$/, body: { transitions: TRANSITIONS } }]);
    const err = await jira.execute('MAG-123', { kind: 'transition', to_status: 'Bloqueado' }, 'a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).transient).toBe(false);
    expect((err as ProviderError).message).toMatch(/Bloqueado.*Disponibles: Por hacer, En Revisión, Hecho/);
  });

  it('update_fields: story points (default), métricas con field_ids, labels vía update; sin id → skipped_fields', async () => {
    const { jira, calls } = client([
      { method: 'PUT', path: /\/issue\/MAG-1\?notifyUsers=false$/, status: 204 },
      { method: 'PUT', path: /properties/, body: {} },
    ]);
    const out = await jira.execute(
      'MAG-1',
      { kind: 'update_fields', fields: { story_points: 3, magicode_tokens: 1500, magicode_effective_lines: 27.5, magicode_criticality: 'high', labels_add: ['magicode ai'], labels_remove: ['old'] } },
      'a',
    );
    expect(calls[0]!.body).toEqual({
      fields: { customfield_10016: 3, customfield_10100: 1500, customfield_10102: { value: 'high' } },
      update: { labels: [{ add: 'magicode-ai' }, { remove: 'old' }] },
    });
    expect(out.result).toEqual({ fields: ['story_points', 'magicode_tokens', 'magicode_criticality', 'labels'], skipped_fields: ['magicode_effective_lines'] });
  });

  it('update_fields sin ningún campo configurable → skipped (no llama a Jira)', async () => {
    const { jira, calls } = client([]);
    const out = await jira.execute('MAG-1', { kind: 'update_fields', fields: { magicode_effective_lines: 3 } }, 'a');
    expect(out.status).toBe('skipped');
    expect(calls).toHaveLength(0);
  });

  it('remote_link idempotente por globalId; assign', async () => {
    const { jira, calls } = client([
      { method: 'POST', path: /remotelink$/, status: 201, body: { id: 10000 } },
      { method: 'PUT', path: /assignee$/, status: 204 },
      { method: 'PUT', path: /properties/, body: {} },
    ]);
    await jira.execute('MAG-1', { kind: 'remote_link', url: 'https://github.com/acme/shop/commit/abc1234', title: 'Commit abc1234', relation: 'commit' }, 'a');
    expect(calls[0]!.body).toMatchObject({
      globalId: 'magicode:commit:https://github.com/acme/shop/commit/abc1234',
      object: { url: 'https://github.com/acme/shop/commit/abc1234', title: 'Commit abc1234' },
    });
    await jira.execute('MAG-1', { kind: 'assign', assignee_account_id: null }, 'b');
    expect(calls.find((c) => c.url.endsWith('/assignee'))!.body).toEqual({ accountId: null });
  });

  it('429 con Retry-After se reintenta dentro de la invocación; 5xx agotado → transient', async () => {
    const waits: number[] = [];
    const m = mockFetch([
      { method: 'POST', path: /comment$/, status: 429, headers: { 'retry-after': '1' }, body: { errorMessages: ['rate'] } },
      { method: 'POST', path: /comment$/, status: 201, body: { id: '7' } },
      { method: 'PUT', path: /properties/, body: {} },
    ]);
    const jira = new JiraClient(JIRA_CREDS, { fetch: m.fetch, sleep: async (ms) => void waits.push(ms) });
    expect((await jira.execute('MAG-1', { kind: 'comment', body_markdown: 'hola' }, 'a')).result).toEqual({ comment_id: '7' });
    expect(waits).toEqual([1000]);

    const down = mockFetch([
      { method: 'POST', path: /comment$/, status: 503 },
      { method: 'POST', path: /comment$/, status: 503 },
      { method: 'POST', path: /comment$/, status: 503 },
    ]);
    const err = await new JiraClient(JIRA_CREDS, { fetch: down.fetch, sleep: noSleep }).execute('MAG-1', { kind: 'comment', body_markdown: 'x' }, 'a').catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'ProviderError', status: 503, transient: true });
    expect(down.calls).toHaveLength(3);
  });

  it('4xx → permanente con el mensaje de Jira y sin secretos', async () => {
    const { jira } = client([{ method: 'POST', path: /comment$/, status: 400, body: { errorMessages: ['Comment body is not valid'], errors: {} } }]);
    const err = (await jira.execute('MAG-1', { kind: 'comment', body_markdown: 'x' }, 'a').catch((e: unknown) => e)) as ProviderError;
    expect(err.transient).toBe(false);
    expect(err.message).toContain('Comment body is not valid');
    expect(err.message).not.toContain(JIRA_CREDS.provider === 'jira' ? JIRA_CREDS.api_token : '');
  });

  it('retryAfterMs: segundos o fecha HTTP', () => {
    expect(retryAfterMs('2')).toBe(2000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(retryAfterMs(null)).toBeNull();
  });
});
