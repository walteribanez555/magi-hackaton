/**
 * "Caso de ejemplo" — genera 2 sesiones de demo contra la API de MagiCode usando el MagiHub SIMULADO.
 *
 *   docker compose up -d dynamodb-local && npm run create-table -w @magicode/api
 *   npm run dev -w @magicode/magihub-mock      # :4010
 *   npm run dev -w @magicode/api               # :3000 (MAGIHUB_MODE=mock)
 *   npm run seed:demo
 *
 * Env: API_URL (http://localhost:3000), MAGIHUB_URL (http://localhost:4010), MAGIHUB_API_KEY (mh_demo_walter).
 *
 * Las peticiones a Smart Auto son REALES contra el mock (request_id y usage salen de sus respuestas y
 * de su API de consumo); las aristas/commits/SHAs son de demo pero bien formados. Todo evento lleva
 * `source: 'demo-seed'` ⇒ la API lo etiqueta `simulated`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { ProductivityEvent, type ChangeDimensions, type ProductivitySummary } from '@magicode/contracts';

const API_URL = (process.env.API_URL || 'http://localhost:3000').replace(/\/+$/, '');
const MAGIHUB_URL = (process.env.MAGIHUB_URL || 'http://localhost:4010').replace(/\/+$/, '');
const KEY = process.env.MAGIHUB_API_KEY || 'mh_demo_walter';
const PROJECT = 'magicode-demo';
const REPO = 'magihub/magicode-demo';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const fakeSha = (seed: string) => createHash('sha1').update(`magicode-demo:${seed}`).digest('hex'); // 40 hex
const auth = { authorization: `Bearer ${KEY}` };

// Reloj monótono: los eventos suceden "ahora" (coinciden con la ventana del usage del mock).
let last = 0;
const now = () => {
  last = Math.max(Date.now(), last + 1);
  return new Date(last).toISOString();
};

// ── MagiHub (mock) ──────────────────────────────────────────────────────────
interface Chat {
  id: string;
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  content: string;
  latency_ms: number;
}

async function chat(prompt: string): Promise<Chat> {
  const t0 = Date.now();
  const res = await fetch(`${MAGIHUB_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'smart-auto', messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`MagiHub mock ${res.status}: ${await res.text()}`);
  if (res.headers.get('x-magihub-simulated') !== 'true') throw new Error('Se esperaba el MagiHub SIMULADO (x-magihub-simulated)');
  const body = (await res.json()) as { id: string; model: string; usage: Chat['usage']; choices: Array<{ message: { content: string } }> };
  return {
    id: res.headers.get('x-request-id') ?? body.id,
    model: body.model,
    usage: body.usage,
    content: body.choices[0]!.message.content,
    latency_ms: Date.now() - t0,
  };
}

// ── Eventos ─────────────────────────────────────────────────────────────────
type Ctx = { session_id: string; branch: string; task_key: string };

function envelope(ctx: Ctx, event_type: string, payload: unknown, occurred_at = now()) {
  return {
    event_id: randomUUID(),
    schema_version: 1,
    occurred_at,
    session_id: ctx.session_id,
    project_id: PROJECT,
    repository: REPO,
    branch: ctx.branch,
    task_key: ctx.task_key,
    source: 'demo-seed',
    event_type,
    payload,
  };
}

const aiEvent = (ctx: Ctx, c: Chat, o: { status?: 'ok' | 'error' | 'cancelled'; regenerates?: string } = {}) =>
  envelope(ctx, 'ai.request.completed', {
    ai_request_id: c.id,
    model: c.model,
    status: o.status ?? 'ok',
    latency_ms: c.latency_ms,
    usage: c.usage,
    usage_source: 'magihub-mock',
    output_hash: sha256(c.content).slice(0, 16),
    ...(o.regenerates ? { regenerates: o.regenerates } : {}),
  });

const files = (...fs: Array<[string, number, number?]>) =>
  fs.map(([path, added, deleted = 0]) => ({ path, language: path.split('.').pop(), added, deleted }));

/** Construye ChangeDimensions coherentes a partir de conteos por kind (pesos de docs/metrics-model.md). */
function dimensions(o: {
  by_kind: Partial<Record<'logic' | 'declaration' | 'test' | 'config' | 'comment' | 'import' | 'trivial', number>>;
  weighted: number;
  effective: number;
  intra?: number;
  existing?: number;
  repeated?: number;
  mechanical: number;
  edited?: number;
}): ChangeDimensions {
  const by_kind = { logic: 0, declaration: 0, test: 0, config: 0, comment: 0, import: 0, trivial: 0, ...o.by_kind };
  const lines = Object.values(by_kind).reduce((a, b) => a + b, 0);
  const redundant = (o.intra ?? 0) + (o.existing ?? 0) + (o.repeated ?? 0);
  const nonTrivial = lines - by_kind.trivial;
  const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
  return {
    importance: { lines, weighted_lines: o.weighted, score: r4(lines ? o.weighted / lines : 0), by_kind },
    redundancy: {
      intra_change: o.intra ?? 0,
      existing_in_repo: o.existing ?? 0,
      repeated_in_session: o.repeated ?? 0,
      redundant_lines: redundant,
      score: r4(nonTrivial ? redundant / nonTrivial : 0),
    },
    automation: {
      mechanical_lines: o.mechanical,
      mechanical_share: r4(lines ? o.mechanical / lines : 0),
      accepted_as_is: lines - (o.edited ?? 0),
      edited_before_accept: o.edited ?? 0,
    },
    effective_lines: o.effective,
  };
}

