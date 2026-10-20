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
import {
  changeRef,
  commitRef,
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
}

/** Contexto que recibe el hook de scoring cuando un cambio pasa a "accepted". */
export interface AcceptedChangeContext {
  tenant_id: string;
  key_id: string;
  session_id: string;
  change_id: string;
  event: Extract<ProductivityEvent, { event_type: 'code.accepted' }>;
}

/**
 * TODO(scoring): hook que el módulo `src/modules/scoring` completará (scoringService.scoreChange →
 * guardar `scores` en el Change). Se invoca tras escribir el Change en code.accepted; sus errores
 * se registran y NO hacen fallar la ingesta.
 */
export async function onChangeAccepted(change: AcceptedChangeContext): Promise<void> {
  void change;
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
  constructor(
    private readonly repo: ProductivityRepository = productivityRepository,
    private readonly usage: UsageService = usageService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

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
      const proj = projectEvent({ tenant_id: t, key_id: caller.key_id, table: tableName(), now: this.clock().toISOString() }, ev, state);
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
      if (ev.event_type === 'git.committed') {
        state.commits.set(commitRef(ev.repository, ev.payload.sha), {
          session_id: ev.session_id,
          change_ids: ev.payload.change_ids,
        });
      }
      if (ev.event_type === 'code.accepted') {
        await onChangeAccepted({ tenant_id: t, key_id: caller.key_id, session_id: ev.session_id, change_id: ev.payload.change_id, event: ev }).catch(
          (err) => logger.warn('onChangeAccepted falló', { change_id: ev.payload.change_id, err }),
        );
      }
    }

    return { accepted, duplicates, attribution: await this.attributionHint(caller) };
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
      case 'git.committed':
        return loadChanges(ev.payload.change_ids.map((c) => ({ session: ev.session_id, change: c })));
      case 'reference.marked': {
        const shas = [...new Set(ev.payload.included_shas.map((s) => s.toLowerCase()))];
        const missing = shas.filter((s) => !state.commits.has(commitRef(ev.repository, s)) && !loaded.has(`K|${commitRef(ev.repository, s)}`));
        if (missing.length) {
          const commits = await this.repo.batchGet<CommitItem>(missing.map((s) => keys.commit(t, ev.repository, s)));
          for (const s of missing) loaded.add(`K|${commitRef(ev.repository, s)}`);
          for (const c of commits) state.commits.set(commitRef(c.repository, c.sha), { session_id: c.session_id, change_ids: c.change_ids ?? [] });
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
    return {
      sessions,
      requests: parts.flatMap((p) => p.requests).filter((r) => inWindow(r.occurred_at, from, to)),
      changes: parts.flatMap((p) => p.changes).filter((c) => inWindow(c.first_seen_at, from, to)),
      commits: parts.flatMap((p) => p.commits).filter((c) => inWindow(c.committed_at, from, to)),
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

  private async deployments(t: string, commits: CommitItem[]): Promise<DeploymentEvidence[]> {
    const lists = await mapLimit(commits, 8, (c) => this.repo.listDeploymentsOfSha(t, c.repository, c.sha).catch(() => []));
    return lists.flat();
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
    const [deployments, external] = await Promise.all([
      this.deployments(t, data.commits),
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
