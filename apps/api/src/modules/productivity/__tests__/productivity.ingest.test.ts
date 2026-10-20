import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { keys } from '@magicode/contracts';
import { config } from '../../../config/config';
import { resetDynamo } from '../../../config/dynamo';
import { createScoringService } from '../../scoring';
import { ProductivityService, scopeTaskKeys, scoringContextFor } from '../productivity.service';
import { eventTaskKeys, nextChangeStatus, type TransactItem } from '../productivity.projection';
import type { RuleTrigger } from '@magicode/contracts';
import type { TriggerInput } from '../../task-sync/task-sync.types';
import { dims } from './fixtures';

process.env.TABLE_NAME = 'test-table';
process.env.LOG_LEVEL = 'error';
config.reload();

const ddb = mockClient(DynamoDBDocumentClient);
const caller = { tenant_id: 'tenant-a', key_id: 'key_1' };
const fired: Array<{ trigger: RuleTrigger; input: TriggerInput }> = [];
let integrations: Array<{ project_id: string; status: string; task_project_keys?: string[] }> = [];
const service = new ProductivityService(undefined, undefined, () => new Date('2026-10-20T12:00:00.000Z'), {
  scoring: createScoringService({ invoker: null }),
  fireTrigger: async (trigger, input) => void fired.push({ trigger, input }),
  integrations: { listByTenant: async () => integrations as never },
});

const env = (event_type: string, payload: Record<string, unknown>, o: Record<string, unknown> = {}) => ({
  event_id: randomUUID(),
  schema_version: 1,
  occurred_at: '2026-10-20T10:00:00.000Z',
  session_id: 's1',
  project_id: 'p1',
  repository: 'org/repo',
  source: 'ide-extension',
  event_type,
  payload,
  ...o,
});

const files = [{ path: 'src/a.ts', added: 10, deleted: 0 }];
const SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';

/** Items de todas las TransactWrite enviadas. */
const writes = (): TransactItem[] =>
  ddb.commandCalls(TransactWriteCommand).flatMap((c) => (c.args[0].input.TransactItems ?? []) as TransactItem[]);

/** Valor SET de un atributo en un Update (buildUpdate usa #nI ↔ :vI). */
function setValue(item: TransactItem, attr: string): unknown {
  const u = item.Update!;
  const entry = Object.entries(u.ExpressionAttributeNames ?? {}).find(([, v]) => v === attr);
  if (!entry) return undefined;
  return u.ExpressionAttributeValues?.[`:v${entry[0].slice(2)}`];
}

const updatesOf = (sk: string) => writes().filter((w) => w.Update?.Key?.SK === sk);

beforeEach(() => {
  fired.length = 0;
  integrations = [];
  ddb.reset();
  resetDynamo();
  ddb.on(GetCommand).resolves({});
  ddb.on(BatchGetCommand).resolves({ Responses: { 'test-table': [] } });
  ddb.on(TransactWriteCommand).resolves({});
  ddb.on(QueryCommand).resolves({ Items: [] });
  ddb.on(UpdateCommand).resolves({});
});

