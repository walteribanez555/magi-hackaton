import { describe, expect, it } from 'vitest';
import { IntegrationHealth, IntegrationTestRun, keys, ProjectReadiness, REQUIRED_WEBHOOK_EVENTS, RepositoryReadiness } from '@magicode/contracts';
import { HttpException } from '../../../common/exceptions';
import { JIRA_CREDS } from '../../task-sync/__tests__/helpers';
import { fixture } from '../../webhooks/__tests__/helpers';
import { ProviderError } from '../../task-sync/provider-http';
import { summaryWarnings } from '../summary-warnings';
import { fakeHookApi, GH, harness, JIRA, SECRET, T, T0 } from './harness';

const GH_CREDS = { provider: 'github' as const, token: 'ghp_fake_token_not_real_0000000000' };
const iso = (ms: number) => new Date(ms).toISOString();

const httpError = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as HttpException;

describe('contabilidad de entregas (webhook → IntHealth)', () => {
  it('cuenta aceptadas, duplicadas, ignoradas y firmas inválidas por hora, sin guardar payloads', async () => {
    const h = harness();
    h.addIntegration({ integration_id: GH, provider: 'github', repository: 'acme/shop' });
    await h.webhooks.handle(h.request('github', GH, 'github-push.json', 'push', { delivery: 'd1' }));
    await expect(h.webhooks.handle(h.request('github', GH, 'github-push.json', 'push', { delivery: 'd2', secret: 'b'.repeat(64) }))).rejects.toThrow();
    h.advance(60_000);
    await h.webhooks.handle(h.request('github', GH, 'github-push.json', 'push', { delivery: 'd1' })); // duplicada
    await h.webhooks.handle(h.request('github', GH, 'github-ping.json', 'star', { delivery: 'd3' })); // ignorada

    const bucket = h.store.getSync({ PK: `T#${T}#INT#${GH}`, SK: 'HEALTH#H#2026-10-20T20' })!;
    expect(bucket).toMatchObject({ entity: 'IntHealthBucket', accepted: 1, rejected_signature: 1, duplicate: 1, ignored: 1 });
    expect(bucket.expires_at).toBe(T0 / 1000 + 3 * 86_400);
    const item = h.store.getSync(keys.integrationHealth(T, GH))!;
    expect(item).toMatchObject({
      'last_event_at:push': iso(T0 + 60_000),
      'last_event_at:star': iso(T0 + 60_000),
      last_accepted_at: iso(T0),
      last_rejected_signature_at: iso(T0),
      last_error: expect.stringContaining('INVALID_SIGNATURE'),
    });
    const all = JSON.stringify(h.store.all('HEALTH'));
    expect(all).not.toContain('add login form');
    expect(all).not.toContain(SECRET);

    const health = await h.health.health(T, GH);
    expect(IntegrationHealth.parse(health)).toBeTruthy();
    expect(health.deliveries_24h).toEqual({ accepted: 1, duplicate: 1, ignored: 1, rejected_signature: 1, rejected_other: 0 });
    expect(health.last_event_at).toMatchObject({ push: iso(T0 + 60_000) });
    // hubo un rechazo pero después llegaron entregas válidas ⇒ warn (¿webhook duplicado?)
    expect(health.checks.find((c) => c.id === 'signature_valid')!.status).toBe('warn');
  });

  it('firma inválida como última entrega ⇒ failing con acción rotate_secret', async () => {
    const h = harness();
    h.addIntegration({ integration_id: GH, provider: 'github', repository: 'acme/shop', status: 'pending' });
    await expect(h.webhooks.handle(h.request('github', GH, 'github-push.json', 'push', { secret: 'b'.repeat(64) }))).rejects.toThrow();
    const health = await h.health.health(T, GH);
    expect(health.status).toBe('failing');
    expect(health.checks.find((c) => c.id === 'signature_valid')).toMatchObject({ status: 'fail', action: 'rotate_secret' });
  });

  it('otros rechazos (JSON inválido, integración deshabilitada) cuentan como rejected_other; integración inexistente no registra nada', async () => {
    const h = harness();
    h.addIntegration({ integration_id: GH, provider: 'github', repository: 'acme/shop' });
    await expect(h.webhooks.handle(h.request('github', GH, 'not-json', 'push'))).rejects.toThrow();
    await expect(h.webhooks.handle(h.request('github', 'int_ffffffffffffffff', 'github-push.json', 'push'))).rejects.toThrow();
    expect((await h.health.health(T, GH)).deliveries_24h.rejected_other).toBe(1);
    expect(h.store.all('HEALTH').filter((i) => String(i.PK).includes('int_ffff'))).toHaveLength(0);
  });
});

