import {
  ProductivityEvent,
  keys,
  type EventsRequest,
  type Attribution,
  type ChangeListItem,
  type EventsResponse,
  type ProductivitySummary,
  type SessionListItem,
  type TimelinePoint,
} from '@magicode/contracts';
import { z } from 'zod';
import { createLogger } from '../../config/logger';
import { config } from '../../config/config';
import { tableName } from '../../config/dynamo';
import { chunk } from '../../common/utils/dynamo-expr';
import { DAY_MS, iso } from '../../common/utils/time';
import { HttpException, NotFoundException, UnauthorizedException } from '../../common/exceptions';
import { usageService, type UsageService } from '../usage/usage.service';
import { usageRepository } from '../usage/usage.repository';
import { summaryWarnings } from '../integration-health/summary-warnings';
import { integrationsRepository, type IntegrationsRepository } from '../integrations/integrations.repository';
import {
  onChangeAccepted as buildScoresUpdate,
  scoringInputFromAcceptedEvent,
  scoringService,
  type ScoringContext,
  type ScoringService,
} from '../scoring';
import { taskSyncService } from '../task-sync/task-sync.service';
import type { FireTrigger } from '../task-sync/task-sync.types';
import {
  changeRef,
  commitRef,
  eventBranch,
  eventTaskKeys,
  projectEvent,
  type PreState,
  type Projection,
} from './productivity.projection';
import { productivityRepository, type ProductivityRepository } from './productivity.repository';
import {
  computeChangeItems,
  computeSessionItems,
  computeSummary,
  computeTimeline,
} from './productivity.metrics';
import type {
  AiRequestItem,
  ChangeItem,
  CommitItem,
  DeploymentEvidence,
  MetricsInput,
  PullRequestRef,
  ProductivityQuery,
  ReferenceMark,
  SessionItem,
  SummaryScope,
  UsageInput,
} from './productivity.types';

const logger = createLogger('Productivity');

const EventsBatch = z.object({ events: z.array(ProductivityEvent).min(1).max(25) });

export interface Caller {
  tenant_id: string;
  key_id: string;
  /** identidad MagiHub (c.get('identity')) — se guarda en Session para integration-health */
  key_fingerprint?: string;
  key_name?: string;
}

type CodeAcceptedEvent = Extract<ProductivityEvent, { event_type: 'code.accepted' }>;

/** Contexto que recibe el scoring cuando un cambio pasa a "accepted". */
export interface AcceptedChangeContext {
  tenant_id: string;
  key_id: string;
  session_id: string;
  change_id: string;
  event: CodeAcceptedEvent;
}

const ACCEPTED = new Set(['accepted', 'committed', 'in_reference']);
const changeTime = (c: Pick<ChangeItem, 'accepted_at' | 'first_seen_at'>) => c.accepted_at ?? c.first_seen_at ?? '';

/**
 * ScoringContext del cambio (espejo de ml/export_dataset.py → build_dataset):
 *  - tokens_total: usage de su petición + la cadena `regenerates` (tokens imputados completos);
 *  - regenerations: largo de la cadena; latency_ms de la petición;
 *  - session_acceptance_rate: aceptados / propuestos de la sesión hasta este cambio inclusive
 *    (sin cambios ⇒ undefined ⇒ 0.6 en buildFeatures);
 *  - task_type: `type` de la Task (Story/Bug…).
 */
export function scoringContextFor(
  ev: Pick<CodeAcceptedEvent, 'occurred_at'> & { payload: { change_id: string; ai_request_id: string } },
  requests: Array<Pick<AiRequestItem, 'ai_request_id' | 'usage' | 'latency_ms' | 'regenerates'>>,
  changes: Array<Pick<ChangeItem, 'change_id' | 'status' | 'accepted_at' | 'first_seen_at'>>,
  taskType?: string | null,
): ScoringContext {
  const byId = new Map(requests.map((r) => [r.ai_request_id, r]));
  const req = byId.get(ev.payload.ai_request_id);
  let tokens = req?.usage?.total_tokens ?? 0;
  let regenerations = 0;
  let cur = req;
  const seen = new Set<string>();
  while (cur?.regenerates && !seen.has(cur.regenerates) && regenerations < 20) {
    seen.add(cur.regenerates);
    cur = byId.get(cur.regenerates);
    tokens += cur?.usage?.total_tokens ?? 0;
    regenerations++;
  }
  const t0 = ev.occurred_at;
  const upTo = changes.filter((c) => c.change_id !== ev.payload.change_id && changeTime(c) <= t0);
  const proposed = upTo.length + 1; // + el propio cambio (aceptado)
  const accepted = upTo.filter((c) => ACCEPTED.has(c.status)).length + 1;
  return {
    tokens_total: req ? tokens : undefined,
    regenerations,
    ...(req ? { latency_ms: req.latency_ms } : {}),
    session_acceptance_rate: accepted / proposed,
    task_type: taskType ?? null,
  };
}