describe('POST /productivity/events — ingesta', () => {
  it('escribe dedupe condicional (índice 0) + raw + proyecciones en una transacción', async () => {
    const ev = env('session.started', { editor: 'vscode 1.105.0', extension_version: '0.1.0', branch: 'feature/MAG-12-login' });
    const res = await service.ingest(caller, ev);
    expect(res).toEqual({ accepted: 1, duplicates: 0, attribution: 'estimated' });

    const items = writes();
    expect(items[0]!.Put!.Item).toMatchObject(keys.dedupe('tenant-a', ev.event_id));
    expect(items[0]!.Put!.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(items[1]!.Put!.Item).toMatchObject({ ...keys.rawEvent('tenant-a', 's1', ev.occurred_at, ev.event_id), entity: 'RawEvent' });
    const sessionUpd = updatesOf('META').find((w) => w.Update!.Key!.PK === keys.sessionPk('tenant-a', 's1'))!;
    expect(setValue(sessionUpd, 'started_at')).toBe(ev.occurred_at);
    expect(setValue(sessionUpd, 'GSI1PK')).toBe('T#tenant-a#P#p1');
    // rama + enlace a la tarea inferida de la rama
    expect(writes().some((w) => w.Update?.Key?.SK === 'BRANCH#feature/MAG-12-login')).toBe(true);
    expect(writes().some((w) => w.Update?.Key?.PK === keys.taskPk('tenant-a', 'MAG-12') && w.Update?.Key?.SK === 'L#session#s1')).toBe(true);
  });

  it('ignora tenant_id del cuerpo: el tenant sale de la API key', async () => {
    const ev = { ...env('session.ended', { reason: 'user' }), tenant_id: 'evil-tenant' };
    await service.ingest(caller, ev);
    for (const w of writes()) {
      const key = (w.Put?.Item ?? w.Update?.Key) as { PK: string };
      expect(key.PK.startsWith('T#tenant-a')).toBe(true);
    }
    expect(JSON.stringify(writes())).not.toContain('evil-tenant');
  });

  it('dedupe: event_id ya registrado ⇒ duplicates, sin escribir', async () => {
    const ev = env('session.ended', { reason: 'user' });
    ddb.on(GetCommand, { Key: keys.dedupe('tenant-a', ev.event_id) }).resolves({ Item: { PK: 'x', SK: 'EVT' } });
    const res = await service.ingest(caller, ev);
    expect(res).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('dedupe por carrera: la condición del dedupe falla ⇒ duplicates, no error', async () => {
    ddb.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      }),
    );
    const res = await service.ingest(caller, env('session.ended', { reason: 'user' }));
    expect(res).toMatchObject({ accepted: 0, duplicates: 1 });
  });

  it('otros fallos de transacción se propagan', async () => {
    ddb.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({ message: 'x', $metadata: {}, CancellationReasons: [{ Code: 'None' }, { Code: 'ValidationError' }] }),
    );
    await expect(service.ingest(caller, env('session.ended', { reason: 'user' }))).rejects.toThrow();
  });

  it('mismo event_id repetido en el lote ⇒ 1 aceptado + 1 duplicado', async () => {
    const ev = env('session.ended', { reason: 'user' });
    const res = await service.ingest(caller, { events: [ev, ev] });
    expect(res).toMatchObject({ accepted: 1, duplicates: 1 });
  });

  it('rechaza eventos fuera de contrato (zod)', async () => {
    await expect(service.ingest(caller, { events: [{ event_type: 'code.accepted' }] })).rejects.toThrow();
    // deployment sin evidence_url
    const bad = env('reference.marked', { tag: 'v1', sha: SHA, kind: 'deployment', included_shas: [], surviving_lines: 0, surviving_effective_lines: 0 });
    await expect(service.ingest(caller, bad)).rejects.toThrow();
  });
});

