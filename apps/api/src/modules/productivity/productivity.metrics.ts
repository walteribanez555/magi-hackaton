import type {
  Attribution,
  ChangeListItem,
  DataSource,
  DimensionsSummary,
  FunnelStage,
  FunnelStep,
  LineKind,
  Measured,
  ProductivitySummary,
  Provenance,
  SessionListItem,
  TimelinePoint,
  TokenBreakdown,
} from '@magicode/contracts';
import type {
  AiRequestItem,
  ChangeItem,
  CommitItem,
  DeploymentEvidence,
  MetricsInput,
  ReferenceMark,
} from './productivity.types';

/**
 * Cálculo PURO de métricas (docs/metrics-model.md §3). Sin I/O: el servicio arma `MetricsInput`
 * (ya filtrado por ventana y scope) y aquí solo se agrega. Toda cifra sale como `Measured`.
 */

// ── Procedencia ──────────────────────────────────────────────────────────────

const PROV_RANK: Record<Provenance, number> = { real: 0, estimated: 1, simulated: 2 };

/** La "peor" procedencia presente: simulated > estimated > real. */
export function worst(...ps: Array<Provenance | undefined>): Provenance {
  let w: Provenance = 'real';
  for (const p of ps) if (p && PROV_RANK[p] > PROV_RANK[w]) w = p;
  return w;
}

const m = (value: number | null, provenance: Provenance, source: DataSource, note?: string): Measured => ({
  value: value === null || !Number.isFinite(value) ? null : round(value),
  provenance,
  source,
  ...(note ? { note } : {}),
});

const round = (v: number, d = 4): number => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

/** a / b o null si b = 0 (nunca Infinity/NaN). */
export const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);
/** (tokens / líneas) × 100 o null si líneas = 0. */
export const per100 = (tokens: number | null, lines: number): number | null =>
  tokens === null || lines <= 0 ? null : (tokens / lines) * 100;

const sum = <T>(xs: T[], f: (x: T) => number | undefined): number => xs.reduce((a, x) => a + (f(x) ?? 0), 0);

const itemsProvenance = (xs: Array<{ provenance?: Provenance }>): Provenance => worst(...xs.map((x) => x.provenance));
const telemetrySource = (xs: Array<{ source?: string }>): DataSource =>
  xs.some((x) => x.source === 'demo-seed') ? 'demo-seed' : 'ide-telemetry';

// ── Estados ──────────────────────────────────────────────────────────────────

const ACCEPTED_STATUSES = new Set(['accepted', 'committed', 'in_reference']);
export const isAccepted = (c: ChangeItem): boolean => ACCEPTED_STATUSES.has(c.status);

const shaEq = (a: string, b: string): boolean => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
};

// ── Tokens por petición ──────────────────────────────────────────────────────

export interface RequestTokens {
  tokens: number;
  provenance: Provenance;
  source: DataSource;
  /** true si el valor salió de un registro de usage con el mismo request_id */
  exact: boolean;
}

function reportedProvenance(r: AiRequestItem, mode: MetricsInput['magihubMode']): Provenance {
  return mode === 'mock' || r.usage_source === 'magihub-mock' || r.provenance === 'simulated' ? 'simulated' : 'real';
}

/** Resuelve los tokens de cada petición: registro exacto de usage (request_id) > usage de la respuesta. */
export function resolveRequestTokens(input: MetricsInput): Map<string, RequestTokens> {
  const out = new Map<string, RequestTokens>();
  const byId = new Map<string, number>();
  if (input.usage?.granularity === 'request') {
    for (const r of input.usage.records) {
      if (r.request_id) byId.set(r.request_id, (byId.get(r.request_id) ?? 0) + r.usage.total_tokens);
    }
  }
  const sim = input.magihubMode === 'mock';
  for (const r of input.requests) {
    const exact = byId.get(r.ai_request_id);
    if (exact !== undefined && input.usage) {
      out.set(r.ai_request_id, {
        tokens: exact,
        provenance: sim ? 'simulated' : input.usage.provenance,
        source: sim ? 'magihub-mock' : input.usage.source,
        exact: true,
      });
    } else if (r.usage) {
      const prov = reportedProvenance(r, input.magihubMode);
      out.set(r.ai_request_id, {
        tokens: r.usage.total_tokens,
        provenance: prov,
        source: prov === 'simulated' ? 'magihub-mock' : 'magihub-response',
        exact: false,
      });
    } else {
      out.set(r.ai_request_id, {
        tokens: 0,
        provenance: sim ? 'simulated' : 'estimated',
        source: sim ? 'magihub-mock' : 'magihub-response',
        exact: false,
      });
    }
  }
  return out;
}