export interface ProductivityDeps {
  scoring?: ScoringService;
  fireTrigger?: FireTrigger;
  integrations?: Pick<IntegrationsRepository, 'listByTenant'>;
}

/** Sesiones que se consideran por consulta (las más recientes) y retrospectiva para sesiones largas. */
const MAX_SESSIONS = 200;
const SESSION_LOOKBACK_DAYS = 7;

async function mapLimit<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (i < xs.length) {
        const idx = i++;
        out[idx] = await fn(xs[idx]!);
      }
    }),
  );
  return out;
}

const inWindow = (v: string | undefined, from: string, to: string) => !!v && v >= from && v <= to;

function isDuplicateCancel(err: unknown): boolean {
  const e = err as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  return e?.name === 'TransactionCanceledException' && e.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed';
}

interface ScopeData {
  sessions: SessionItem[];
  requests: AiRequestItem[];
  changes: ChangeItem[];
  commits: CommitItem[];
  references: ReferenceMark[];
  projectIds: string[];
}

export class ProductivityService {
  private readonly scoring: ScoringService;
  private readonly fireTrigger: FireTrigger;
  private readonly integrations: Pick<IntegrationsRepository, 'listByTenant'>;

  constructor(
    private readonly repo: ProductivityRepository = productivityRepository,
    private readonly usage: UsageService = usageService,
    private readonly clock: () => Date = () => new Date(),
    deps: ProductivityDeps = {},
  ) {
    this.scoring = deps.scoring ?? scoringService;
    this.fireTrigger = deps.fireTrigger ?? ((trigger, input) => taskSyncService.fireTrigger(trigger, input));
    this.integrations = deps.integrations ?? integrationsRepository;
  }

  // ── Ingesta ──────────────────────────────────────────────────────────────