describe('transiciones de estado del cambio', () => {
  it('máquina de estados monótona', () => {
    expect(nextChangeStatus(undefined, 'proposed')).toBe('proposed');
    expect(nextChangeStatus('proposed', 'accepted')).toBe('accepted');
    expect(nextChangeStatus('proposed', 'rejected')).toBe('rejected');
    expect(nextChangeStatus('accepted', 'rejected')).toBe('accepted');
    expect(nextChangeStatus('rejected', 'accepted')).toBe('accepted');
    expect(nextChangeStatus('accepted', 'committed')).toBe('committed');
    expect(nextChangeStatus('committed', 'accepted')).toBe('committed'); // llegó tarde: no retrocede
    expect(nextChangeStatus('committed', 'proposed')).toBe('committed');
    expect(nextChangeStatus('in_reference', 'committed')).toBe('in_reference');
    expect(nextChangeStatus('committed', 'in_reference')).toBe('in_reference');
  });

  it('proposed → accepted → committed → in_reference en un lote', async () => {
    const t0 = '2026-10-20T10:00:0';
    const events = [
      env('ai.request.completed', { ai_request_id: 'req-1', status: 'ok', latency_ms: 900, usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, output_hash: 'abcdef12' }, { occurred_at: `${t0}1.000Z` }),
      env('code.proposed', { change_id: 'c1', ai_request_id: 'req-1', files, patch_hash: 'abcdef1234' }, { occurred_at: `${t0}2.000Z` }),
      env('code.accepted', { change_id: 'c1', ai_request_id: 'req-1', files, patch_hash: 'abcdef1234', accepted_added_lines: 10, accepted_deleted_lines: 0, dimensions: dims(10) }, { occurred_at: `${t0}3.000Z` }),
      env('git.committed', {
        sha: SHA, committed_at: `${t0}4.000Z`, files, change_ids: ['c1'],
        automation: { commit_added_lines: 12, ai_matched_lines: 10, ai_share: 0.83, ai_lost_lines: 0, effective_lines: 8 },
        has_session_trailer: true, source: 'git-local',
      }, { occurred_at: `${t0}4.000Z` }),
      env('reference.marked', { tag: 'demo-v1', sha: SHA, kind: 'demo-reference', included_shas: [SHA], surviving_lines: 10, surviving_effective_lines: 8 }, { occurred_at: `${t0}5.000Z` }),
    ];
    // la referencia necesita el commit: viene de la caché del lote (no de Dynamo)
    const res = await service.ingest(caller, { events: [...events].reverse() }); // desordenados a propósito
    expect(res).toMatchObject({ accepted: 5, duplicates: 0 });

    const statuses = updatesOf('C#c1').map((u) => setValue(u, 'status'));
    expect(statuses).toEqual(['proposed', 'accepted', 'committed', 'in_reference']);
    const committed = updatesOf('C#c1')[2]!;
    expect(setValue(committed, 'commit_sha')).toBe(SHA);
    // commit: UpdateItem (no Put) para no pisar verified_remote / remote_* del webhook push
    const commitUpd = updatesOf(`COMMIT#${SHA}`).find((u) => setValue(u, 'entity') === 'Commit')!;
    expect(setValue(commitUpd, 'GSI1PK')).toBe(keys.sessionPk('tenant-a', 's1'));
    expect(setValue(commitUpd, 'GSI1SK')).toBe(`COMMIT#${t0}4.000Z`);
    expect(writes().some((w) => w.Put?.Item?.SK === `COMMIT#${SHA}`)).toBe(false);
    expect(writes().some((w) => w.Put?.Item?.SK === 'REF#demo-v1')).toBe(true);
    // AiRequest con GSI1 por key
    const req = writes().find((w) => w.Put?.Item?.SK === 'R#req-1')!;
    expect(req.Put!.Item).toMatchObject({ GSI1PK: 'T#tenant-a#K#key_1', entity: 'AiRequest' });
  });

  it('no retrocede: accepted tardío sobre un cambio ya committed (estado leído de Dynamo)', async () => {
    ddb.on(BatchGetCommand).resolves({
      Responses: { 'test-table': [{ PK: keys.sessionPk('tenant-a', 's1'), SK: 'C#c9', change_id: 'c9', session_id: 's1', status: 'committed' }] },
    });
    await service.ingest(
      caller,
      env('code.accepted', { change_id: 'c9', ai_request_id: 'r', files, patch_hash: 'abcdef1234', accepted_added_lines: 10, accepted_deleted_lines: 0, dimensions: dims(10) }),
    );
    const upd = updatesOf('C#c9')[0]!;
    expect(setValue(upd, 'status')).toBe('committed');
    expect(setValue(upd, 'accepted_added_lines')).toBe(10);
  });

  it('reference.marked marca in_reference los cambios de commits leídos de Dynamo', async () => {
    ddb.on(BatchGetCommand).callsFake((input: { RequestItems: Record<string, { Keys: Array<{ SK: string }> }> }) => {
      const ks = input.RequestItems['test-table']!.Keys;
      if (ks[0]!.SK.startsWith('COMMIT#')) {
        return { Responses: { 'test-table': [{ sha: SHA, repository: 'org/repo', session_id: 's0', change_ids: ['c1', 'c2'] }] } };
      }
      return { Responses: { 'test-table': [{ change_id: 'c1', session_id: 's0', status: 'committed' }, { change_id: 'c2', session_id: 's0', status: 'committed' }] } };
    });
    await service.ingest(
      caller,
      env('reference.marked', { tag: 'prod-1', sha: SHA, kind: 'deployment', evidence_url: 'https://github.com/org/repo/deployments/1', included_shas: [SHA], surviving_lines: 9, surviving_effective_lines: 7 }),
    );
    for (const id of ['c1', 'c2']) {
      const upd = updatesOf(`C#${id}`)[0]!;
      expect(upd.Update!.Key!.PK).toBe(keys.sessionPk('tenant-a', 's0'));
      expect(setValue(upd, 'status')).toBe('in_reference');
      expect(upd.Update!.UpdateExpression).toContain('if_not_exists');
    }
    // los tags se agregan al commit
    expect(updatesOf(`COMMIT#${SHA}`)).toHaveLength(1);
  });
});

