/**
 * Prueba de punta a punta REAL (sin datos de demo) de MagiCode contra la API desplegada, usando la
 * lógica de la extensión en modo headless (los módulos puros de apps/extension/src: no importan 'vscode').
 *
 *   npx tsx scripts/e2e-real.ts
 *
 * Qué hace (todo real salvo MagiHub, que es el mock simulado: request id y usage salen de su respuesta):
 *   1. Clona el repositorio público en un directorio temporal y crea la rama de la tarea.
 *   2. Inicia una sesión (session.started) y construye el índice de hashes del repo.
 *   3. Pide a Smart Auto una utilidad con su prueba → ai.request.completed + code.proposed (×2 archivos).
 *      Aplica los cambios en disco (el archivo de prueba se edita antes de aceptar: ruta del import)
 *      → code.accepted con las aristas calculadas por @magicode/metrics.
 *   4. Una segunda petición cuyo resultado se rechaza → code.rejected (tokens de exploración).
 *   5. git commit (trailers MagiCode-Session / MagiCode-Task) → matchCommit sobre el diff real → git.committed.
 *   6. git push de la rama (el webhook real de GitHub marca el commit como verified_remote).
 *   7. Tag anotado + push del tag → computeSurvival → reference.marked (kind demo-reference).
 *   8. session.ended y flush de la telemetría (se imprimen las respuestas de la API).
 *
 * Env:
 *   API_URL            base de la API (default: API dev desplegada; modo demo sin Authorization)
 *   MAGICODE_API_KEY   opcional: si se define se envía como Bearer; si no, modo demo
 *   MAGIHUB_URL        MagiHub (default: el mock desplegado) · MAGIHUB_API_KEY (default mh_demo_walter)
 *   E2E_REPO           org/repo (default walteribanez555/magi-hackaton)
 *   E2E_PROJECT        project_id (default magi-hackaton)
 *   E2E_BRANCH         rama (default feature/MGH-1-utilidades-tokens)
 *   E2E_WORKDIR        directorio padre del clon (default: tmpdir del sistema)
 *   E2E_GIT_NAME / E2E_GIT_EMAIL   autor de commit y tag
 *   GH_USER            cuenta de `gh` cuyo token se usa para el push (solo en memoria)
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, promises as fs, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { extractTaskKeys } from '@magicode/contracts';
import { outputHash } from '@magicode/metrics';
import { analyzeAcceptance, makeProposal, proposedPayload, type Proposal } from '../apps/extension/src/changes';
import { analyzeCommit, computeReference, createAnnotatedTag, readCommitDiff, readCommitHeader } from '../apps/extension/src/commits';
import { git, headSha, isValidTagName, languageFromPath, remoteUrl, runGit, sanitizeRemoteUrl } from '../apps/extension/src/git';
import type { Logger } from '../apps/extension/src/log';
import { RepoHashIndex } from '../apps/extension/src/repoIndex';
import { createSession, markProcessed, recordCommitted, sessionAcceptedHashes, type SessionState } from '../apps/extension/src/session';
import { buildMessages, callSmartAuto, conformText, extractCodeBlock, type SmartAutoResult } from '../apps/extension/src/smartAuto';
import { TelemetryClient, type KeyValueStore, type PayloadOf, type TelemetryContext } from '../apps/extension/src/telemetry';
import type { ProductivityEventType } from '@magicode/contracts';

const API_URL = (process.env.API_URL || 'https://a5fo4490y4.execute-api.us-east-1.amazonaws.com/api/v1').replace(/\/+$/, '');
const API_KEY = process.env.MAGICODE_API_KEY;
const MAGIHUB_URL = process.env.MAGIHUB_URL || 'https://hn1x6jivok.execute-api.us-east-1.amazonaws.com';
const MAGIHUB_KEY = process.env.MAGIHUB_API_KEY || 'mh_demo_walter';
const REPO = process.env.E2E_REPO || 'walteribanez555/magi-hackaton';
const PROJECT = process.env.E2E_PROJECT || 'magi-hackaton';
const BRANCH = process.env.E2E_BRANCH || 'feature/MGH-1-utilidades-tokens';
const GIT_NAME = process.env.E2E_GIT_NAME || 'walteribanez555';
const GIT_EMAIL = process.env.E2E_GIT_EMAIL || 'walteribanez555@gmail.com';
const GH_USER = process.env.GH_USER || 'walteribanez555';
const WORKDIR = process.env.E2E_WORKDIR || tmpdir();
const EXT_VERSION = String(
  (JSON.parse(readFileSync(path.join(__dirname, '../apps/extension/package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0',
);

const pad = (n: number) => String(n).padStart(2, '0');
const now = new Date();
const STAMP = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
const TAG = `magicode-e2e-${STAMP}`;

const logger: Logger = {
  debug: () => {},
  info: (m) => console.log(`  · ${m}`),
  warn: (m) => console.warn(`  ! ${m}`),
  error: (m, e) => console.error(`  ✗ ${m}`, e ?? ''),
};

/** Store en memoria (la extensión usa globalState). */
const memStore = (): KeyValueStore => {
  const m = new Map<string, unknown>();
  return { get: <T>(k: string) => m.get(k) as T | undefined, update: async (k, v) => void m.set(k, v) };
};