describe('prueba de ida y vuelta', () => {
  it('GitHub auto: ping → el webhook recibe `ping` firmado → passed con latencia', async () => {
    const h = harness();
    h.addIntegration({ integration_id: GH, provider: 'github', repository: 'acme/shop', credentials_configured_at: iso(T0) });
    h.creds.saved.set(GH, GH_CREDS);
    const { api, calls } = fakeHookApi({
      hooks: [{ id: '77', url: `https://api.example.com/api/v1/webhooks/github/${GH}`, active: true, events: REQUIRED_WEBHOOK_EVENTS.github }],
      ping: async (hookId: string) => {
        calls.push({ fn: 'ping', args: [hookId] });
        h.advance(350); // el proveedor entrega el ping mientras seguimos dentro de startTest
        await h.webhooks.handle(h.request('github', GH, 'github-ping.json', 'ping'));
      },
    });
    h.apis.set(GH, api);

    const started = await h.health.startTest(T, GH, { mode: 'auto' });
    expect(IntegrationTestRun.parse(started)).toBeTruthy();
    expect(calls.find((c) => c.fn === 'ping')!.args).toEqual(['77']);
    const run = await h.health.getTest(T, GH, started.test_id);
    expect(run).toMatchObject({ mode: 'auto', status: 'passed', latency_ms: 350 });
    expect(run.steps.map((s) => [s.name, s.status])).toEqual([
      ['Ping enviado al proveedor', 'pass'],
      ['Evento recibido', 'pass'],
      ['Firma válida', 'pass'],
      ['Procesado', 'pass'],
    ]);
    expect(h.lookup(GH).pending_test).toBeNull();
    const health = await h.health.health(T, GH);
    expect(health.last_test).toMatchObject({ test_id: started.test_id, status: 'passed' });
    expect(health.checks.find((c) => c.id === 'roundtrip_test')!.status).toBe('pass');
  });

  it('GitHub auto sin webhook registrado → failed en el paso de disparo', async () => {
    const h = harness();
    h.addIntegration({ integration_id: GH, provider: 'github', repository: 'acme/shop', credentials_configured_at: iso(T0) });
    h.creds.saved.set(GH, GH_CREDS);
    h.apis.set(GH, fakeHookApi({ hooks: [], ping: async () => {} }).api);
    const run = await h.health.startTest(T, GH, {});
    expect(run.status).toBe('failed');
    expect(run.steps[0]).toMatchObject({ status: 'fail', message: expect.stringContaining('regístralo primero') });
    expect(h.lookup(GH).pending_test).toBeNull();
  });

  it('Jira auto: etiqueta magicode-healthcheck → entrega de prueba (no la descarta el anti-bucle ni proyecta la tarea)', async () => {
    const h = harness();
    h.addIntegration({ integration_id: JIRA, provider: 'jira', task_project_keys: ['MAG'], credentials_configured_at: iso(T0), service_account_id: 'fake-svc-1' });
    h.creds.saved.set(JIRA, JIRA_CREDS);
    h.store.put({ ...keys.task(T, 'MAG-1'), task_key: 'MAG-1', title: 'Original', status: 'Por hacer', updated_at: 'old' });
    const labelPayload = (from: string, to: string) => {
      const p = fixture<Record<string, Record<string, unknown>>>('jira-issue_updated.json');
      return { ...p, user: { accountId: 'fake-svc-1' }, issue: { ...p.issue, key: 'MAG-1' }, changelog: { items: [{ field: 'labels', fieldId: 'labels', fromString: from, toString: to }] } };
    };
    const responses: unknown[] = [];
    h.apis.set(
      JIRA,
      fakeHookApi({
        toggleHealthcheckLabel: async (key: string, label: string) => {
          expect([key, label]).toEqual(['MAG-1', 'magicode-healthcheck']);
          h.advance(800);
          responses.push(await h.webhooks.handle(h.request('jira', JIRA, labelPayload('backend', 'backend magicode-healthcheck'))));
          responses.push(await h.webhooks.handle(h.request('jira', JIRA, labelPayload('backend magicode-healthcheck', 'backend'))));
        },
      }).api,
    );
    await expect(h.health.startTest(T, JIRA, { mode: 'auto' })).rejects.toSatisfy((e) => e instanceof HttpException && e.statusCode === 400);
    const started = await h.health.startTest(T, JIRA, { mode: 'auto', test_issue_key: 'MAG-1' });
    expect(responses[0]).toEqual({ status: 200, body: { ok: true, test: true } });
    const run = await h.health.getTest(T, JIRA, started.test_id);
    expect(run).toMatchObject({ status: 'passed', latency_ms: 800 });
    expect(h.store.getSync(keys.task(T, 'MAG-1'))).toMatchObject({ title: 'Original', status: 'Por hacer', updated_at: iso(T0 + 800) });
  });

  it('manual (sin credenciales): instrucciones y pasa con la próxima entrega firmada', async () => {
    const h = harness();
    h.addIntegration({ integration_id: GH, provider: 'github', repository: 'acme/shop' });
    const started = await h.health.startTest(T, GH, { mode: 'auto' });
    expect(started).toMatchObject({ mode: 'manual', status: 'pending', instructions: expect.stringContaining('Redeliver') });
    expect(started.steps.map((s) => s.name)).toEqual(['Evento recibido', 'Firma válida', 'Procesado']);
    h.advance(5_000);
    await h.webhooks.handle(h.request('github', GH, 'github-push.json', 'push'));
    expect(await h.health.getTest(T, GH, started.test_id)).toMatchObject({ status: 'passed', latency_ms: 5_000 });
  });

  it('timeout perezoso: manual a los 15 min → timeout y roundtrip_test fail', async () => {
    const h = harness();
    h.addIntegration({ integration_id: GH, provider: 'github', repository: 'acme/shop' });
    const started = await h.health.startTest(T, GH, { mode: 'manual' });
    h.advance(16 * 60_000);
    const run = await h.health.getTest(T, GH, started.test_id);
    expect(run.status).toBe('timeout');
    expect(run.steps.every((s) => s.status === 'fail')).toBe(true);
    expect(h.lookup(GH).pending_test).toBeNull();
    // una entrega tardía ya no la cambia
    await h.webhooks.handle(h.request('github', GH, 'github-push.json', 'push'));
    expect((await h.health.getTest(T, GH, started.test_id)).status).toBe('timeout');
    expect((await h.health.health(T, GH)).checks.find((c) => c.id === 'roundtrip_test')!.status).toBe('fail');
  });

  it('firma inválida durante la prueba → failed con diagnóstico', async () => {
    const h = harness();
    h.addIntegration({ integration_id: GH, provider: 'github', repository: 'acme/shop' });
    const started = await h.health.startTest(T, GH, { mode: 'manual' });
    await expect(h.webhooks.handle(h.request('github', GH, 'github-ping.json', 'ping', { secret: 'b'.repeat(64) }))).rejects.toThrow();
    const run = await h.health.getTest(T, GH, started.test_id);
    expect(run.status).toBe('failed');
    expect(run.steps.find((s) => s.name === 'Firma válida')).toMatchObject({ status: 'fail', message: expect.stringContaining('secreto') });
  });

  it('Bitbucket auto: verificación vía API + último evento (resultado inmediato)', async () => {
    const h = harness();
    h.addIntegration({ integration_id: GH, provider: 'bitbucket', repository: 'acme/payments', credentials_configured_at: iso(T0) });
    h.creds.saved.set(GH, { provider: 'bitbucket', username: 'ana', app_password: 'fake-app-password' });
    h.apis.set(GH, fakeHookApi({ hooks: [{ id: '{uuid}', url: `https://api.example.com/api/v1/webhooks/bitbucket/${GH}`, active: true, events: [] }] }).api);
    const run = await h.health.startTest(T, GH, {});
    expect(run.status).toBe('failed'); // webhook OK pero nunca llegó un evento
    expect(run.steps.map((s) => s.status)).toEqual(['pass', 'fail']);
  });
});