const accEv = (o: Record<string, unknown> = {}) =>
  env('code.accepted', { change_id: 'c1', ai_request_id: 'req-2', files, patch_hash: 'abcdef1234', accepted_added_lines: 10, accepted_deleted_lines: 0, dimensions: dims(10) }, { occurred_at: '2026-10-20T10:10:00.000Z', ...o });

describe('scoring en code.accepted', () => {
  it('contexto: cadena de regeneraciones, latencia, tasa de aceptación de la sesión y tipo de tarea', () => {
    const ctx = scoringContextFor(
      { occurred_at: '2026-10-20T10:10:00.000Z', payload: { change_id: 'c3', ai_request_id: 'r3' } },
      [
        { ai_request_id: 'r1', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 1000 }, latency_ms: 500 },
        { ai_request_id: 'r2', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 400 }, latency_ms: 600, regenerates: 'r1' },
        { ai_request_id: 'r3', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 300 }, latency_ms: 700, regenerates: 'r2' },
      ],
      [
        { change_id: 'c1', status: 'rejected', first_seen_at: '2026-10-20T10:00:00.000Z' },
        { change_id: 'c2', status: 'committed', first_seen_at: '2026-10-20T10:01:00.000Z', accepted_at: '2026-10-20T10:02:00.000Z' },
        { change_id: 'c4', status: 'accepted', first_seen_at: '2026-10-20T11:00:00.000Z' }, // posterior: no cuenta
        { change_id: 'c3', status: 'accepted', first_seen_at: '2026-10-20T10:09:00.000Z', accepted_at: '2026-10-20T10:10:00.000Z' },
      ],
      'Bug',
    );
    expect(ctx).toEqual({ tokens_total: 1700, regenerations: 2, latency_ms: 700, session_acceptance_rate: 2 / 3, task_type: 'Bug' });
    // sin cambios previos ni petición: solo el propio cambio
    expect(scoringContextFor({ occurred_at: 'x', payload: { change_id: 'c', ai_request_id: 'nope' } }, [], [])).toMatchObject({
      tokens_total: undefined,
      regenerations: 0,
      session_acceptance_rate: 1,
    });
  });

  it('persiste scores (heurística) en el Change con UpdateItem condicional', async () => {
    ddb.on(QueryCommand).callsFake((input: { ExpressionAttributeValues: Record<string, string> }) => {
      if (input.ExpressionAttributeValues[':sk'] === 'R#') {
        return { Items: [{ ai_request_id: 'req-2', usage: { total_tokens: 900 }, latency_ms: 800, regenerates: 'req-1' }, { ai_request_id: 'req-1', usage: { total_tokens: 100 } }] };
      }
      return { Items: [{ change_id: 'c1', status: 'accepted', first_seen_at: '2026-10-20T10:09:00.000Z', accepted_at: '2026-10-20T10:10:00.000Z' }] };
    });
    ddb.on(GetCommand, { Key: keys.task('tenant-a', 'MAG-12') }).resolves({ Item: { type: 'Bug' } });
    await service.ingest(caller, accEv({ branch: 'feature/MAG-12-x' }));
    const upd = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(upd.Key).toEqual(keys.change('tenant-a', 's1', 'c1'));
    expect(upd.ConditionExpression).toBe('attribute_exists(PK)');
    const scores = upd.ExpressionAttributeValues![':scores'];
    expect(scores).toMatchObject({ model_version: 'heuristic:v1', provenance: 'estimated' });
    expect(scores.survival_probability).toBeGreaterThan(0);
  });

  it('un fallo del scoring no hace fallar la ingesta', async () => {
    ddb.on(UpdateCommand).rejects(new Error('ConditionalCheckFailedException'));
    await expect(service.ingest(caller, accEv())).resolves.toMatchObject({ accepted: 1 });
  });
});