function sumRequests(reqs: AiRequestItem[], tokens: Map<string, RequestTokens>, fallback: Measured, note?: string): Measured {
  if (!reqs.length) return m(0, fallback.provenance, fallback.source, note);
  const parts = reqs.map((r) => tokens.get(r.ai_request_id)).filter((x): x is RequestTokens => !!x);
  const src = parts.find((p) => p.exact)?.source ?? parts[0]?.source ?? fallback.source;
  return m(sum(parts, (p) => p.tokens), worst(...parts.map((p) => p.provenance)), src, note);
}

/** Peticiones cuyo output_hash repite el de una petición ANTERIOR de la misma sesión. */
export function redundantRegenerations(requests: AiRequestItem[]): AiRequestItem[] {
  const seen = new Map<string, Set<string>>();
  const out: AiRequestItem[] = [];
  const sorted = [...requests].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  for (const r of sorted) {
    if (!r.output_hash) continue;
    const set = seen.get(r.session_id) ?? new Set<string>();
    if (set.has(r.output_hash.toLowerCase())) out.push(r);
    else set.add(r.output_hash.toLowerCase());
    seen.set(r.session_id, set);
  }
  return out;
}

// ── Total (fuente de verdad) ─────────────────────────────────────────────────

function totalTokens(input: MetricsInput, reported: Measured): { total: Measured; fromUsage: boolean } {
  const { usage, magihubMode } = input;
  const sim = magihubMode === 'mock';
  const reportedValue = reported.value ?? 0;
  const fallbackNeeded = !usage || (usage.records.length === 0 && reportedValue > 0);
  if (fallbackNeeded) {
    return {
      total: m(
        reportedValue,
        worst(reported.provenance, 'estimated'),
        reported.source,
        usage
          ? 'La API de consumo de MagiHub no tiene registros para la ventana (¿retraso de ingesta?): se usa Σ usage de las respuestas.'
          : 'API de consumo de MagiHub no disponible: se usa Σ usage de las respuestas.',
      ),
      fromUsage: false,
    };
  }
  const prov: Provenance = sim ? 'simulated' : usage.provenance;
  const src: DataSource = sim ? 'magihub-mock' : usage.source;
  if (!input.scoped) {
    return { total: m(sum(usage.records, (r) => r.usage.total_tokens), prov, src), fromUsage: true };
  }
  const ids = new Set(input.requests.map((r) => r.ai_request_id));
  if (usage.granularity === 'request') {
    const v = sum(
      usage.records.filter((r) => r.request_id && ids.has(r.request_id)),
      (r) => r.usage.total_tokens,
    );
    return { total: m(v, prov, src, 'Consumo por request_id de las peticiones del alcance.'), fromUsage: true };
  }
  // Granularidad hora/día: se prorratea cada ventana por la parte reportada del alcance.
  const all = input.keyRequests ?? input.requests;
  let v = 0;
  for (const rec of usage.records) {
    const ws = Date.parse(rec.window_start);
    const we = Date.parse(rec.window_end);
    const inBucket = (r: AiRequestItem) => {
      const t = Date.parse(r.occurred_at);
      return t >= ws && t < we;
    };
    const keyRep = sum(all.filter(inBucket), (r) => r.usage?.total_tokens);
    const scopeRep = sum(input.requests.filter(inBucket), (r) => r.usage?.total_tokens);
    if (keyRep > 0) v += rec.usage.total_tokens * (scopeRep / keyRep);
  }
  return {
    total: m(
      Math.round(v),
      worst(prov, 'estimated'),
      src,
      `Granularidad ${usage.granularity}: tokens de cada ventana prorrateados por el usage reportado del alcance.`,
    ),
    fromUsage: true,
  };
}