describe('registro del webhook', () => {
  it('sin credenciales → 422 con URL y eventos para hacerlo a mano (nunca el secreto)', async () => {
    const h = harness();
    h.addIntegration({ integration_id: GH, provider: 'github', repository: 'acme/shop' });
    const err = await httpError(h.health.registerWebhook(T, GH));
    expect(err.statusCode).toBe(422);
    expect(err.details).toMatchObject({ url: `https://api.example.com/api/v1/webhooks/github/${GH}`, events: REQUIRED_WEBHOOK_EVENTS.github.join(', ') });
    expect(JSON.stringify(err.details)).not.toContain(SECRET);
  });

  it('crea el webhook con URL + secreto + eventos requeridos y luego lo actualiza', async () => {
    const h = harness();
    h.addIntegration({ integration_id: GH, provider: 'github', repository: 'acme/shop', credentials_configured_at: iso(T0) });
    h.creds.saved.set(GH, GH_CREDS);
    const { api, calls } = fakeHookApi();
    h.apis.set(GH, api);
    expect(await h.health.registerWebhook(T, GH)).toEqual({ provider_hook_id: '901', created: true, events: REQUIRED_WEBHOOK_EVENTS.github });
    expect(calls.find((c) => c.fn === 'createHook')!.args[0]).toMatchObject({ url: `https://api.example.com/api/v1/webhooks/github/${GH}`, secret: SECRET, events: REQUIRED_WEBHOOK_EVENTS.github });
    expect(h.lookup(GH).provider_hook_id).toBe('901');
    expect((await h.health.registerWebhook(T, GH)).created).toBe(false);
  });

  it('Jira sin permisos de administrador (403) → mensaje para crearlo a mano con JQL', async () => {
    const h = harness();
    h.addIntegration({ integration_id: JIRA, provider: 'jira', task_project_keys: ['MAG', 'OPS'], credentials_configured_at: iso(T0) });
    h.creds.saved.set(JIRA, JIRA_CREDS);
    h.apis.set(JIRA, fakeHookApi({ listHooks: async () => Promise.reject(new ProviderError('jira GET webhooks: HTTP 403', 403, false)) }).api);
    const err = await httpError(h.health.registerWebhook(T, JIRA));
    expect(err).toMatchObject({ statusCode: 403, code: 'PROVIDER_FORBIDDEN' });
    expect(err.message).toMatch(/administrador/);
    expect(err.details).toMatchObject({ jql: 'project in (MAG, OPS)', events: 'jira:issue_created, jira:issue_updated, jira:issue_deleted' });
  });
});