describe('git.committed — UpdateItem que no pisa campos del webhook push', () => {
  const commitEv = (o: Record<string, unknown> = {}, p: Record<string, unknown> = {}) =>
    env('git.committed', {
      sha: SHA, committed_at: '2026-10-20T10:20:00.000Z', files, change_ids: ['c1'],
      automation: { commit_added_lines: 12, ai_matched_lines: 10, ai_share: 0.83, ai_lost_lines: 0, effective_lines: 8 },
      has_session_trailer: true, source: 'git-local', remote_url: 'https://x-token@github.com/org/repo.git', ...p,
    }, { branch: 'feature/MAG-12-login', ...o });

  it('solo SET de campos del IDE; created_at con if_not_exists; task_keys = IDE ∪ push', async () => {
    ddb.on(GetCommand, { Key: keys.commit('tenant-a', 'org/repo', SHA) }).resolves({
      Item: { sha: SHA, repository: 'org/repo', session_id: '', change_ids: [], task_keys: ['MAG-99'], verified_remote: true, remote_only: true },
    });
    await service.ingest(caller, commitEv());
    const upd = updatesOf(`COMMIT#${SHA}`).find((u) => setValue(u, 'entity') === 'Commit')!;
    const names = Object.values(upd.Update!.ExpressionAttributeNames ?? {});
    for (const f of ['verified_remote', 'remote_only', 'remote_branch', 'remote_pushed_at', 'remote_files', 'reference_tags']) expect(names).not.toContain(f);
    expect(upd.Update!.UpdateExpression).toMatch(/if_not_exists\(#n\d+, :v\d+\)/);
    expect(setValue(upd, 'task_keys')).toEqual(['MAG-12', 'MAG-99']);
    expect(setValue(upd, 'remote_url')).toBe('https://github.com/org/repo.git');
    expect(setValue(upd, 'ide_reported_at')).toBe('2026-10-20T12:00:00.000Z');
  });

  it('dispara commit.linked con ref commit:<repo>:<sha> y commit_url del remoto', async () => {
    await service.ingest(caller, commitEv());
    expect(fired).toEqual([
      {
        trigger: 'commit.linked',
        input: {
          tenant_id: 'tenant-a',
          project_id: 'p1',
          task_keys: ['MAG-12'],
          ref: `commit:org/repo:${SHA}`,
          vars: { sha: SHA, repository: 'org/repo', commit_url: `https://github.com/org/repo/commit/${SHA}` },
        },
      },
    ]);
  });

  it('sin cambios IA o sin tarea ⇒ no dispara commit.linked', async () => {
    await service.ingest(caller, commitEv({}, { change_ids: [] }));
    await service.ingest(caller, commitEv({ branch: 'main' }));
    expect(fired).toEqual([]);
  });

  it('un fallo de fireTrigger no rompe la ingesta', async () => {
    const svc = new ProductivityService(undefined, undefined, () => new Date('2026-10-20T12:00:00.000Z'), {
      scoring: createScoringService({ invoker: null }),
      fireTrigger: async () => {
        throw new Error('boom');
      },
      integrations: { listByTenant: async () => [] },
    });
    await expect(svc.ingest(caller, commitEv())).resolves.toMatchObject({ accepted: 1 });
  });
});

describe('session.started / reference.marked — reglas, identidad y claves de tarea', () => {
  it('session.started con tarea dispara session:<id> y guarda key_fingerprint / key_name', async () => {
    await service.ingest(
      { ...caller, key_fingerprint: '1c9e0b7a4d2f', key_name: 'demo key' },
      env('session.started', { editor: 'vscode', extension_version: '0.1.0', branch: 'feature/MAG-12-login', head_sha: SHA }),
    );
    expect(fired).toEqual([
      { trigger: 'session.started', input: { tenant_id: 'tenant-a', project_id: 'p1', task_keys: ['MAG-12'], ref: 'session:s1', vars: { repository: 'org/repo', sha: SHA } } },
    ]);
    const sessionUpd = updatesOf('META').find((w) => w.Update!.Key!.PK === keys.sessionPk('tenant-a', 's1'))!;
    expect(setValue(sessionUpd, 'key_fingerprint')).toBe('1c9e0b7a4d2f');
    expect(setValue(sessionUpd, 'key_name')).toBe('demo key');
  });

  it('reference.marked dispara ref:<repo>:<tag> con las tareas de los commits incluidos', async () => {
    ddb.on(BatchGetCommand).callsFake((input: { RequestItems: Record<string, { Keys: Array<{ SK: string }> }> }) => {
      const ks = input.RequestItems['test-table']!.Keys;
      if (ks[0]!.SK.startsWith('COMMIT#')) {
        return { Responses: { 'test-table': [{ sha: SHA, repository: 'org/repo', session_id: 's1', change_ids: ['c1'], task_keys: ['MAG-7'], remote_url: 'git@github.com:org/repo.git' }] } };
      }
      return { Responses: { 'test-table': [] } };
    });
    await service.ingest(caller, env('reference.marked', { tag: 'demo-v1', sha: SHA, kind: 'demo-reference', included_shas: [SHA], surviving_lines: 9, surviving_effective_lines: 7 }));
    expect(fired).toEqual([
      {
        trigger: 'reference.marked',
        input: {
          tenant_id: 'tenant-a',
          project_id: 'p1',
          task_keys: ['MAG-7'],
          ref: 'ref:org/repo:demo-v1',
          vars: { sha: SHA, repository: 'org/repo', commit_url: `https://github.com/org/repo/commit/${SHA}` },
        },
      },
    ]);
  });

  it('ramas con falsos positivos (fix/utf-8) no crean tareas; con Jira configurado solo sus prefijos', async () => {
    await service.ingest(caller, env('session.started', { editor: 'vscode', extension_version: '0.1.0', branch: 'fix/utf-8-iso-8601' }));
    expect(writes().some((w) => (w.Update?.Key?.PK ?? '').includes('#TASK#'))).toBe(false);
    expect(fired).toEqual([]);

    integrations = [{ project_id: 'p1', status: 'active', task_project_keys: ['MAG'] }];
    ddb.resetHistory();
    await service.ingest(caller, env('session.started', { editor: 'vscode', extension_version: '0.1.0', branch: 'feature/OPS-3-MAG-12' }));
    const taskPks = writes().map((w) => w.Update?.Key?.PK ?? '').filter((pk) => pk.includes('#TASK#'));
    expect(new Set(taskPks)).toEqual(new Set([keys.taskPk('tenant-a', 'MAG-12')]));
  });

  it('eventTaskKeys aplica el mismo filtro que los webhooks', () => {
    const ev = env('session.started', { editor: 'v', extension_version: '1', branch: 'fix/UTF-8' }, { task_key: 'SHA-256' }) as never;
    expect(eventTaskKeys(ev)).toEqual([]);
    const ev2 = env('session.started', { editor: 'v', extension_version: '1', branch: 'feature/mag-5' }) as never;
    expect(eventTaskKeys(ev2)).toEqual(['MAG-5']);
    expect(eventTaskKeys(ev2, ['OPS'])).toEqual([]);
  });
});

describe('counts.tasks — mismo universo que GET /tasks (Jira ∪ enlazadas)', () => {
  const data = { sessions: [{ task_key: 'MAG-1' }, {}], changes: [{ task_key: 'MAG-2' }], commits: [{ task_keys: ['MAG-1', 'MAG-3'] }] };
  it('une Task de Jira en la ventana con las claves de sesiones/cambios/commits', () => {
    expect([...scopeTaskKeys({}, data, ['MAG-9', 'MAG-1'])].sort()).toEqual(['MAG-1', 'MAG-2', 'MAG-3', 'MAG-9']);
  });
  it('con filtro de sesión/repo/rama solo cuentan las enlazadas; ?task_key la acota', () => {
    expect([...scopeTaskKeys({ session_id: 's1' }, data, ['MAG-9'])].sort()).toEqual(['MAG-1', 'MAG-2', 'MAG-3']);
    expect([...scopeTaskKeys({ task_key: 'MAG-2' }, data, ['MAG-9'])]).toEqual(['MAG-2']);
  });
});
