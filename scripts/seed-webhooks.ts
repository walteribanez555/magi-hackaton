/**
 * "Caso de ejemplo" (2ª parte) — completa la demo enviando entregas de webhook FIRMADAS por el
 * pipeline real (/webhooks/{provider}/{integration_id}): Jira (tareas) y GitHub (push, PR, deploy).
 *
 *   npx tsx scripts/seed-demo.ts        # primero: sesiones + commits del IDE (simulados)
 *   npx tsx scripts/seed-webhooks.ts    # después: este script
 *
 * Env: API_URL (default: la API dev desplegada), MAGICODE_API_KEY (opcional; sin ella usa el modo demo).
 *
 * TODO ES DATO DE DEMO: el repositorio `magihub/magicode-demo`, las tareas MAG-101..103, los SHAs de
 * merge y los ids de deployment son ficticios (bien formados). Lo que es real es el camino: firma
 * HMAC con el secreto de la integración → adaptador → proyección → embudo/tareas/salud.
 *
 * Idempotente "a medias": reutiliza las integraciones de demo si ya existen (GET /integrations). Como
 * el secreto solo se muestra una vez y este script no guarda nada en disco, si la integración existe
 * se rota el secreto (POST /integrations/:id/rotate-secret) para poder firmar. Los delivery ids son
 * nuevos en cada ejecución; PRs, deployments y SHAs de merge son deterministas ⇒ re-ejecutar
 * actualiza las mismas entidades. NUNCA toca integraciones de otros repositorios.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { IntegrationCreate, WEBHOOK_SIGNATURE_HEADERS, type IntegrationProvider } from '@magicode/contracts';

const API_URL = (process.env.API_URL || 'https://a5fo4490y4.execute-api.us-east-1.amazonaws.com/api/v1').replace(/\/+$/, '');
const API_KEY = process.env.MAGICODE_API_KEY;
const PROJECT = 'magicode-demo';
const REPO = 'magihub/magicode-demo';
const JIRA_BASE = 'https://demo.atlassian.net'; // dominio de ejemplo
const auth: Record<string, string> = API_KEY ? { authorization: `Bearer ${API_KEY}` } : {};

const fakeSha = (seed: string) => createHash('sha1').update(`magicode-demo:${seed}`).digest('hex'); // 40 hex

// Reloj monótono (Jira descarta updates con `updated` más viejo que el guardado).
let last = 0;
const now = () => {
  last = Math.max(Date.now(), last + 1);
  return new Date(last).toISOString();
};
const jiraTs = (iso: string) => iso.replace('Z', '+0000'); // 2026-10-20T13:20:00.000+0000

// ── HTTP ────────────────────────────────────────────────────────────────────
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...auth, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} ${res.status}: ${body}`);
  return (body ? JSON.parse(body) : {}) as T;
}
const get = async <T>(path: string) => (await api<{ data: T; meta?: Record<string, unknown> }>(path)).data;
const post = async <T>(path: string, body: unknown = {}) => (await api<{ data: T }>(path, { method: 'POST', body: JSON.stringify(body) })).data;

interface Integration {
  integration_id: string;
  project_id: string;
  provider: IntegrationProvider;
  repository?: string;
  task_project_keys?: string[];
  webhook_url: string;
  status: string;
  last_delivery_at: string | null;
}
interface Hook {
  integration: Integration;
  secret: string;
}

/** Firma y envía una entrega como lo haría el proveedor. */
async function deliver(hook: Hook, event: string | null, payload: unknown, extra: Record<string, string> = {}): Promise<string> {
  const provider = hook.integration.provider;
  const h = WEBHOOK_SIGNATURE_HEADERS[provider];
  const raw = JSON.stringify(payload);
  const hex = createHmac('sha256', hook.secret).update(raw, 'utf8').digest('hex');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': provider === 'github' ? 'GitHub-Hookshot/magicode-demo' : 'Atlassian Webhook HTTP Client (magicode-demo)',
    [h.signature]: `sha256=${hex}`,
    [h.delivery]: randomUUID(),
    ...(event ? { [h.event]: event } : {}),
    ...extra,
  };
  const res = await fetch(`${API_URL}/webhooks/${provider}/${hook.integration.integration_id}`, { method: 'POST', headers, body: raw });
  const text = await res.text();
  const label = provider === 'jira' ? String((payload as { webhookEvent?: string }).webhookEvent) : event;
  console.log(`  ${res.ok ? '✓' : '✗'} ${provider} ${label?.padEnd(20)} ${res.status} ${text}`);
  if (!res.ok) throw new Error(`webhook ${provider} ${label} → ${res.status}: ${text}`);
  return text;
}

