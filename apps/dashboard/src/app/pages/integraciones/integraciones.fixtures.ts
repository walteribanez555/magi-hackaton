import type {
  CheckResult,
  Integration,
  IntegrationCreate,
  IntegrationCreated,
  IntegrationHealth,
  IntegrationTestRun,
  RepositoryOption,
  RepositoryReadiness,
} from '@magicode/contracts';

/** Datos de ejemplo para `ng serve --configuration mock` (sin backend). */

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const chk = (id: CheckResult['id'], status: CheckResult['status'], message: string, action: CheckResult['action'] = null): CheckResult => ({
  id,
  status,
  message,
  action,
  checked_at: ago(1),
});

export function fixtureRepositories(): RepositoryOption[] {
  return [
    { repository: 'magihub/magicode-demo', project_id: 'magicode-demo', ready: false, status: 'awaiting_first_delivery' },
    { repository: 'magihub/magicode-api', project_id: 'magicode-demo', ready: true, status: 'healthy' },
    { repository: 'acme/checkout-web', project_id: 'checkout', ready: false, status: 'not_configured' },
  ];
}

export function fixtureIntegrations(): Integration[] {
  const base = { tenant_id: 'tnt_demo', status: 'active' as const, created_at: ago(60 * 24 * 3) };
  return [
    {
      ...base,
      integration_id: 'int_gh_demo',
      project_id: 'magicode-demo',
      provider: 'github',
      repository: 'magihub/magicode-demo',
      webhook_url: 'https://api.example.com/api/v1/webhooks/github/int_gh_demo',
      last_delivery_at: ago(12),
    },
    {
      ...base,
      integration_id: 'int_gh_api',
      project_id: 'magicode-demo',
      provider: 'github',
      repository: 'magihub/magicode-api',
      webhook_url: 'https://api.example.com/api/v1/webhooks/github/int_gh_api',
      last_delivery_at: ago(40),
    },
    {
      ...base,
      integration_id: 'int_jira_mag',
      project_id: 'magicode-demo',
      provider: 'jira',
      task_project_keys: ['MAG'],
      webhook_url: 'https://api.example.com/api/v1/webhooks/jira/int_jira_mag',
      status: 'pending',
      last_delivery_at: null,
      created_at: ago(25),
    },
  ];
}

const repoHealthy = (id: string): IntegrationHealth => ({
  integration_id: id,
  role: 'repository',
  provider: 'github',
  status: 'degraded',
  checks: [
    chk('credentials_valid', 'pass', 'Token con permiso de webhooks sobre el repositorio.'),
    chk('webhook_registered', 'pass', 'Hook 48211907 apunta a la URL de esta integración.'),
    chk('webhook_events', 'pass', 'push, create, delete, pull_request, deployment_status.'),
    chk('signature_valid', 'pass', '41 entregas válidas en 24 h, ninguna rechazada.'),
    chk('provider_last_response', 'pass', 'Las últimas 10 entregas respondieron 202.'),
    chk('roundtrip_test', 'pass', 'Ping recibido en 1,4 s, hoy 11:20.', 'run_test'),
    chk('commits_reconciled', 'warn', '3 commits registrados en el IDE hace más de 1 h no llegaron por push. ¿Falta git push?'),
  ],
  deliveries_24h: { accepted: 41, duplicate: 2, ignored: 3, rejected_signature: 0, rejected_other: 0 },
  last_event_at: { push: ago(12) },
  last_delivery_at: ago(12),
  last_error: null,
  last_test: { test_id: 'tst_91ab', status: 'passed', finished_at: ago(90) },
  can_auto_register: true,
});