async function post(events: unknown[]): Promise<void> {
  for (const e of events) ProductivityEvent.parse(e); // falla aquí si el seed se sale del contrato
  for (let i = 0; i < events.length; i += 25) {
    const res = await fetch(`${API_URL}/api/v1/productivity/events`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ events: events.slice(i, i + 25) }),
    });
    const body = await res.text();
    if (res.status !== 202) throw new Error(`POST events ${res.status}: ${body}`);
    console.log(`  → ${Math.min(25, events.length - i)} eventos: ${body}`);
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}/api/v1${path}`, { ...init, headers: { ...auth, ...(init?.headers ?? {}) } });
  const body = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} ${res.status}: ${body}`);
  return (JSON.parse(body) as { data: T }).data;
}

// ── Sesiones de demo ────────────────────────────────────────────────────────
async function session1(run: string): Promise<{ sha: string }> {
  const ctx: Ctx = { session_id: `demo-${run}-s1`, branch: 'feature/MAG-101-sum-positive', task_key: 'MAG-101' };
  const ev: unknown[] = [];
  ev.push(envelope(ctx, 'session.started', { editor: 'vscode 1.105.0', extension_version: '0.1.0', branch: ctx.branch }));

  // 1) función + test → aceptado
  const p1 = 'Escribe la function sumPositive with unit test en TypeScript';
  const r1 = await chat(p1);
  ev.push(aiEvent(ctx, r1));
  const c1 = files(['src/sumPositive.ts', 7], ['src/sumPositive.test.ts', 12]);
  ev.push(envelope(ctx, 'code.proposed', { change_id: `${ctx.session_id}-c1`, ai_request_id: r1.id, files: c1, patch_hash: sha256(`p1${run}`).slice(0, 16) }));
  ev.push(
    envelope(ctx, 'code.accepted', {
      change_id: `${ctx.session_id}-c1`,
      ai_request_id: r1.id,
      files: c1,
      patch_hash: sha256(`p1${run}`).slice(0, 16),
      accepted_added_lines: 19,
      accepted_deleted_lines: 0,
      // decl 1×0.8 + logic 4×1 + test 8×0.7×0.9 + import 2×0.1×0.9 ; mecánicas = imports + triviales
      dimensions: dimensions({ by_kind: { declaration: 1, logic: 4, test: 8, import: 2, trivial: 4 }, weighted: 10.02, effective: 9.84, mechanical: 6 }),
    }),
  );

  // 2) componente React → rechazado (exploración)
  const r2 = await chat('Crea un componente React Counter con estado');
  ev.push(aiEvent(ctx, r2));
  ev.push(envelope(ctx, 'code.proposed', { change_id: `${ctx.session_id}-c2`, ai_request_id: r2.id, files: files(['src/Counter.tsx', 10]), patch_hash: sha256(`p2${run}`).slice(0, 16) }));
  ev.push(envelope(ctx, 'code.rejected', { change_id: `${ctx.session_id}-c2`, ai_request_id: r2.id, reason: 'user' }));

  // 3) regeneración redundante: mismo prompt ⇒ misma salida ⇒ mismo output_hash
  const r3 = await chat(p1);
  ev.push(aiEvent(ctx, r3, { regenerates: r1.id }));
  ev.push(envelope(ctx, 'code.proposed', { change_id: `${ctx.session_id}-c3`, ai_request_id: r3.id, files: c1, patch_hash: sha256(`p1${run}`).slice(0, 16) }));
  ev.push(envelope(ctx, 'code.rejected', { change_id: `${ctx.session_id}-c3`, ai_request_id: r3.id, reason: 'superseded' }));

  // 4) config con líneas ya existentes en el repo (redundancia) y triviales (mecánicas)
  const r4 = await chat('Agrega la config tsconfig json del proyecto');
  ev.push(aiEvent(ctx, r4));
  const c4 = files(['tsconfig.json', 10]);
  ev.push(envelope(ctx, 'code.proposed', { change_id: `${ctx.session_id}-c4`, ai_request_id: r4.id, files: c4, patch_hash: sha256(`p4${run}`).slice(0, 16) }));
  ev.push(
    envelope(ctx, 'code.accepted', {
      change_id: `${ctx.session_id}-c4`,
      ai_request_id: r4.id,
      files: c4,
      patch_hash: sha256(`p4${run}`).slice(0, 16),
      accepted_added_lines: 10,
      accepted_deleted_lines: 0,
      dimensions: dimensions({ by_kind: { config: 8, trivial: 2 }, weighted: 3.2, effective: 2.0, existing: 3, mechanical: 2, edited: 2 }),
    }),
  );

  // 5) commit (SHA de demo bien formado) con trailer de sesión + 3 líneas humanas (README)
  const sha = fakeSha(`${run}-1`);
  ev.push(
    envelope(ctx, 'git.committed', {
      sha,
      parent_sha: fakeSha(`${run}-0`),
      branch: ctx.branch,
      committed_at: now(),
      files: [...c1, ...c4, ...files(['README.md', 3])],
      change_ids: [`${ctx.session_id}-c1`, `${ctx.session_id}-c4`],
      automation: { commit_added_lines: 32, ai_matched_lines: 27, ai_share: 0.8438, ai_lost_lines: 2, effective_lines: 11.04 },
      has_session_trailer: true,
      remote_url: `https://github.com/${REPO}.git`,
      source: 'git-local',
    }),
  );

  // 6) versión de referencia (demo)
  ev.push(
    envelope(ctx, 'reference.marked', {
      tag: `demo-v0.1-${run}`,
      sha,
      kind: 'demo-reference',
      included_shas: [sha],
      surviving_lines: 25,
      surviving_effective_lines: 10.5,
    }),
  );
  ev.push(envelope(ctx, 'session.ended', { reason: 'user' }));
  await post(ev);
  return { sha };
}