// ── Integraciones (reutiliza o crea; secreto fresco vía rotate-secret) ──────
async function ensureIntegration(
  label: string,
  match: (i: Integration) => boolean,
  create: IntegrationCreate,
): Promise<Hook> {
  const list = await get<Integration[]>(`/integrations?project_id=${PROJECT}`);
  const found = list.find((i) => i.status !== 'disabled' && match(i));
  if (found) {
    const r = await post<Integration & { webhook_secret: string }>(`/integrations/${found.integration_id}/rotate-secret`);
    console.log(`  ${label}: reutilizada ${found.integration_id} (secreto rotado)`);
    return { integration: r, secret: r.webhook_secret };
  }
  const r = await post<Integration & { webhook_secret: string }>('/integrations', IntegrationCreate.parse(create));
  console.log(`  ${label}: creada ${r.integration_id}`);
  return { integration: r, secret: r.webhook_secret };
}

// ── Jira ────────────────────────────────────────────────────────────────────
interface DemoTask {
  key: string;
  id: string;
  summary: string;
  type: 'Story' | 'Bug';
  status: { id: string; name: string; category: 'new' | 'indeterminate' | 'done' };
  points?: number;
}
const STATUS = {
  todo: { id: '10000', name: 'To Do', category: 'new' as const },
  doing: { id: '3', name: 'In Progress', category: 'indeterminate' as const },
  done: { id: '10001', name: 'Done', category: 'done' as const },
};
const CATEGORY_NAME = { new: 'To Do', indeterminate: 'In Progress', done: 'Done' };
const CATEGORY_ID = { new: 2, indeterminate: 4, done: 3 };
const ASSIGNEE = { accountId: 'demo-account-equipo-0001', displayName: 'Equipo Demo' };
const ACTOR = { accountId: 'demo-account-equipo-0001', displayName: 'Equipo Demo' };

const TASKS: DemoTask[] = [
  { key: 'MAG-101', id: '10101', summary: 'Descuentos por volumen en el carrito', type: 'Story', status: STATUS.doing, points: 5 },
  { key: 'MAG-102', id: '10102', summary: 'Validación de RUT en el registro', type: 'Story', status: STATUS.done, points: 3 },
  { key: 'MAG-103', id: '10103', summary: 'Bug: total negativo al aplicar cupón', type: 'Bug', status: STATUS.todo },
];

function jiraPayload(
  event: 'jira:issue_created' | 'jira:issue_updated',
  t: DemoTask,
  status: DemoTask['status'],
  created: string,
  updated: string,
  changelog?: Array<Record<string, string>>,
) {
  return {
    timestamp: Date.parse(updated),
    webhookEvent: event,
    issue_event_type_name: event === 'jira:issue_created' ? 'issue_created' : 'issue_generic',
    user: ACTOR,
    issue: {
      id: t.id,
      self: `${JIRA_BASE}/rest/api/2/issue/${t.id}`,
      key: t.key,
      fields: {
        summary: t.summary,
        issuetype: { id: t.type === 'Bug' ? '10004' : '10001', name: t.type },
        project: { id: '10000', key: 'MAG', name: 'MagiCode Demo' },
        status: { id: status.id, name: status.name, statusCategory: { id: CATEGORY_ID[status.category], key: status.category, name: CATEGORY_NAME[status.category] } },
        assignee: ASSIGNEE,
        priority: { id: t.type === 'Bug' ? '2' : '3', name: t.type === 'Bug' ? 'High' : 'Medium' },
        labels: ['demo'],
        customfield_10016: t.points ?? null,
        created: jiraTs(created),
        updated: jiraTs(updated),
      },
    },
    ...(changelog ? { changelog: { id: String(Date.parse(updated) % 1_000_000), items: changelog } } : {}),
  };
}