describe('checks contra el proveedor (refresh=true)', () => {
  it('webhook ausente → fail; eventos faltantes → warn; última respuesta 401 según GitHub → fail; se cachea', async () => {
    const h = harness();
    h.addIntegration({ integration_id: GH, provider: 'github', repository: 'acme/shop', credentials_configured_at: iso(T0) });
    h.creds.saved.set(GH, GH_CREDS);
    h.apis.set(GH, fakeHookApi({ hooks: [] }).api);
    let health = await h.health.health(T, GH, true);
    expect(health.checks.find((c) => c.id === 'webhook_registered')).toMatchObject({ status: 'fail', action: 'register_webhook' });
    expect(health.status).toBe('failing');

    h.apis.set(
      GH,
      fakeHookApi({
        hooks: [{ id: '77', url: `https://api.example.com/api/v1/webhooks/github/${GH}`, active: true, events: ['push', 'pull_request'] }],
        deliveries: async () => [{ status_code: 401, event: 'push', delivered_at: iso(T0) }],
      }).api,
    );
    health = await h.health.health(T, GH, true);
    const byId = Object.fromEntries(health.checks.map((c) => [c.id, c]));
    expect(byId.credentials_valid!.status).toBe('pass');
    expect(byId.webhook_registered).toMatchObject({ status: 'pass', details: { hook_id: '77' } });
    expect(byId.webhook_events).toMatchObject({ status: 'warn', details: { missing: 'create,delete,deployment_status' } });
    expect(byId.provider_last_response).toMatchObject({ status: 'fail', details: { status_code: 401 } });
    expect(h.lookup(GH).provider_hook_id).toBe('77');

    h.apis.delete(GH); // sin refresh no se llama al proveedor: se usa la caché
    const cached = await h.health.health(T, GH);
    expect(cached.checks.find((c) => c.id === 'provider_last_response')!.status).toBe('fail');
  });

  it('credenciales rechazadas → credentials_valid fail', async () => {
    const h = harness();
    h.addIntegration({ integration_id: GH, provider: 'github', repository: 'acme/shop', credentials_configured_at: iso(T0) });
    h.creds.saved.set(GH, GH_CREDS);
    h.apis.set(GH, fakeHookApi({ verify: async () => Promise.reject(new ProviderError('github GET repo: HTTP 401', 401, false)) }).api);
    const health = await h.health.health(T, GH, true);
    expect(health.checks.find((c) => c.id === 'credentials_valid')).toMatchObject({ status: 'fail', action: 'add_credentials' });
  });
});