const tasksAwaiting = (): IntegrationHealth => ({
  integration_id: 'int_jira_mag',
  role: 'tasks',
  provider: 'jira',
  status: 'awaiting_first_delivery',
  checks: [
    chk('credentials_valid', 'pass', 'Conectado como cuenta de servicio magicode-bot.'),
    chk('webhook_registered', 'fail', 'La cuenta no es administradora de Jira: crea el webhook a mano con la URL y el secreto.', 'register_webhook'),
    chk('signature_valid', 'skipped', 'Aún no llega ninguna entrega.'),
    chk('roundtrip_test', 'skipped', 'Sin prueba reciente.', 'run_test'),
    chk('tasks_reconciled', 'warn', 'MAG-131 y MAG-140 aparecen en ramas pero no existen en el gestor.'),
  ],
  deliveries_24h: { accepted: 0, duplicate: 0, ignored: 0, rejected_signature: 0, rejected_other: 0 },
  last_event_at: {},
  last_delivery_at: null,
  last_error: null,
  last_test: null,
  can_auto_register: false,
});

const notConfigured = (role: 'repository' | 'tasks'): IntegrationHealth => ({
  integration_id: null,
  role,
  provider: null,
  status: 'not_configured',
  checks: [
    chk(
      'integration_exists',
      'fail',
      role === 'repository' ? 'No hay integración para este repositorio.' : 'No hay integración de tareas en este proyecto.',
      'create_integration',
    ),
  ],
  deliveries_24h: { accepted: 0, duplicate: 0, ignored: 0, rejected_signature: 0, rejected_other: 0 },
  last_event_at: {},
  last_delivery_at: null,
  last_error: null,
  last_test: null,
  can_auto_register: false,
});

export function fixtureHealth(integrationId: string): IntegrationHealth {
  return integrationId === 'int_jira_mag' ? tasksAwaiting() : repoHealthy(integrationId);
}

export function fixtureReadiness(repository: string, projectId: string): RepositoryReadiness {
  const known = repository.startsWith('magihub/');
  return {
    repository,
    project_id: projectId,
    ready: false,
    api_keys: known
      ? [
          { key_id: 'k1', key_fingerprint: 'key_8f3a91c2', key_name: 'demo-hackathon', last_used_at: ago(12), sessions_7d: 6, usage: 'dedicated' },
          { key_id: 'k2', key_fingerprint: 'key_c07d55e1', key_name: null, last_used_at: ago(60 * 20), sessions_7d: 1, usage: 'shared' },
        ]
      : [],
    repository_webhook: known ? repoHealthy(repository.endsWith('api') ? 'int_gh_api' : 'int_gh_demo') : notConfigured('repository'),
    tasks_webhook: known ? tasksAwaiting() : notConfigured('tasks'),
    ide: { last_event_at: ago(12), sessions_7d: 7 },
    blocking_reasons: [],
    evaluated_at: ago(1),
  };
}

export function fixtureCreated(body: IntegrationCreate): IntegrationCreated {
  const id = `int_${body.provider}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    integration_id: id,
    tenant_id: 'tnt_demo',
    project_id: body.project_id,
    provider: body.provider,
    repository: 'repository' in body ? body.repository : undefined,
    task_project_keys: 'task_project_keys' in body ? body.task_project_keys : undefined,
    webhook_url: `https://api.example.com/api/v1/webhooks/${body.provider}/${id}`,
    status: 'pending',
    last_delivery_at: null,
    created_at: new Date().toISOString(),
    webhook_secret: 'whsec_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
  };
}

/** Prueba que avanza un paso por cada consulta. */
export function fixtureTestRun(integrationId: string, mode: 'auto' | 'manual', tick: number): IntegrationTestRun {
  const names = ['Ping enviado al proveedor', 'Evento recibido', 'Firma válida', 'Procesado'];
  const done = Math.min(tick, names.length);
  return {
    test_id: 'tst_4f1c',
    integration_id: integrationId,
    mode,
    status: done >= names.length ? 'passed' : 'pending',
    steps: names.map((name, i) => ({
      name,
      status: i < done ? 'pass' : 'pending',
      at: i < done ? new Date().toISOString() : null,
      message: i < done ? null : i === done ? 'Esperando…' : null,
    })),
    instructions: mode === 'manual' ? 'En el proveedor, abre el webhook y pulsa «Redeliver» en la última entrega.' : null,
    started_at: ago(0),
    finished_at: done >= names.length ? new Date().toISOString() : null,
    latency_ms: done >= 2 ? 1400 : null,
  };
}