async function seedJira(jira: Hook): Promise<void> {
  const flow = { [WEBHOOK_SIGNATURE_HEADERS.jira.event]: 'Primary' };
  for (const t of TASKS) {
    const created = now();
    await deliver(jira, null, jiraPayload('jira:issue_created', t, STATUS.todo, created, created), flow);
    const updated = now();
    const changelog =
      t.status.id === STATUS.todo.id
        ? [{ field: 'priority', fieldtype: 'jira', fieldId: 'priority', from: '3', fromString: 'Medium', to: '2', toString: 'High' }]
        : [{ field: 'status', fieldtype: 'jira', fieldId: 'status', from: STATUS.todo.id, fromString: STATUS.todo.name, to: t.status.id, toString: t.status.name }];
    await deliver(jira, null, jiraPayload('jira:issue_updated', t, t.status, created, updated, changelog), flow);
  }
}

// ── GitHub ──────────────────────────────────────────────────────────────────
interface SeedCommit {
  sha: string;
  branch: string;
  session_id: string;
  parent_sha?: string;
  committed_at: string;
  task_keys: string[];
  files: Array<{ path: string }>;
}
interface BranchPlan {
  task: string;
  branch: string;
  commits: SeedCommit[];
  head: string;
  pr: number;
  title: string;
  merge_sha: string;
}

const repoObj = {
  id: 880001,
  node_id: 'R_demo_magicode',
  name: 'magicode-demo',
  full_name: REPO,
  private: true,
  html_url: `https://github.com/${REPO}`,
  default_branch: 'main',
  owner: { login: 'magihub', type: 'Organization' },
};
const sender = { login: 'equipo-demo', id: 990001, type: 'User' };
const ghUser = { name: 'Equipo Demo', email: 'equipo-demo@example.com', username: 'equipo-demo' };

const COMMIT_SUBJECT: Record<string, string> = {
  'MAG-101': 'MAG-101: descuentos por volumen (sumPositive + config)',
  'MAG-102': 'MAG-102: normaliza la entrada del registro antes de validar el RUT',
};
const PR_PLAN: Record<string, { pr: number; title: string }> = {
  'MAG-101': { pr: 14, title: 'MAG-101: Descuentos por volumen en el carrito' },
  'MAG-102': { pr: 11, title: 'MAG-102: Validación de RUT en el registro' },
};

async function planBranches(): Promise<BranchPlan[]> {
  const commits = await get<SeedCommit[]>(`/productivity/commits?repository=${encodeURIComponent(REPO)}`);
  const plans: BranchPlan[] = [];
  for (const task of ['MAG-101', 'MAG-102']) {
    const mine = commits
      .filter((c) => c.task_keys?.includes(task) || c.branch?.toUpperCase().includes(task))
      .sort((a, b) => a.committed_at.localeCompare(b.committed_at));
    if (!mine.length) throw new Error(`No hay commits del seed para ${task} en ${REPO}: ejecuta antes scripts/seed-demo.ts`);
    const head = mine[mine.length - 1]!;
    plans.push({ task, branch: head.branch, commits: mine.filter((c) => c.branch === head.branch), head: head.sha, ...PR_PLAN[task]!, merge_sha: fakeSha(`merge-pr-${PR_PLAN[task]!.pr}`) });
  }
  return plans;
}