/** fetch que imprime la respuesta de la API y, en modo demo, no envía Authorization. */
const apiFetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (!API_KEY) headers.delete('authorization');
  const res = await fetch(input, { ...init, headers });
  const text = await res.text();
  console.log(`  → POST ${new URL(input).pathname} ${res.status} ${text}`);
  return new Response(text, { status: res.status, headers: res.headers });
};

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
  // ── 1. clon + rama ────────────────────────────────────────────────────────
  section('1. Clonar repositorio y crear rama');
  mkdirSync(WORKDIR, { recursive: true });
  const root = path.join(WORKDIR, `magi-hackaton-${STAMP}-${randomUUID().slice(0, 6)}`);
  execFileSync('git', ['clone', '--quiet', `https://github.com/${REPO}.git`, root], { stdio: 'inherit' });
  await git(root, ['config', 'user.name', GIT_NAME]);
  await git(root, ['config', 'user.email', GIT_EMAIL]);
  await git(root, ['checkout', '-q', '-b', BRANCH]);
  const base = await headSha(root);
  const remote = sanitizeRemoteUrl((await remoteUrl(root)) ?? `https://github.com/${REPO}.git`);
  const taskKey = extractTaskKeys(BRANCH)[0];
  console.log(`  clon: ${root}\n  rama: ${BRANCH} (base ${base})\n  tarea inferida de la rama: ${taskKey ?? '(ninguna)'}`);

  // ── 2. sesión ─────────────────────────────────────────────────────────────
  section('2. Sesión');
  const session: SessionState = createSession(root, new Date(), base);
  const ctx: TelemetryContext = {
    session_id: session.id,
    project_id: PROJECT,
    repository: REPO,
    branch: BRANCH,
    ...(taskKey ? { task_key: taskKey } : {}),
  };
  const telemetry = new TelemetryClient({
    getBaseUrl: () => API_URL,
    getApiKey: async () => API_KEY ?? 'demo-mode',
    store: memStore(),
    logger,
    fetchImpl: apiFetch,
    autoFlush: false,
    flushThreshold: 1000,
  });
  const emit = <T extends ProductivityEventType>(type: T, payload: PayloadOf<T>) => {
    const ev = telemetry.track(ctx, type, payload);
    console.log(`  evento ${type} ${ev ? 'encolado' : 'DESCARTADO'}`);
    if (!ev) throw new Error(`${type} no valida contra el contrato`);
  };
  emit('session.started', {
    editor: `headless-e2e node ${process.version}`.slice(0, 60),
    extension_version: EXT_VERSION,
    branch: BRANCH,
    ...(base ? { head_sha: base } : {}),
  });
  console.log(`  session_id: ${session.id}`);
  const index = new RepoHashIndex(session.salt, root, logger);
  await index.ensureBuilt();
  console.log(`  índice del repo: ${index.fileCount} archivos`);

  const ask = async (filePath: string, instruction: string, fileContent: string): Promise<SmartAutoResult> => {
    const r = await callSmartAuto({
      baseUrl: MAGIHUB_URL,
      apiKey: MAGIHUB_KEY,
      messages: buildMessages({ path: filePath, languageId: 'typescript', fileContent, instruction }),
      localId: randomUUID,
    });
    session.stats.requests++;
    if (r.usage) session.stats.tokens_reported += r.usage.total_tokens;
    console.log(
      `  Smart Auto: request ${r.requestId} (${r.requestIdSource}) · modelo ${r.model} · usage ${JSON.stringify(r.usage)} · ` +
        `${r.latencyMs} ms · simulado=${r.simulated}`,
    );
    const extracted = extractCodeBlock(r.content);
    emit('ai.request.completed', {
      ai_request_id: r.requestId,
      ...(r.model ? { model: r.model } : {}),
      status: 'ok',
      latency_ms: r.latencyMs,
      ...(r.usage ? { usage: r.usage, usage_source: r.simulated ? 'magihub-mock' : 'magihub-response' } : {}),
      ...(extracted && extracted.code.trim() ? { output_hash: outputHash(extracted.code) } : {}),
    });
    return r;
  };

  /** Bloques de código de la respuesta, en orden (cada uno pasa por extractCodeBlock como en el IDE). */
  const blocksOf = (content: string): string[] => {
    const out: string[] = [];
    const re = /```[\w.+#-]*\n([\s\S]*?)```/g;
    for (let m = re.exec(content); m; m = re.exec(content)) {
      const b = extractCodeBlock('```ts\n' + m[1] + '```');
      if (b) out.push(b.code);
    }
    return out;
  };

  const propose = (p: Proposal) => {
    session.stats.proposed++;
    emit('code.proposed', proposedPayload(session.salt, p));
  };

  const accept = async (p: Proposal, finalText: string, edited: boolean) => {
    const abs = path.join(root, p.path);
    const baseText = await fs.readFile(abs, 'utf8').catch(() => '');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, finalText, 'utf8');
    const r = analyzeAcceptance({
      salt: session.salt,
      proposal: p,
      finalText,
      baseText,
      edited,
      existingRepoHashes: index.snapshot(),
      sessionAcceptedHashes: sessionAcceptedHashes(session),
    });
    session.changes.push(r.stored);
    session.stats.accepted++;
    session.stats.accepted_lines += r.stored.accepted_lines;
    session.stats.effective_lines += r.stored.effective_lines;
    index.setFile(p.path, finalText);
    console.log(`  aceptado ${p.path}${edited ? ' (editado antes de aceptar)' : ''}: dimensiones ${JSON.stringify(r.payload.dimensions)}`);
    emit('code.accepted', r.payload);
  };

  // ── 3. propuesta aceptada: utilidad + prueba ─────────────────────────────
  section('3. Smart Auto → propuesta aceptada (utilidad + prueba)');
  const IMPL = 'examples/e2e/token-utils.ts';
  const TEST = 'examples/e2e/token-utils.test.ts';
  const r1 = await ask(
    IMPL,
    'Crea la función llamada sumPositiveTokens que sume solo los conteos de tokens positivos de un reporte, con su prueba unitaria en Vitest.',
    '',
  );
  const blocks = blocksOf(r1.content);
  if (blocks.length === 0) throw new Error('La respuesta de Smart Auto no trae código');
  const implCode = conformText(blocks[0]!, '\n', true);
  const pImpl = makeProposal({ change_id: randomUUID(), ai_request_id: r1.requestId, path: IMPL, language: 'typescript', originalText: '', proposedText: implCode });
  propose(pImpl);
  await accept(pImpl, implCode, false);

  if (blocks[1]) {
    const testCode = conformText(blocks[1], '\n', true);
    const pTest = makeProposal({ change_id: randomUUID(), ai_request_id: r1.requestId, path: TEST, language: 'typescript', originalText: '', proposedText: testCode });
    propose(pTest);
    // el usuario corrige la ruta del import antes de aceptar ("Editar y aceptar")
    const edited = testCode.replace(/from '\.\/[\w-]+'/, "from './token-utils'");
    await accept(pTest, edited, edited !== testCode);
  }

  // ── 4. propuesta rechazada (exploración) ─────────────────────────────────
  section('4. Smart Auto → propuesta rechazada');
  const current = await fs.readFile(path.join(root, IMPL), 'utf8');
  const r2 = await ask(IMPL, 'Agrega la función llamada formatTokenLabel para mostrar etiquetas de modelos en el reporte.', current);
  const ex2 = extractCodeBlock(r2.content);
  const pRej = makeProposal({
    change_id: randomUUID(),
    ai_request_id: r2.requestId,
    path: IMPL,
    language: 'typescript',
    originalText: current,
    proposedText: conformText(ex2?.code ?? '', '\n', true),
  });
  propose(pRej);
  session.stats.rejected++;
  emit('code.rejected', { change_id: pRej.change_id, ai_request_id: pRej.ai_request_id, reason: 'user' });
  console.log('  rechazada: reemplazaba el archivo entero por una función de otro tipo');

  // ── 5. commit ────────────────────────────────────────────────────────────
  section('5. git commit → git.committed');
  await git(root, ['add', '--', ...session.changes.flatMap((c) => c.paths)]);
  const message = [
    'Agrega utilidades de tokens para el reporte de productividad',
    '',
    'Suma solo los conteos de tokens positivos e incluye su prueba unitaria.',
    '',
    `MagiCode-Session: ${session.id}`,
    ...(taskKey ? [`MagiCode-Task: ${taskKey}`] : []),
  ].join('\n');
  await git(root, ['commit', '-q', '-m', message]);
  const sha = (await headSha(root))!;
  const header = await readCommitHeader(root, sha);
  if (!header) throw new Error('No se pudo leer el commit');
  const diff = await readCommitDiff(root, header);
  const a = analyzeCommit(session, header, diff);
  markProcessed(session, sha);
  recordCommitted(session, a.payload.change_ids, a.matchedHashes);
  session.commits.push({
    sha,
    committed_at: header.committedAt,
    change_ids: a.payload.change_ids,
    ai_share: a.payload.automation.ai_share,
    ai_matched_lines: a.aiMatchedLines,
    has_session_trailer: a.payload.has_session_trailer,
  });
  session.stats.commits++;
  session.stats.ai_committed_lines += a.aiMatchedLines;
  session.last_head = sha;
  console.log(`  commit ${sha} · matched=${a.matched} · automation ${JSON.stringify(a.payload.automation)}`);
  emit('git.committed', { ...a.payload, branch: BRANCH, remote_url: remote.slice(0, 512) });
  await telemetry.flush(true);

  // ── 6. push ──────────────────────────────────────────────────────────────
  section('6. git push de la rama');
  const token = execFileSync('gh', ['auth', 'token', '-u', GH_USER], { encoding: 'utf8' }).trim();
  const authArgs = ['-c', 'credential.helper=', '-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`];
  const push = async (ref: string) => {
    const r = await runGit(root, [...authArgs, 'push', '--quiet', 'origin', ref]);
    if (r.code !== 0) throw new Error(`git push ${ref} falló: ${r.stderr.split(token).join('***')}`);
    console.log(`  push ${ref}: ok`);
  };
  await push(`refs/heads/${BRANCH}:refs/heads/${BRANCH}`);

  // ── 7. tag de referencia ─────────────────────────────────────────────────
  section('7. Versión de referencia (tag anotado)');
  if (!isValidTagName(TAG)) throw new Error(`Tag inválido: ${TAG}`);
  await createAnnotatedTag(root, TAG, `Versión de referencia de la prueba de punta a punta (${STAMP})`);
  await push(`refs/tags/${TAG}`);
  const ref = await computeReference(root, session, TAG);
  session.reference = {
    tag: TAG,
    sha: ref.sha,
    included_shas: ref.payload.included_shas,
    surviving_lines: ref.payload.surviving_lines,
    surviving_effective_lines: ref.payload.surviving_effective_lines,
    marked_at: new Date().toISOString(),
  };
  console.log(`  tag ${TAG} → ${ref.sha} · supervivencia ${ref.payload.surviving_lines} líneas (${ref.payload.surviving_effective_lines} efectivas)`);
  emit('reference.marked', ref.payload);

  // ── 8. cierre ────────────────────────────────────────────────────────────
  section('8. Fin de sesión + flush');
  emit('session.ended', { reason: 'user' });
  await telemetry.flush(true);
  console.log(`  enviados=${telemetry.sent} pendientes=${telemetry.pending} descartados=${telemetry.dropped} lastError=${telemetry.lastError ?? '-'}`);
  console.log(`  stats de sesión: ${JSON.stringify(session.stats)}`);
  console.log(
    '\nRESULTADO ' +
      JSON.stringify({ session_id: session.id, branch: BRANCH, task_key: taskKey, sha, tag: TAG, tag_sha: ref.sha, clone: root, languages: session.changes.map((c) => c.paths.map(languageFromPath)) }),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