describe('readiness por repositorio', () => {
  function setup() {
    const h = harness();
    h.addIntegration({ integration_id: GH, provider: 'github', repository: 'acme/shop' });
    h.addIntegration({ integration_id: JIRA, provider: 'jira', task_project_keys: ['MAG'] });
    h.store.put({ ...keys.project(T, 'shop'), project_id: 'shop', repositories: new Set(['acme/shop', 'acme/api']) });
    const session = (id: string, repo: string, key: string, hoursAgo: number) =>
      h.store.put({
        ...keys.session(T, id),
        ...keys.sessionGsi1(T, 'shop', iso(T0 - hoursAgo * 3_600_000), id),
        session_id: id,
        repository: repo,
        key_id: key,
        started_at: iso(T0 - hoursAgo * 3_600_000),
        last_activity_at: iso(T0 - hoursAgo * 3_600_000 + 600_000),
      });
    session('s1', 'acme/shop', 'key_A', 2);
    session('s2', 'acme/shop', 'key_B', 30);
    session('s3', 'acme/api', 'key_B', 5);
    return h;
  }

  it('repo sin webhook propio → no listo; el proyecto no está listo; claves dedicadas/compartidas', async () => {
    const h = setup();
    // ambos webhooks del repo acme/shop reciben eventos válidos
    await h.webhooks.handle(h.request('github', GH, 'github-push.json', 'push'));
    await h.webhooks.handle(h.request('jira', JIRA, 'jira-issue_updated.json'));

    const pr = await h.health.projectReadiness(T, 'shop');
    expect(ProjectReadiness.parse(pr)).toBeTruthy();
    expect(pr.ready).toBe(false);
    expect(pr.repositories.map((r) => [r.repository, r.ready])).toEqual([
      ['acme/api', false],
      ['acme/shop', true],
    ]);
    const api = pr.repositories[0]!;
    expect(api.repository_webhook.status).toBe('not_configured');
    expect(api.tasks_webhook.integration_id).toBe(JIRA); // la integración de tareas del proyecto cubre a todos sus repos
    expect(api.blocking_reasons[0]).toMatch(/Falta conectar el repositorio/);
    expect(pr.blocking_reasons[0]).toMatch(/^acme\/api: Falta conectar el repositorio/);

    const shop = pr.repositories[1]!;
    expect(RepositoryReadiness.parse(shop)).toBeTruthy();
    expect(shop.repository_webhook.status).toBe('degraded'); // sin prueba de ida y vuelta aún
    expect(shop.ide).toEqual({ last_event_at: iso(T0 - 2 * 3_600_000 + 600_000), sessions_7d: 2 });
    expect(shop.api_keys.map((k) => [k.key_id, k.usage, k.sessions_7d])).toEqual([
      ['key_A', 'dedicated', 1],
      ['key_B', 'shared', 1],
    ]);

    const options = await h.health.repositoryOptions(T, 'shop');
    expect(options).toEqual([
      { repository: 'acme/api', project_id: 'shop', ready: false, status: 'not_configured' },
      { repository: 'acme/shop', project_id: 'shop', ready: true, status: 'degraded' },
    ]);
  });

  it('webhook creado pero sin entregas → awaiting_first_delivery bloquea; repositoryReadiness infiere el proyecto', async () => {
    const h = setup();
    const r = await h.health.repositoryReadiness(T, 'acme/shop');
    expect(r.project_id).toBe('shop');
    expect(r.ready).toBe(false);
    expect(r.repository_webhook.status).toBe('awaiting_first_delivery');
    expect(r.blocking_reasons).toEqual([
      expect.stringContaining('El webhook del repositorio (GitHub) aún no envió ningún evento válido'),
      expect.stringContaining('El webhook del gestor de tareas (Jira) aún no envió'),
    ]);
    await expect(h.health.repositoryReadiness(T, 'acme/unknown')).rejects.toSatisfy((e) => e instanceof HttpException && e.statusCode === 404);
  });

  it('commits del IDE sin push verificado y claves sin tarea → advertencias de reconciliación', async () => {
    const h = setup();
    h.store.put({ ...keys.commit(T, 'acme/shop', 'f'.repeat(40)), sha: 'f'.repeat(40), commit_source: 'git-local', committed_at: iso(T0 - 3 * 3_600_000) });
    h.store.put({ ...keys.commit(T, 'acme/shop', 'e'.repeat(40)), sha: 'e'.repeat(40), commit_source: 'git-local', committed_at: iso(T0 - 600_000) }); // < 1 h
    h.store.put({ ...keys.branch(T, 'acme/shop', 'feature/MAG-7'), ...keys.branchGsi1(T, 'shop', iso(T0)), branch: 'feature/MAG-7', task_keys: new Set(['MAG-7', 'OPS-1']) });
    const gh = await h.health.health(T, GH);
    expect(gh.checks.find((c) => c.id === 'commits_reconciled')).toMatchObject({ status: 'warn', details: { unverified_commits: 1 } });
    const jira = await h.health.health(T, JIRA);
    expect(jira.checks.find((c) => c.id === 'tasks_reconciled')).toMatchObject({ status: 'warn', details: { missing: 'MAG-7', count: 1 } });
  });

  it('varias integraciones de tareas: gana la que cubre las claves de las ramas del repo', async () => {
    const h = setup();
    h.addIntegration({ integration_id: 'int_bbbbbbbbbbbbbbbb', provider: 'jira', task_project_keys: ['OPS'] });
    h.store.put({ ...keys.branch(T, 'acme/shop', 'feature/OPS-1'), branch: 'feature/OPS-1', task_keys: new Set(['OPS-1']) });
    const r = await h.health.repositoryReadiness(T, 'acme/shop', 'shop');
    expect(r.tasks_webhook.integration_id).toBe('int_bbbbbbbbbbbbbbbb');
  });

  it('proyecto sin repos → no listo con motivo', async () => {
    const h = harness();
    const pr = await h.health.projectReadiness(T, 'empty');
    expect(pr).toMatchObject({ ready: false, repositories: [] });
    expect(pr.blocking_reasons.length).toBe(2);
  });
});