function pushPayload(p: BranchPlan) {
  const before = p.commits[0]!.parent_sha ?? fakeSha(`base-${p.branch}`);
  return {
    ref: `refs/heads/${p.branch}`,
    before,
    after: p.head,
    created: false,
    deleted: false,
    forced: false,
    base_ref: null,
    compare: `https://github.com/${REPO}/compare/${before.slice(0, 12)}...${p.head.slice(0, 12)}`,
    commits: p.commits.map((c) => ({
      id: c.sha,
      tree_id: fakeSha(`tree-${c.sha}`),
      distinct: true,
      message: `${COMMIT_SUBJECT[p.task]}\n\nMagiCode-Session: ${c.session_id}\nMagiCode-Task: ${p.task}`,
      timestamp: c.committed_at,
      url: `https://github.com/${REPO}/commit/${c.sha}`,
      author: ghUser,
      committer: ghUser,
      added: c.files.map((f) => f.path),
      removed: [],
      modified: [],
    })),
    head_commit: { id: p.head, message: COMMIT_SUBJECT[p.task], timestamp: p.commits[p.commits.length - 1]!.committed_at },
    repository: repoObj,
    pusher: { name: ghUser.username, email: ghUser.email },
    sender,
  };
}

function prPayload(p: BranchPlan, action: 'opened' | 'closed', opened_at: string, closed_at?: string) {
  const merged = action === 'closed';
  return {
    action,
    number: p.pr,
    pull_request: {
      url: `https://api.github.com/repos/${REPO}/pulls/${p.pr}`,
      html_url: `https://github.com/${REPO}/pull/${p.pr}`,
      number: p.pr,
      state: merged ? 'closed' : 'open',
      locked: false,
      title: p.title,
      user: { login: sender.login },
      body: `Implementa ${p.task} (datos de demo).`,
      created_at: opened_at,
      updated_at: closed_at ?? opened_at,
      closed_at: closed_at ?? null,
      merged_at: merged ? closed_at : null,
      merge_commit_sha: p.merge_sha,
      draft: false,
      head: { label: `magihub:${p.branch}`, ref: p.branch, sha: p.head },
      base: { label: 'magihub:main', ref: 'main', sha: fakeSha('main-base') },
      merged,
      additions: p.commits.length * 10,
      deletions: 0,
      changed_files: p.commits.reduce((n, c) => n + c.files.length, 0),
    },
    repository: repoObj,
    sender,
  };
}

function deploymentPayload(o: { id: number; sha: string; ref: string; environment: string; at: string }) {
  return {
    action: 'created',
    deployment_status: {
      id: o.id * 10 + 1,
      state: 'success',
      description: 'Deployment finished successfully (demo).',
      environment: o.environment,
      target_url: '',
      log_url: `https://github.com/${REPO}/actions/runs/${o.id}/job/${o.id * 10 + 1}`,
      environment_url: `https://${o.environment}.magicode-demo.example.com`,
      created_at: o.at,
      updated_at: o.at,
    },
    deployment: { id: o.id, sha: o.sha, ref: o.ref, task: 'deploy', environment: o.environment, created_at: o.at },
    repository: repoObj,
    sender: { login: 'github-actions[bot]', type: 'Bot' },
  };
}