function costUsd(input: MetricsInput, total: Measured): Measured {
  const recs = input.usage?.records ?? [];
  const withCost = recs.filter((r) => typeof r.cost_usd === 'number');
  if (!withCost.length) return m(null, total.provenance, total.source, 'MagiHub no expone costo verificable.');
  if (!input.scoped) return m(sum(withCost, (r) => r.cost_usd), total.provenance, total.source);
  if (input.usage?.granularity === 'request') {
    const ids = new Set(input.requests.map((r) => r.ai_request_id));
    return m(
      sum(withCost.filter((r) => r.request_id && ids.has(r.request_id)), (r) => r.cost_usd),
      total.provenance,
      total.source,
      'Costo por request_id de las peticiones del alcance.',
    );
  }
  return m(null, total.provenance, total.source, 'Costo por alcance no disponible con granularidad hora/día.');
}

// ── Etapas del embudo ────────────────────────────────────────────────────────

interface StageLines {
  stage: FunnelStage;
  lines: Measured;
  effective: Measured;
}

/** Última referencia por sesión (opcionalmente solo kind=deployment). */
function latestPerSession(refs: ReferenceMark[], onlyDeployment = false): ReferenceMark[] {
  const by = new Map<string, ReferenceMark>();
  for (const r of refs) {
    if (onlyDeployment && r.kind !== 'deployment') continue;
    const cur = by.get(r.session_id);
    if (!cur || r.occurred_at > cur.occurred_at) by.set(r.session_id, r);
  }
  return [...by.values()];
}

/** Commits con evidencia de despliegue exitoso (Deployment state=success, mismo repo + SHA). */
export function deployedCommits(commits: CommitItem[], deployments: DeploymentEvidence[]): CommitItem[] {
  const ok = deployments.filter((d) => d.state === 'success');
  return commits.filter((c) => ok.some((d) => d.repository === c.repository && shaEq(d.sha, c.sha)));
}

function stageLines(input: MetricsInput): StageLines[] {
  const { changes, commits, references, deployments } = input;
  const accepted = changes.filter(isAccepted);

  const genProv = itemsProvenance(changes);
  const generated: StageLines = {
    stage: 'generated',
    lines: m(sum(changes, (c) => c.proposed_added_lines ?? c.accepted_added_lines), genProv, telemetrySource(changes)),
    effective: m(null, worst(genProv, 'estimated'), telemetrySource(changes), 'Las 3 aristas se calculan al aceptar.'),
  };

  const accProv = itemsProvenance(accepted);
  const acc: StageLines = {
    stage: 'accepted',
    lines: m(sum(accepted, (c) => c.accepted_added_lines), accProv, telemetrySource(accepted)),
    effective: m(
      sum(accepted, (c) => c.dimensions?.effective_lines),
      worst(accProv, 'estimated'),
      telemetrySource(accepted),
      'Ponderado por importancia, sin redundantes ni mecánicas (heurística local).',
    ),
  };

  const gitSrc: DataSource = commits.some((c) => c.source === 'demo-seed')
    ? 'demo-seed'
    : commits.length && commits.every((c) => c.commit_source === 'git-remote')
      ? 'git-remote'
      : 'git-local';
  const comProv = worst(itemsProvenance(commits), 'estimated');
  const committed: StageLines = {
    stage: 'committed',
    lines: m(sum(commits, (c) => c.automation.ai_matched_lines), comProv, gitSrc, 'Líneas del commit que coinciden con hashes IA.'),
    effective: m(sum(commits, (c) => c.automation.effective_lines), comProv, gitSrc),
  };

  const refs = latestPerSession(references);
  const refProv = worst(itemsProvenance(refs), 'estimated');
  const inRef: StageLines = {
    stage: 'in_reference',
    lines: m(sum(refs, (r) => r.surviving_lines), refProv, 'declared-reference', 'Versión de referencia (demo): última referencia por sesión.'),
    effective: m(sum(refs, (r) => r.surviving_effective_lines), refProv, 'declared-reference'),
  };

  // Desplegado: SOLO referencias kind=deployment (con evidence_url) o commits con Deployment success.
  const depRefs = new Map(latestPerSession(references, true).map((r) => [r.session_id, r]));
  const depCommits = deployedCommits(commits, deployments);
  const sessionIds = new Set([...depRefs.keys(), ...depCommits.map((c) => c.session_id)]);
  let depLines = 0;
  let depEff = 0;
  for (const s of sessionIds) {
    const ref = depRefs.get(s);
    const cs = depCommits.filter((c) => c.session_id === s);
    depLines += Math.max(ref?.surviving_lines ?? 0, sum(cs, (c) => c.automation.ai_matched_lines));
    depEff += Math.max(ref?.surviving_effective_lines ?? 0, sum(cs, (c) => c.automation.effective_lines));
  }
  const depProv = worst(itemsProvenance([...depRefs.values()]), itemsProvenance(depCommits), 'estimated');
  const deployed: StageLines = {
    stage: 'deployed',
    lines: m(
      depLines,
      depProv,
      'deployment-evidence',
      sessionIds.size
        ? 'Evidencia real de despliegue; líneas IA por coincidencia de hash.'
        : 'Sin evidencia de despliegue (solo cuenta reference kind=deployment o Deployment success).',
    ),
    effective: m(depEff, depProv, 'deployment-evidence'),
  };

  return [generated, acc, committed, inRef, deployed];
}