  /** POST /productivity/events — idempotente por event_id; tenant/key SIEMPRE del caller. */
  async ingest(caller: Caller, body: unknown): Promise<EventsResponse> {
    // Mismo contrato que EventsRequest, pero validando por rama para que los errores indiquen el índice del evento.
    const isBatch = !!body && typeof body === 'object' && 'events' in (body as object);
    const req: EventsRequest = isBatch ? EventsBatch.parse(body) : ProductivityEvent.parse(body);
    const events = ('events' in req ? req.events : [req])
      .map((e, i) => ({ e, i }))
      .sort((a, b) => a.e.occurred_at.localeCompare(b.e.occurred_at) || a.i - b.i)
      .map((x) => x.e);

    const t = caller.tenant_id;
    const state: PreState = { changes: new Map(), commits: new Map() };
    const loaded = new Set<string>();
    const seen = new Set<string>();
    const prefixesOf = this.taskPrefixesLoader(t);
    let accepted = 0;
    let duplicates = 0;

    for (const ev of events) {
      if (seen.has(ev.event_id)) {
        duplicates++;
        continue;
      }
      seen.add(ev.event_id);
      if (await this.repo.get(keys.dedupe(t, ev.event_id), true)) {
        duplicates++;
        continue;
      }
      await this.preload(t, ev, state, loaded);
      const now = this.clock().toISOString();
      const proj = projectEvent(
        {
          tenant_id: t,
          key_id: caller.key_id,
          table: tableName(),
          now,
          key_fingerprint: caller.key_fingerprint,
          key_name: caller.key_name,
          task_prefixes: await prefixesOf(ev.project_id),
        },
        ev,
        state,
      );
      try {
        await this.write(proj);
      } catch (err) {
        if (isDuplicateCancel(err)) {
          duplicates++;
          continue;
        }
        throw err;
      }
      accepted++;
      for (const cs of proj.changeStatuses) state.changes.set(cs.key, cs.status);
      if (proj.commit) state.commits.set(proj.commit.key, proj.commit.value);
      if (ev.event_type === 'code.accepted') {
        const taskKey = eventTaskKeys(ev, await prefixesOf(ev.project_id))[0];
        await this.scoreAccepted({ tenant_id: t, key_id: caller.key_id, session_id: ev.session_id, change_id: ev.payload.change_id, event: ev }, taskKey, now);
      }
      // reglas de write-back (commit.linked, session.started, reference.marked): nunca rompen la ingesta
      for (const tr of proj.triggers) {
        try {
          await this.fireTrigger(tr.trigger, tr.input);
        } catch (err) {
          logger.warn('fireTrigger falló', { trigger: tr.trigger, ref: tr.input.ref, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    return { accepted, duplicates, attribution: await this.attributionHint(caller) };
  }

  /** Prefijos Jira/Linear por proyecto (misma fuente que webhooks.taskPrefixes), cacheados por lote. */
  private taskPrefixesLoader(t: string): (projectId: string) => Promise<string[] | null> {
    let all: Promise<Array<{ project_id: string; status: string; task_project_keys?: string[] }>> | undefined;
    return async (projectId) => {
      try {
        all ??= this.integrations.listByTenant(t);
        const prefixes = (await all)
          .filter((i) => i.project_id === projectId && i.status !== 'disabled')
          .flatMap((i) => i.task_project_keys ?? []);
        return prefixes.length ? [...new Set(prefixes)] : null;
      } catch (err) {
        logger.warn('No se pudieron leer los prefijos de tareas; se usa la denylist', { error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    };
  }

  /**
   * Scoring del cambio recién aceptado (XGBoost o heurística 'heuristic:v1') → `scores` en el Change
   * (UpdateItem con attribute_exists). Errores registrados; NUNCA fallan la ingesta.
   */
  private async scoreAccepted(a: AcceptedChangeContext, taskKey: string | undefined, now: string): Promise<void> {
    try {
      const [requests, changes, task] = await Promise.all([
        this.repo.listSessionPrefix<AiRequestItem>(a.tenant_id, a.session_id, 'R#'),
        this.repo.listSessionPrefix<ChangeItem>(a.tenant_id, a.session_id, 'C#'),
        taskKey ? this.repo.get<{ type?: string | null }>(keys.task(a.tenant_id, taskKey)) : Promise.resolve(undefined),
      ]);
      const ctx = scoringContextFor(a.event, requests, changes, task?.type);
      const input = { ...scoringInputFromAcceptedEvent(a), branch: eventBranch(a.event), task_key: taskKey };
      const { update } = await buildScoresUpdate(input, { ...ctx, tableName: tableName(), nowIso: now }, this.scoring);
      await this.repo.update(update);
    } catch (err) {
      logger.warn('Scoring del cambio falló (la ingesta sigue)', {
        change_id: a.change_id,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
  }

  /** core + linked en una sola transacción si caben (≤100); si no, linked (idempotente) primero. */
  private async write(p: Projection): Promise<void> {
    const all = [...p.core, ...p.linked];
    if (all.length <= 100) return this.repo.transactWrite(all);
    for (const part of chunk(p.linked, 100)) await this.repo.transactWrite(part);
    await this.repo.transactWrite(p.core);
  }

  /** Lee el estado previo necesario para transiciones de estado (cambios y commits). */
  private async preload(t: string, ev: ProductivityEvent, state: PreState, loaded: Set<string>): Promise<void> {
    const loadChanges = async (refs: Array<{ session: string; change: string }>) => {
      const missing = refs.filter((r) => !loaded.has(`C|${changeRef(r.session, r.change)}`));
      if (!missing.length) return;
      const items = await this.repo.batchGet<ChangeItem>(missing.map((r) => keys.change(t, r.session, r.change)));
      for (const r of missing) loaded.add(`C|${changeRef(r.session, r.change)}`);
      for (const it of items) state.changes.set(changeRef(it.session_id, it.change_id), it.status);
    };
    switch (ev.event_type) {
      case 'code.proposed':
      case 'code.accepted':
      case 'code.rejected':
        return loadChanges([{ session: ev.session_id, change: ev.payload.change_id }]);
      case 'git.committed': {
        // commit existente (push previo): sus task_keys/remote_url se unen a los del IDE
        const ref = commitRef(ev.repository, ev.payload.sha);
        if (!state.commits.has(ref) && !loaded.has(`K|${ref}`)) {
          loaded.add(`K|${ref}`);
          const prev = await this.repo.get<CommitItem>(keys.commit(t, ev.repository, ev.payload.sha.toLowerCase()));
          if (prev) state.commits.set(ref, { session_id: prev.session_id, change_ids: prev.change_ids ?? [], task_keys: prev.task_keys, remote_url: prev.remote_url });
        }
        return loadChanges(ev.payload.change_ids.map((c) => ({ session: ev.session_id, change: c })));
      }
      case 'reference.marked': {
        const shas = [...new Set(ev.payload.included_shas.map((s) => s.toLowerCase()))];
        const missing = shas.filter((s) => !state.commits.has(commitRef(ev.repository, s)) && !loaded.has(`K|${commitRef(ev.repository, s)}`));
        if (missing.length) {
          const commits = await this.repo.batchGet<CommitItem>(missing.map((s) => keys.commit(t, ev.repository, s)));
          for (const s of missing) loaded.add(`K|${commitRef(ev.repository, s)}`);
          for (const c of commits) {
            state.commits.set(commitRef(c.repository, c.sha), {
              session_id: c.session_id,
              change_ids: c.change_ids ?? [],
              task_keys: c.task_keys,
              remote_url: c.remote_url,
            });
          }
        }
        const refs = shas.flatMap((s) => {
          const c = state.commits.get(commitRef(ev.repository, s));
          return c ? c.change_ids.map((id) => ({ session: c.session_id, change: id })) : [];
        });
        return loadChanges(refs);
      }
      default:
        return;
    }
  }

  /** exact si la última sync de usage de la key logró granularity=request. */
  private async attributionHint(caller: Caller): Promise<Attribution> {
    try {
      const marker = await usageRepository.getMarker(caller.tenant_id, caller.key_id);
      return marker?.granularity === 'request' ? 'exact' : 'estimated';
    } catch {
      return 'estimated';
    }
  }

  // ── Lecturas ─────────────────────────────────────────────────────────────

  private async candidateSessions(caller: Caller, q: ProductivityQuery): Promise<{ sessions: SessionItem[]; projectIds: string[] }> {
    const t = caller.tenant_id;
    let sessions: SessionItem[];
    let projectIds: string[];
    if (q.session_id) {
      const s = await this.repo.getSession(t, q.session_id);
      sessions = s ? [s] : [];
      projectIds = s ? [s.project_id] : q.project_id ? [q.project_id] : [];
    } else if (q.task_key) {
      const ids = await this.repo.listTaskSessionIds(t, q.task_key);
      sessions = await this.repo.batchGet<SessionItem>(ids.map((id) => keys.session(t, id)));
      projectIds = q.project_id ? [q.project_id] : [...new Set(sessions.map((s) => s.project_id))];
    } else {
      projectIds = q.project_id ? [q.project_id] : (await this.repo.listProjects(t)).map((p) => p.project_id);
      const since = iso(Date.parse(q.from) - SESSION_LOOKBACK_DAYS * DAY_MS);
      sessions = (await mapLimit(projectIds, 4, (p) => this.repo.listSessionsOfProject(t, p, since, q.to))).flat();
    }
    const filtered = sessions
      .filter((s) => s.key_id === caller.key_id) // tokens = consumo de ESTA key: solo sus sesiones
      .filter((s) => !q.project_id || s.project_id === q.project_id)
      .filter((s) => !q.repository || s.repository === q.repository)
      .filter((s) => !q.branch || s.branch === q.branch)
      .filter((s) => !!q.session_id || (s.last_activity_at ?? s.started_at) >= q.from)
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
      .slice(0, MAX_SESSIONS);
    return { sessions: filtered, projectIds };
  }

  private async loadScope(caller: Caller, q: ProductivityQuery): Promise<ScopeData> {
    const t = caller.tenant_id;
    const { sessions, projectIds } = await this.candidateSessions(caller, q);
    const parts = await mapLimit(sessions, 8, async (s) => {
      const [p, commits] = await Promise.all([
        this.repo.loadSessionPartition(t, s.session_id),
        this.repo.listCommitsOfSession(t, s.session_id),
      ]);
      return { ...p, commits };
    });
    const { from, to } = q;
    // ?task_key: filas de la tarea o sin tarea en una sesión enlazada (mismo criterio que tasks)
    const ofTask = (row: { task_key?: string }) => !q.task_key || !row.task_key || row.task_key === q.task_key;
    const commitOfTask = (c: CommitItem) => !q.task_key || !c.task_keys?.length || c.task_keys.includes(q.task_key);
    return {
      sessions,
      requests: parts.flatMap((p) => p.requests).filter((r) => inWindow(r.occurred_at, from, to) && ofTask(r)),
      changes: parts.flatMap((p) => p.changes).filter((c) => inWindow(c.first_seen_at, from, to) && ofTask(c)),
      commits: parts.flatMap((p) => p.commits).filter((c) => inWindow(c.committed_at, from, to) && commitOfTask(c)),
      references: parts.flatMap((p) => p.references).filter((r) => inWindow(r.occurred_at, from, to)),
      projectIds,
    };
  }

  private async usageInput(caller: Caller, apiKey: string, q: ProductivityQuery, force: boolean): Promise<UsageInput | null> {
    try {
      const w = await this.usage.getWindow(caller, apiKey, q.from, q.to, { force });
      return {
        records: w.response.records,
        granularity: w.granularity,
        provenance: w.provenance,
        source: w.source,
        ...(w.response.ingestion_delay_minutes !== undefined ? { ingestion_delay_minutes: w.response.ingestion_delay_minutes } : {}),
      };
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      logger.warn('usage no disponible; se usa Σ usage reportado (estimated)', {
        reason: err instanceof HttpException ? err.code : err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Deployments + PRs de los repos de los commits (regla de despliegue del commit o del merge de su PR). */
  private async deploymentEvidence(t: string, commits: CommitItem[]): Promise<{ deployments: DeploymentEvidence[]; pullRequests: PullRequestRef[] }> {
    const repos = [...new Set(commits.map((c) => c.repository))];
    const parts = await mapLimit(repos, 4, async (r) => {
      const [deps, prs] = await Promise.all([
        this.repo.listDeploymentsOfRepo(t, r).catch(() => [] as DeploymentEvidence[]),
        this.repo.listPullRequestsOfRepo(t, r).catch(() => [] as PullRequestRef[]),
      ]);
      return { deps, prs };
    });
    return { deployments: parts.flatMap((p) => p.deps), pullRequests: parts.flatMap((p) => p.prs) };
  }

  private async externalCounts(t: string, q: ProductivityQuery, projectIds: string[]) {
    const prs = (await mapLimit(projectIds, 4, (p) =>
      this.repo.listProjectGsi<{ repository?: string; state?: string }>(t, p, 'PR#', q.from, q.to).catch(() => []),
    )).flat().filter((pr) => !q.repository || pr.repository === q.repository);
    const tasks = (await mapLimit(projectIds, 4, (p) =>
      this.repo.listProjectGsi<{ task_key?: string; status_category?: string }>(t, p, 'TASK#', q.from, q.to).catch(() => []),
    )).flat().filter((tk) => !q.task_key || tk.task_key === q.task_key);
    return {
      pull_requests: prs.length,
      pull_requests_merged: prs.filter((p) => p.state === 'merged').length,
      tasks: tasks.length,
      tasks_done: tasks.filter((x) => x.status_category === 'done').length,
    };
  }

  private async buildInput(
    caller: Caller,
    apiKey: string,
    q: ProductivityQuery,
    opts: { refresh?: boolean; withExternal?: boolean } = {},
  ): Promise<MetricsInput> {
    const t = caller.tenant_id;
    const scoped = !!(q.project_id || q.repository || q.session_id || q.task_key || q.branch);
    const [data, usage] = await Promise.all([this.loadScope(caller, q), this.usageInput(caller, apiKey, q, !!opts.refresh)]);
    const keyRequests =
      scoped && usage && usage.granularity !== 'request'
        ? await this.repo.listRequestsOfKey(t, caller.key_id, q.from, q.to)
        : undefined;
    const [{ deployments, pullRequests }, external] = await Promise.all([
      this.deploymentEvidence(t, data.commits),
      opts.withExternal ? this.externalCounts(t, q, data.projectIds) : Promise.resolve(undefined),
    ]);
    const scope: SummaryScope = {
      tenant_id: t,
      key_id: caller.key_id,
      ...(q.project_id ? { project_id: q.project_id } : {}),
      ...(q.repository ? { repository: q.repository } : {}),
      ...(q.session_id ? { session_id: q.session_id } : {}),
      ...(q.task_key ? { task_key: q.task_key } : {}),
      ...(q.branch ? { branch: q.branch } : {}),
      from: q.from,
      to: q.to,
    };
    return {
      scope,
      scoped,
      magihubMode: config.getValue('magihub').mode,
      usage,
      sessions: data.sessions,
      requests: data.requests,
      keyRequests,
      changes: data.changes,
      commits: data.commits,
      references: data.references,
      deployments,
      pullRequests,
      external,
      now: this.clock().toISOString(),
    };
  }

  async summary(caller: Caller, apiKey: string, q: ProductivityQuery, refresh = false): Promise<ProductivitySummary> {
    const input = await this.buildInput(caller, apiKey, q, { refresh, withExternal: true });
    const summary = computeSummary(input);
    // avisos de readiness (webhooks obligatorios), retraso de ingesta y scoring heurístico — integration-health
    const warnings = await summaryWarnings(caller.tenant_id, {
      ...(q.project_id ? { project_id: q.project_id } : {}),
      ...(q.repository ? { repository: q.repository } : {}),
      to: q.to,
      now: input.now,
      usage: input.usage,
      changes: input.changes,
    });
    return { ...summary, warnings: [...summary.warnings, ...warnings] };
  }

  async timeline(caller: Caller, apiKey: string, q: ProductivityQuery, bucket: 'hour' | 'day'): Promise<TimelinePoint[]> {
    return computeTimeline(await this.buildInput(caller, apiKey, q), bucket);
  }

  async sessions(caller: Caller, apiKey: string, q: ProductivityQuery): Promise<SessionListItem[]> {
    return computeSessionItems(await this.buildInput(caller, apiKey, q));
  }

  async session(
    caller: Caller,
    apiKey: string,
    sessionId: string,
    win: { from?: string; to?: string },
  ): Promise<SessionListItem & { changes: ChangeListItem[] }> {
    const s = await this.repo.getSession(caller.tenant_id, sessionId);
    if (!s || s.key_id !== caller.key_id) throw new NotFoundException('Sesión no encontrada', 'SESSION_NOT_FOUND');
    const now = this.clock().toISOString();
    const q: ProductivityQuery = { session_id: sessionId, from: win.from ?? s.started_at, to: win.to ?? (s.ended_at && s.ended_at > now ? s.ended_at : now) };
    const input = await this.buildInput(caller, apiKey, q);
    const [item] = computeSessionItems(input);
    return { ...item!, changes: computeChangeItems(input) };
  }

  async changes(caller: Caller, apiKey: string, q: ProductivityQuery): Promise<ChangeListItem[]> {
    return computeChangeItems(await this.buildInput(caller, apiKey, q));
  }

  async projects(caller: Caller): Promise<Array<{ project_id: string; repositories: string[]; last_activity_at: string }>> {
    const ps = await this.repo.listProjects(caller.tenant_id);
    return ps
      .map((p) => ({ project_id: p.project_id, repositories: [...(p.repositories ?? [])].sort(), last_activity_at: p.last_activity_at }))
      .sort((a, b) => (b.last_activity_at ?? '').localeCompare(a.last_activity_at ?? ''));
  }

  /** GET /productivity/commits — commits con automation (por repo o todos los del tenant). */
  async commits(caller: Caller, q: { repository?: string; from?: string; to?: string }) {
    const t = caller.tenant_id;
    const repos = q.repository ? [q.repository] : [...new Set((await this.repo.listProjects(t)).flatMap((p) => [...(p.repositories ?? [])]))];
    const commits = (await mapLimit(repos, 4, (r) => this.repo.listCommitsOfRepo(t, r))).flat();
    return commits
      .filter((c) => (!q.from || c.committed_at >= q.from) && (!q.to || c.committed_at <= q.to))
      .map((c) => ({
        sha: c.sha,
        repository: c.repository,
        session_id: c.session_id,
        project_id: c.project_id,
        branch: c.branch ?? null,
        task_keys: c.task_keys ?? [],
        parent_sha: c.parent_sha ?? null,
        committed_at: c.committed_at,
        files: c.files,
        change_ids: c.change_ids,
        automation: c.automation,
        has_session_trailer: c.has_session_trailer,
        source: c.commit_source,
        reference_tags: c.reference_tags ?? [],
        provenance: c.provenance,
      }))
      .sort((a, b) => b.committed_at.localeCompare(a.committed_at));
  }
}

export const productivityService = new ProductivityService();