async function seedGithub(gh: Hook, plans: BranchPlan[]): Promise<void> {
  await deliver(gh, 'ping', {
    zen: 'Keep it logically awesome.',
    hook_id: 880101,
    hook: { type: 'Repository', id: 880101, active: true, events: ['push', 'create', 'delete', 'pull_request', 'deployment_status'], config: { content_type: 'json', insecure_ssl: '0', url: gh.integration.webhook_url } },
    repository: repoObj,
    sender,
  });
  for (const p of plans) {
    await deliver(gh, 'create', { ref: p.branch, ref_type: 'branch', master_branch: 'main', pusher_type: 'user', repository: repoObj, sender });
    await deliver(gh, 'push', pushPayload(p));
  }
  // PR #11 (MAG-102) se abrió antes que #14 (MAG-101)
  const byPr = [...plans].sort((a, b) => a.pr - b.pr);
  const opened: Record<number, string> = {};
  for (const p of byPr) {
    opened[p.pr] = now();
    await deliver(gh, 'pull_request', prPayload(p, 'opened', opened[p.pr]!));
  }
  for (const p of byPr) await deliver(gh, 'pull_request', prPayload(p, 'closed', opened[p.pr]!, now()));

  const mag101 = plans.find((p) => p.task === 'MAG-101')!;
  const mag102 = plans.find((p) => p.task === 'MAG-102')!;
  await deliver(gh, 'deployment_status', deploymentPayload({ id: 770000 + mag101.pr, sha: mag101.head, ref: mag101.branch, environment: 'staging', at: now() }));
  await deliver(gh, 'deployment_status', deploymentPayload({ id: 770000 + mag102.pr, sha: mag102.merge_sha, ref: 'main', environment: 'production', at: now() }));
}

// ── Prueba manual de ida y vuelta + salud ───────────────────────────────────
interface TestRun {
  test_id: string;
  status: string;
  mode: string;
  latency_ms?: number | null;
}
interface Health {
  status: string;
  checks: Array<{ id: string; status: string; message: string }>;
  deliveries_24h: Record<string, number>;
  last_test: { status: string } | null;
}

async function manualTest(hook: Hook, send: () => Promise<unknown>): Promise<void> {
  const id = hook.integration.integration_id;
  const run = await post<TestRun>(`/integrations/${id}/test`, { mode: 'manual' });
  console.log(`  ${hook.integration.provider} test ${run.test_id} (${run.mode}) → ${run.status}; enviando entrega…`);
  await send();
  const after = await get<TestRun>(`/integrations/${id}/tests/${run.test_id}`);
  console.log(`  ${hook.integration.provider} test ${after.test_id} → ${after.status}${after.latency_ms != null ? ` (${after.latency_ms} ms)` : ''}`);
}