function buildFunnel(stages: StageLines[], total: Measured): FunnelStep[] {
  return stages.map((s, i) => {
    const prev = i > 0 ? stages[i - 1] : undefined;
    const lines = s.lines.value ?? 0;
    const eff = s.effective.value;
    const tokProv = worst(total.provenance, s.lines.provenance);
    return {
      stage: s.stage,
      lines: s.lines,
      effective_lines: s.effective,
      tokens_per_100_lines: m(per100(total.value, lines), tokProv, total.source, lines ? undefined : 'Sin líneas en esta etapa.'),
      tokens_per_100_effective_lines: m(
        eff === null ? null : per100(total.value, eff),
        worst(tokProv, s.effective.provenance, 'estimated'),
        total.source,
        eff ? undefined : 'Sin líneas efectivas en esta etapa.',
      ),
      conversion: prev
        ? m(ratio(lines, prev.lines.value ?? 0), worst(s.lines.provenance, prev.lines.provenance), s.lines.source)
        : m(null, s.lines.provenance, s.lines.source, 'Etapa inicial.'),
    };
  });
}

// ── Aristas ──────────────────────────────────────────────────────────────────

const KINDS: LineKind[] = ['logic', 'declaration', 'test', 'config', 'comment', 'import', 'trivial'];

function dimensionsSummary(input: MetricsInput, redundantCount: number): DimensionsSummary {
  const accepted = input.changes.filter(isAccepted);
  const withDims = accepted.filter((c) => !!c.dimensions);
  const prov = worst(itemsProvenance(withDims), 'estimated');
  const src = telemetrySource(withDims);
  const lines = sum(withDims, (c) => c.dimensions!.importance.lines);
  const weighted = sum(withDims, (c) => c.dimensions!.importance.weighted_lines);
  const byKind = Object.fromEntries(KINDS.map((k) => [k, sum(withDims, (c) => c.dimensions!.importance.by_kind[k])])) as Record<
    LineKind,
    number
  >;
  const nonTrivial = lines - byKind.trivial;
  const redundant = sum(withDims, (c) => c.dimensions!.redundancy.redundant_lines);
  const mechanical = sum(withDims, (c) => c.dimensions!.automation.mechanical_lines);

  const commitAdded = sum(input.commits, (c) => c.automation.commit_added_lines);
  const aiMatched = sum(input.commits, (c) => c.automation.ai_matched_lines);
  const aiLost = sum(input.commits, (c) => c.automation.ai_lost_lines);
  const committedChangeIds = new Set(input.commits.flatMap((c) => c.change_ids));
  const acceptedInCommits = sum(
    accepted.filter((c) => committedChangeIds.has(c.change_id)),
    (c) => c.accepted_added_lines,
  );
  const gitProv = worst(itemsProvenance(input.commits), 'estimated');
  const gitSrc: DataSource = input.commits.some((c) => c.source === 'demo-seed') ? 'demo-seed' : 'git-local';

  return {
    importance: { score: m(ratio(weighted, lines), prov, src), by_kind: byKind },
    redundancy: {
      score: m(ratio(redundant, nonTrivial), prov, src),
      intra_change: sum(withDims, (c) => c.dimensions!.redundancy.intra_change),
      existing_in_repo: sum(withDims, (c) => c.dimensions!.redundancy.existing_in_repo),
      repeated_in_session: sum(withDims, (c) => c.dimensions!.redundancy.repeated_in_session),
      redundant_regenerations: redundantCount,
    },
    automation: {
      ai_share_of_commits: m(ratio(aiMatched, commitAdded), gitProv, gitSrc),
      mechanical_share: m(ratio(mechanical, lines), prov, src),
      lost_before_commit: m(
        ratio(aiLost, acceptedInCommits),
        gitProv,
        gitSrc,
        'Líneas IA aceptadas de cambios commiteados que no aparecen en el commit.',
      ),
      accepted_as_is: sum(withDims, (c) => c.dimensions!.automation.accepted_as_is),
      edited_before_accept: sum(withDims, (c) => c.dimensions!.automation.edited_before_accept),
    },
  };
}