async function session2(run: string, parent: string): Promise<void> {
  const ctx: Ctx = { session_id: `demo-${run}-s2`, branch: 'feature/MAG-102-normalize', task_key: 'MAG-102' };
  const ev: unknown[] = [];
  ev.push(envelope(ctx, 'session.started', { editor: 'vscode 1.105.0', extension_version: '0.1.0', branch: ctx.branch, head_sha: parent }));

  // prompt largo (con contexto del archivo) ⇒ Smart Auto enruta al modelo grande (mock-sonnet)
  const fileContext = Array.from({ length: 14 }, (_, i) => `export const FIELD_${i} = 'campo_${i}'; // usado por el formulario de registro`).join('\n');
  const r5 = await chat(`Contexto de src/fields.ts:\n${fileContext}\n\nEscribe una function normalizeInput que limpie espacios`);
  ev.push(aiEvent(ctx, r5));
  const c5 = files(['src/normalize.ts', 6]);
  ev.push(envelope(ctx, 'code.proposed', { change_id: `${ctx.session_id}-c5`, ai_request_id: r5.id, files: c5, patch_hash: sha256(`p5${run}`).slice(0, 16) }));
  ev.push(
    envelope(ctx, 'code.accepted', {
      change_id: `${ctx.session_id}-c5`,
      ai_request_id: r5.id,
      files: c5,
      patch_hash: sha256(`p5${run}`).slice(0, 16),
      accepted_added_lines: 6,
      accepted_deleted_lines: 0,
      dimensions: dimensions({ by_kind: { declaration: 1, logic: 3, trivial: 2 }, weighted: 3.8, effective: 3.8, mechanical: 2, edited: 1 }),
    }),
  );

  // petición cancelada: también consume tokens
  const r6 = await chat('Escribe una consulta SQL con el top 10 de clientes');
  ev.push(aiEvent(ctx, r6, { status: 'cancelled' }));

  // copy-paste: vuelve a generar sumPositive (ya existe en el repo) ⇒ redundante, 0 líneas efectivas
  const r7 = await chat('Escribe la function sumPositive with unit test en TypeScript');
  ev.push(aiEvent(ctx, r7));
  const c6 = files(['src/math/sumPositive.ts', 7]);
  ev.push(envelope(ctx, 'code.proposed', { change_id: `${ctx.session_id}-c6`, ai_request_id: r7.id, files: c6, patch_hash: sha256(`p7${run}`).slice(0, 16) }));
  ev.push(
    envelope(ctx, 'code.accepted', {
      change_id: `${ctx.session_id}-c6`,
      ai_request_id: r7.id,
      files: c6,
      patch_hash: sha256(`p7${run}`).slice(0, 16),
      accepted_added_lines: 7,
      accepted_deleted_lines: 0,
      dimensions: dimensions({ by_kind: { declaration: 1, logic: 4, trivial: 2 }, weighted: 4.8, effective: 0, existing: 5, mechanical: 2 }),
    }),
  );

  const sha = fakeSha(`${run}-2`);
  ev.push(
    envelope(ctx, 'git.committed', {
      sha,
      parent_sha: parent,
      branch: ctx.branch,
      committed_at: now(),
      files: [...c5, ...c6],
      change_ids: [`${ctx.session_id}-c5`, `${ctx.session_id}-c6`],
      automation: { commit_added_lines: 13, ai_matched_lines: 12, ai_share: 0.9231, ai_lost_lines: 1, effective_lines: 3.5 },
      has_session_trailer: true,
      source: 'git-local',
    }),
  );
  ev.push(
    envelope(ctx, 'reference.marked', {
      tag: `demo-v0.2-${run}`,
      sha,
      kind: 'demo-reference',
      included_shas: [parent, sha],
      surviving_lines: 11,
      surviving_effective_lines: 3.5,
    }),
  );
  ev.push(envelope(ctx, 'session.ended', { reason: 'window-closed' }));
  await post(ev);
}