function printHealth(label: string, h: Health): void {
  console.log(`  ${label}: status=${h.status} last_test=${h.last_test?.status ?? '—'} deliveries_24h=${JSON.stringify(h.deliveries_24h)}`);
  for (const c of h.checks) console.log(`     ${c.status.padEnd(7)} ${c.id.padEnd(22)} ${c.message}`);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`MagiCode seed webhooks (DATOS DE DEMO) — API ${API_URL}${API_KEY ? '' : ' (modo demo, sin Authorization)'}`);

  console.log('\n[1/5] integraciones');
  const jira = await ensureIntegration(
    'jira',
    (i) => i.provider === 'jira' && i.project_id === PROJECT && !!i.task_project_keys?.includes('MAG'),
    { provider: 'jira', project_id: PROJECT, task_project_keys: ['MAG'], base_url: JIRA_BASE },
  );
  const gh = await ensureIntegration(
    'github',
    (i) => i.provider === 'github' && i.project_id === PROJECT && i.repository?.toLowerCase() === REPO,
    { provider: 'github', project_id: PROJECT, repository: REPO },
  );

  console.log('\n[2/5] Jira: issue_created + issue_updated (MAG-101..103)');
  await seedJira(jira);

  console.log('\n[3/5] GitHub: ping, create, push, pull_request, deployment_status');
  const plans = await planBranches();
  for (const p of plans) console.log(`  ${p.task}: ${p.branch} head=${p.head.slice(0, 12)} commits=${p.commits.length} PR #${p.pr} merge=${p.merge_sha.slice(0, 12)}`);
  await seedGithub(gh, plans);

  console.log('\n[4/5] prueba manual de ida y vuelta + salud');
  await manualTest(gh, () => deliver(gh, 'ping', { zen: 'Half measures are as bad as nothing at all.', hook_id: 880101, repository: repoObj, sender }));
  const t103 = TASKS[2]!;
  await manualTest(jira, () => {
    const at = now();
    return deliver(
      jira,
      null,
      jiraPayload('jira:issue_updated', t103, t103.status, at, at, [{ field: 'description', fieldtype: 'jira', fieldId: 'description', from: '', fromString: '', to: '', toString: 'Pasos para reproducir (demo).' }]),
      { [WEBHOOK_SIGNATURE_HEADERS.jira.event]: 'Primary' },
    );
  });
  printHealth(`github ${gh.integration.integration_id}`, await get<Health>(`/integrations/${gh.integration.integration_id}/health`));
  printHealth(`jira   ${jira.integration.integration_id}`, await get<Health>(`/integrations/${jira.integration.integration_id}/health`));

  const rd = await get<{ ready: boolean; blocking_reasons: string[]; repositories: Array<{ repository: string; ready: boolean; blocking_reasons: string[]; repository_webhook: Health; tasks_webhook: Health }> }>(
    `/projects/${PROJECT}/readiness`,
  );
  console.log(`\n  readiness ${PROJECT}: ready=${rd.ready}${rd.blocking_reasons.length ? ` blocking=${JSON.stringify(rd.blocking_reasons)}` : ''}`);
  for (const r of rd.repositories) {
    console.log(`   - ${r.repository}: ready=${r.ready} repo_webhook=${r.repository_webhook.status} tasks_webhook=${r.tasks_webhook.status}${r.blocking_reasons.length ? ` blocking=${JSON.stringify(r.blocking_reasons)}` : ''}`);
  }

  console.log('\n[5/5] resumen');
  const s = await get<{
    attribution: string;
    overall_provenance: string;
    funnel: Array<{ stage: string; lines: { value: number | null; provenance: string }; effective_lines: { value: number | null }; conversion: { value: number | null } }>;
    counts: Record<string, number>;
  }>(`/productivity/summary?project_id=${PROJECT}&refresh=true`);
  console.log(`  summary (attribution=${s.attribution}, overall=${s.overall_provenance})`);
  console.log('  etapa          líneas   efectivas   conversión   procedencia');
  for (const f of s.funnel) {
    console.log(
      `  ${f.stage.padEnd(14)} ${String(f.lines.value ?? '—').padStart(6)}   ${String(f.effective_lines.value ?? '—').padStart(9)}   ${(f.conversion.value === null ? '—' : `${(f.conversion.value * 100).toFixed(0)}%`).padStart(10)}   ${f.lines.provenance}`,
    );
  }
  const c = s.counts;
  console.log(`  counts: pull_requests=${c.pull_requests} deployments_success=${c.deployments_success} tasks=${c.tasks} tasks_done=${c.tasks_done}`);
  console.log(`  counts (todas): ${JSON.stringify(c)}`);

  const tasks = await get<Array<{ task_key: string; title: string; status: string; status_category: string; story_points: number | null; assignee: string | null; commits: number; pull_requests: Array<{ number: number; state: string }>; deployed: boolean; url: string | null }>>(
    `/tasks?project_id=${PROJECT}`,
  );
  console.log('\n  GET /tasks');
  for (const t of tasks) {
    console.log(
      `   ${t.task_key.padEnd(8)} ${t.status.padEnd(12)} (${t.status_category.padEnd(11)}) pts=${t.story_points ?? '—'} assignee=${t.assignee ?? '—'} commits=${t.commits} PRs=${t.pull_requests.map((p) => `#${p.number}:${p.state}`).join(',') || '—'} deployed=${t.deployed} · ${t.title}`,
    );
  }
  console.log('\n(Datos de DEMO enviados por el pipeline real de webhooks firmados.)');
}

main().catch((err) => {
  console.error('✗ seed-webhooks falló:', err instanceof Error ? err.message : err);
  process.exit(1);
});