// ── Atribución y procedencia global ──────────────────────────────────────────

export function attributionOf(input: MetricsInput): Attribution {
  const u = input.usage;
  if (!u || u.granularity !== 'request') return 'estimated';
  if (!input.requests.length) return 'exact';
  const ids = new Set(u.records.map((r) => r.request_id).filter(Boolean));
  return input.requests.every((r) => ids.has(r.ai_request_id)) ? 'exact' : 'estimated';
}

function collectProvenance(v: unknown, acc: Provenance[]): void {
  if (!v || typeof v !== 'object') return;
  if (Array.isArray(v)) {
    for (const x of v) collectProvenance(x, acc);
    return;
  }
  const o = v as Record<string, unknown>;
  if ('provenance' in o && 'source' in o && 'value' in o) {
    acc.push(o.provenance as Provenance);
    return;
  }
  for (const x of Object.values(o)) collectProvenance(x, acc);
}

// ── API pública ──────────────────────────────────────────────────────────────

export interface ComputedTokens {
  breakdown: TokenBreakdown;
  perRequest: Map<string, RequestTokens>;
  redundant: AiRequestItem[];
}

export function computeTokens(input: MetricsInput): ComputedTokens {
  const perRequest = resolveRequestTokens(input);
  const sim = input.magihubMode === 'mock';
  const withUsage = input.requests.filter((r) => r.usage);
  const repProv = withUsage.length
    ? worst(...withUsage.map((r) => reportedProvenance(r, input.magihubMode)))
    : sim
      ? 'simulated'
      : 'real';
  const reported = m(
    sum(withUsage, (r) => r.usage!.total_tokens),
    repProv,
    repProv === 'simulated' ? 'magihub-mock' : 'magihub-response',
  );
  const { total, fromUsage } = totalTokens(input, reported);
  const unreconciled = fromUsage
    ? m(
        (total.value ?? 0) - (reported.value ?? 0),
        worst(total.provenance, reported.provenance),
        total.source,
        '≠ 0 ⇒ otra app usó la key o hay retraso de ingesta en MagiHub.',
      )
    : m(0, total.provenance, total.source, 'No reconciliable: no hay datos de la API de consumo.');

  const acceptedReq = new Set(input.changes.filter(isAccepted).map((c) => c.ai_request_id).filter(Boolean) as string[]);
  const onAccepted = sumRequests(
    input.requests.filter((r) => acceptedReq.has(r.ai_request_id)),
    perRequest,
    total,
  );
  const onRejected = sumRequests(
    input.requests.filter((r) => !acceptedReq.has(r.ai_request_id)),
    perRequest,
    total,
    'Peticiones sin cambio aceptado (rechazos, errores, exploración).',
  );
  const redundant = redundantRegenerations(input.requests);
  const onRedundant = sumRequests(redundant, perRequest, total, 'Peticiones cuyo output_hash repite uno anterior de la sesión.');

  const withDims = input.changes.filter((c) => isAccepted(c) && c.dimensions);
  const mechShare = ratio(
    sum(withDims, (c) => c.dimensions!.automation.mechanical_lines),
    sum(withDims, (c) => c.dimensions!.importance.lines),
  );
  const onMechanical = m(
    mechShare === null || onAccepted.value === null ? 0 : onAccepted.value * mechShare,
    worst(onAccepted.provenance, 'estimated'),
    onAccepted.source,
    'tokens_on_accepted × mechanical_share',
  );

  return {
    breakdown: {
      total,
      reported_by_requests: reported,
      unreconciled,
      on_accepted: onAccepted,
      on_rejected: onRejected,
      on_redundant_regenerations: onRedundant,
      on_mechanical: onMechanical,
      cost_usd: costUsd(input, total),
    },
    perRequest,
    redundant,
  };
}