// ── Main ────────────────────────────────────────────────────────────────────
const fmt = (m: { value: number | null; provenance: string }) =>
  `${m.value === null ? '—' : Number.isInteger(m.value) ? m.value : m.value.toFixed(Math.abs(m.value) < 1 ? 4 : 2)} (${m.provenance})`;

async function main(): Promise<void> {
  const run = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const from = new Date(Date.now() - 60_000).toISOString();
  console.log(`MagiCode seed demo — run ${run}\n  API ${API_URL} · MagiHub SIMULADO ${MAGIHUB_URL} · key ${KEY.slice(0, 8)}…`);

  const who = await api<{ tenant_id: string; key_id: string; key_fingerprint: string }>('/whoami');
  console.log(`  whoami: tenant=${who.tenant_id} key_id=${who.key_id} fingerprint=${who.key_fingerprint}`);

  console.log('\n[1/2] sesión 1 (MAG-101)');
  const { sha } = await session1(run);
  console.log('[2/2] sesión 2 (MAG-102)');
  await session2(run, sha);

  const to = new Date(Date.now() + 60_000).toISOString();
  const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  await api(`/usage/sync?${q}`, { method: 'POST' });
  const s = await api<ProductivitySummary>(`/productivity/summary?project_id=${PROJECT}&${q}&refresh=true`);

  console.log(`\n══ Resumen "${PROJECT}" (attribution=${s.attribution}, overall=${s.overall_provenance}) ══`);
  console.log(`tokens total ............ ${fmt(s.tokens.total)}  [${s.tokens.total.source}]`);
  console.log(`  reportado por requests  ${fmt(s.tokens.reported_by_requests)}  · sin reconciliar ${fmt(s.tokens.unreconciled)}`);
  console.log(`  en aceptados ${fmt(s.tokens.on_accepted)} · exploración ${fmt(s.tokens.on_rejected)}`);
  console.log(`  regeneraciones redundantes ${fmt(s.tokens.on_redundant_regenerations)} · mecánico ${fmt(s.tokens.on_mechanical)}`);
  console.log(`  costo ${fmt(s.tokens.cost_usd)}`);
  console.log('\nembudo         líneas   efectivas   tok/100 líneas   tok/100 efectivas   conversión');
  for (const f of s.funnel) {
    console.log(
      `${f.stage.padEnd(14)} ${String(f.lines.value ?? '—').padStart(6)}   ${String(f.effective_lines.value ?? '—').padStart(9)}   ${String(
        f.tokens_per_100_lines.value === null ? '—' : Math.round(f.tokens_per_100_lines.value),
      ).padStart(14)}   ${String(f.tokens_per_100_effective_lines.value === null ? '—' : Math.round(f.tokens_per_100_effective_lines.value)).padStart(
        17,
      )}   ${f.conversion.value === null ? '—' : `${(f.conversion.value * 100).toFixed(0)}%`}`,
    );
  }
  console.log(
    `\naristas: importancia ${fmt(s.dimensions.importance.score)} · redundancia ${fmt(s.dimensions.redundancy.score)} · mecánico ${fmt(
      s.dimensions.automation.mechanical_share,
    )} · IA en commits ${fmt(s.dimensions.automation.ai_share_of_commits)}`,
  );
  console.log(`counts: ${JSON.stringify(s.counts)}`);
  console.log(`by_model: ${s.by_model.map((b) => `${b.model}=${b.requests} req/${b.tokens.value} tok`).join(', ')}`);
  console.log('\n(Datos SIMULADOS: MagiHub mock + demo-seed. Ver dashboard o GET /api/v1/productivity/summary.)');
}

main().catch((err) => {
  console.error('✗ seed-demo falló:', err instanceof Error ? err.message : err);
  process.exit(1);
});