describe('summaryWarnings', () => {
  const svc = {
    projectReadiness: async () =>
      ({ project_id: 'shop', ready: false, repositories: [{ repository: 'acme/api', ready: false, blocking_reasons: ['Falta conectar el repositorio'] }, { repository: 'acme/shop', ready: true, blocking_reasons: [] }], blocking_reasons: [], evaluated_at: '' }) as never,
    repositoryReadiness: async () => ({ repository: 'acme/shop', ready: true, blocking_reasons: [] }) as never,
  };
  const base = { to: iso(T0 - 5 * 60_000), now: iso(T0), usage: null, changes: [] };

  it('project_not_ready nombra los repos no listos; repo listo → sin aviso', async () => {
    const w = await summaryWarnings(T, { ...base, project_id: 'shop' }, svc);
    expect(w).toEqual([{ code: 'project_not_ready', message: expect.stringContaining('acme/api (Falta conectar el repositorio)') }]);
    expect(await summaryWarnings(T, { ...base, project_id: 'shop', repository: 'acme/shop' }, svc)).toEqual([]);
    expect(await summaryWarnings(T, { ...base }, svc)).toEqual([]);
  });

  it('usage_ingestion_delay y scoring_heuristic', async () => {
    const w = await summaryWarnings(T, { ...base, usage: { ingestion_delay_minutes: 15 }, changes: [{ scores: { model_version: 'heuristic:v1' } }] }, svc);
    expect(w.map((x) => x.code)).toEqual(['usage_ingestion_delay', 'scoring_heuristic']);
  });

  it('un fallo de readiness no rompe el resumen', async () => {
    const broken = { ...svc, projectReadiness: async () => Promise.reject(new Error('dynamo down')) };
    expect(await summaryWarnings(T, { ...base, project_id: 'shop' }, broken)).toEqual([]);
  });
});