/** GET /productivity/summary */
export function computeSummary(input: MetricsInput): ProductivitySummary {
  const { breakdown, perRequest, redundant } = computeTokens(input);
  const stages = stageLines(input);
  const funnel = buildFunnel(stages, breakdown.total);
  const dimensions = dimensionsSummary(input, redundant.length);

  const accepted = input.changes.filter(isAccepted);
  const byModel = new Map<string, AiRequestItem[]>();
  for (const r of input.requests) {
    const k = r.model || 'unknown';
    byModel.set(k, [...(byModel.get(k) ?? []), r]);
  }
  const by_model = [...byModel.entries()].map(([model, reqs]) => {
    const ids = new Set(reqs.map((r) => r.ai_request_id));
    return {
      model,
      requests: reqs.length,
      tokens: sumRequests(reqs, perRequest, breakdown.total),
      accepted_lines: sum(
        accepted.filter((c) => c.ai_request_id && ids.has(c.ai_request_id)),
        (c) => c.accepted_added_lines,
      ),
    };
  });

  const depSuccess = new Set(
    input.deployments
      .filter((d) => d.state === 'success' && input.commits.some((c) => c.repository === d.repository && shaEq(c.sha, d.sha)))
      .map((d) => d.deployment_id ?? `${d.repository}@${d.sha}`),
  );

  const partial = { tokens: breakdown, funnel, dimensions, by_model };
  const provs: Provenance[] = [];
  collectProvenance(partial, provs);

  return {
    scope: input.scope,
    attribution: attributionOf(input),
    overall_provenance: worst(...provs),
    tokens: breakdown,
    funnel,
    dimensions,
    counts: {
      sessions: input.sessions.length,
      ai_requests: input.requests.length,
      changes_proposed: input.changes.length,
      changes_accepted: accepted.length,
      changes_rejected: input.changes.filter((c) => c.status === 'rejected').length,
      commits: input.commits.length,
      references: input.references.length,
      pull_requests: input.external?.pull_requests ?? 0,
      pull_requests_merged: input.external?.pull_requests_merged ?? 0,
      deployments_success: depSuccess.size,
      tasks: input.external?.tasks ?? 0,
      tasks_done: input.external?.tasks_done ?? 0,
    },
    by_model,
    warnings: [],
    generated_at: input.now,
  };
}

/** GET /productivity/timeline — buckets de hora/día rellenados con 0. */
export function computeTimeline(input: MetricsInput, bucket: 'hour' | 'day'): TimelinePoint[] {
  const size = bucket === 'hour' ? 3_600_000 : 86_400_000;
  const floor = (iso: string) => Math.floor(Date.parse(iso) / size) * size;
  const start = floor(input.scope.from);
  const end = floor(input.scope.to);
  const points = new Map<number, TimelinePoint>();
  const { breakdown, perRequest } = computeTokens(input);
  const prov = breakdown.total.provenance;
  for (let t = start; t <= end; t += size) {
    points.set(t, {
      bucket_start: new Date(t).toISOString(),
      tokens: 0,
      tokens_provenance: prov,
      accepted_lines: 0,
      effective_lines: 0,
      committed_lines: 0,
    });
  }
  const at = (iso: string | undefined) => (iso ? points.get(floor(iso)) : undefined);

  const useUsage = !input.scoped && input.usage && input.usage.records.length > 0;
  if (useUsage) {
    for (const r of input.usage!.records) {
      const p = at(r.window_start);
      if (p) p.tokens += r.usage.total_tokens;
    }
  } else {
    for (const r of input.requests) {
      const p = at(r.occurred_at);
      if (p) p.tokens += perRequest.get(r.ai_request_id)?.tokens ?? 0;
    }
  }
  for (const c of input.changes.filter(isAccepted)) {
    const p = at(c.accepted_at ?? c.first_seen_at);
    if (!p) continue;
    p.accepted_lines += c.accepted_added_lines ?? 0;
    p.effective_lines = round(p.effective_lines + (c.dimensions?.effective_lines ?? 0));
  }
  for (const c of input.commits) {
    const p = at(c.committed_at);
    if (p) p.committed_lines += c.automation.ai_matched_lines;
  }
  return [...points.values()];
}

const STAGE_ORDER: FunnelStage[] = ['generated', 'accepted', 'committed', 'in_reference', 'deployed'];

/** Etapa más alta alcanzada por algún cambio de la sesión. */
export function highestStage(changes: ChangeItem[], deployedShas: Set<string> = new Set()): FunnelStage {
  let best = 0;
  for (const c of changes) {
    let s = 0;
    if (c.deployed_at || (c.commit_sha && [...deployedShas].some((d) => shaEq(d, c.commit_sha!)))) s = 4;
    else if (c.status === 'in_reference') s = 3;
    else if (c.status === 'committed') s = 2;
    else if (c.status === 'accepted') s = 1;
    best = Math.max(best, s);
  }
  return STAGE_ORDER[best]!;
}

/** GET /productivity/sessions */
export function computeSessionItems(input: MetricsInput): SessionListItem[] {
  const { breakdown, perRequest } = computeTokens(input);
  const deployedShas = new Set(deployedCommits(input.commits, input.deployments).map((c) => c.sha));
  return input.sessions
    .map((s) => {
      const reqs = input.requests.filter((r) => r.session_id === s.session_id);
      const changes = input.changes.filter((c) => c.session_id === s.session_id);
      const accepted = changes.filter(isAccepted);
      return {
        session_id: s.session_id,
        project_id: s.project_id,
        repository: s.repository,
        branch: s.branch ?? null,
        task_key: s.task_key ?? null,
        started_at: s.started_at,
        ended_at: s.ended_at ?? null,
        ai_requests: reqs.length,
        tokens: sumRequests(reqs, perRequest, breakdown.total),
        accepted_lines: sum(accepted, (c) => c.accepted_added_lines),
        effective_lines: round(sum(accepted, (c) => c.dimensions?.effective_lines)),
        commits: input.commits.filter((c) => c.session_id === s.session_id).map((c) => c.sha),
        highest_stage: highestStage(changes, deployedShas),
      };
    })
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
}

/** GET /productivity/changes — tokens de la petición repartidos entre sus cambios. */
export function computeChangeItems(input: MetricsInput): ChangeListItem[] {
  const { breakdown, perRequest } = computeTokens(input);
  const perReqCount = new Map<string, number>();
  for (const c of input.changes) if (c.ai_request_id) perReqCount.set(c.ai_request_id, (perReqCount.get(c.ai_request_id) ?? 0) + 1);
  return input.changes
    .map((c) => {
      const rt = c.ai_request_id ? perRequest.get(c.ai_request_id) : undefined;
      const n = c.ai_request_id ? perReqCount.get(c.ai_request_id) ?? 1 : 1;
      const files = (c.accepted_files ?? c.proposed_files ?? []).map((f) => ({ path: f.path, added: f.added, deleted: f.deleted }));
      return {
        change_id: c.change_id,
        session_id: c.session_id,
        ai_request_id: c.ai_request_id ?? '',
        status: c.status,
        files,
        accepted_added_lines: c.accepted_added_lines ?? 0,
        importance_score: c.dimensions?.importance.score ?? 0,
        redundancy_score: c.dimensions?.redundancy.score ?? 0,
        mechanical_share: c.dimensions?.automation.mechanical_share ?? 0,
        effective_lines: c.dimensions?.effective_lines ?? 0,
        commit_sha: c.commit_sha ?? null,
        tokens: rt
          ? m(rt.tokens / n, rt.provenance, rt.source, n > 1 ? `Tokens de la petición repartidos entre ${n} cambios.` : undefined)
          : m(null, breakdown.total.provenance, breakdown.total.source, 'Petición no encontrada en la ventana.'),
        scores: c.scores ?? null,
        branch: c.branch ?? null,
        task_key: c.task_key ?? null,
        occurred_at: c.first_seen_at,
      };
    })
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
}
