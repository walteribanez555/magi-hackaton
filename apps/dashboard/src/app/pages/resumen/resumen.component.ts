import { HttpContext } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import type { ChangeListItem, Criticality, FunnelStep, ProductivitySummary, TaskListItem } from '@magicode/contracts';
import { catchError, of } from 'rxjs';

import { SILENT_ERRORS } from '@/core/http/http-context';
import { ProductivityService } from '@/core/data/productivity.service';
import { ScopeService } from '@/core/data/scope.service';
import { TasksService } from '@/core/data/tasks.service';
import { STAGE_ORDER } from '@/core/data/types';
import {
  FORMAT_PIPES,
  CriticalityComponent,
  HelpLinkComponent,
  LineChartComponent,
  LoadingComponent,
  MetricComponent,
  SectionComponent,
  StateComponent,
  type ChartSeries,
  type ScopeOption,
  ScopeMenuComponent,
} from '@/shared/components/ui';
import {
  CRITICALITY_LABEL,
  LINE_KIND_LABEL,
  PR_STATE_LABEL,
  STAGE_EVIDENCE,
  STAGE_LABEL,
  TASK_CATEGORY_LABEL,
} from '@/shared/labels/labels';
import { formatDay, formatDateTime, formatNumber, formatPercent } from '@/shared/utils/format';
import { valueOf } from '@/shared/utils/resource';

const silent = () => new HttpContext().set(SILENT_ERRORS, true);

interface TokenSegment {
  id: string;
  label: string;
  value: number;
  color: string;
  hatched?: boolean;
}

const CRIT_RANK: Record<Criticality, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** /resumen — del token al código que sobrevive (Main del diseño). */
@Component({
  selector: 'app-resumen',
  imports: [
    RouterLink,
    ...FORMAT_PIPES,
    MetricComponent,
    HelpLinkComponent,
    SectionComponent,
    LoadingComponent,
    StateComponent,
    CriticalityComponent,
    LineChartComponent,
    ScopeMenuComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './resumen.component.html',
})
export class ResumenComponent {
  protected readonly scope = inject(ScopeService);
  private readonly productivity = inject(ProductivityService);
  private readonly tasksApi = inject(TasksService);

  protected readonly summary = rxResource({
    params: () => this.scope.query(),
    stream: ({ params }) => this.productivity.summary(params!),
  });

  protected readonly timeline = rxResource({
    params: () => {
      const q = this.scope.query();
      return q ? { ...q, bucket: this.scope.range().days <= 2 ? ('hour' as const) : ('day' as const) } : undefined;
    },
    stream: ({ params }) => this.productivity.timeline(params).pipe(catchError(() => of([]))),
  });

  protected readonly tasks = rxResource({
    params: () => this.scope.projectId() ?? undefined,
    stream: ({ params }) => this.tasksApi.tasks({ project_id: params }).pipe(catchError(() => of([] as TaskListItem[]))),
  });

  protected readonly branches = rxResource({
    params: () => this.scope.projectId() ?? undefined,
    stream: ({ params }) => this.tasksApi.branches({ project_id: params }).pipe(catchError(() => of([]))),
  });

  /** Cambios del proyecto: solo para derivar la criticidad por tarea (peor cambio puntuado). */
  protected readonly changes = rxResource({
    params: () => {
      const q = this.scope.query();
      return q ? { project_id: q.project_id, from: q.from, to: q.to } : undefined;
    },
    stream: ({ params }) =>
      this.productivity.changes(params, silent()).pipe(catchError(() => of([] as ChangeListItem[]))),
  });

  // ── Selectores de tarea y rama ─────────────────────────────────────
  protected readonly taskOptions = computed<ScopeOption[]>(() => [
    { id: '', label: 'Todas' },
    ...(valueOf(this.tasks) ?? []).map((t) => ({ id: t.task_key, label: `${t.task_key} · ${t.title}` })),
  ]);
  protected readonly branchOptions = computed<ScopeOption[]>(() => [
    { id: '', label: 'Todas' },
    ...(valueOf(this.branches) ?? []).map((b) => ({ id: b.branch, label: b.branch, hint: b.repository })),
  ]);
  protected selectTask(id: string): void {
    this.scope.taskKey.set(id || null);
  }
  protected selectBranch(id: string): void {
    this.scope.branch.set(id || null);
  }

  // ── Derivados del resumen ──────────────────────────────────────────
  protected readonly funnel = computed(() => {
    const s = valueOf(this.summary);
    if (!s) return [];
    const byStage = new Map(s.funnel.map((f) => [f.stage, f]));
    const steps = STAGE_ORDER.map((st) => byStage.get(st)).filter((f): f is FunnelStep => !!f);
    const base = Math.max(1, steps[0]?.lines.value ?? 1);
    return steps.map((f) => ({
      step: f,
      label: STAGE_LABEL[f.stage],
      evidence:
        f.stage === 'deployed' && !(f.lines.value ?? 0) ? 'sin deployment success en production' : STAGE_EVIDENCE[f.stage],
      bar: Math.min(100, ((f.lines.value ?? 0) / base) * 100),
      effBar: Math.min(100, ((f.effective_lines.value ?? 0) / base) * 100),
    }));
  });

  private stage(s: ProductivitySummary, st: FunnelStep['stage']): FunnelStep | undefined {
    return s.funnel.find((f) => f.stage === st);
  }

  protected readonly lead = computed(() => {
    const s = valueOf(this.summary);
    if (!s) return null;
    const ref = this.stage(s, 'in_reference');
    const dep = this.stage(s, 'deployed');
    const committed = this.stage(s, 'committed');
    const target = ref?.lines.value ? ref : committed;
    return {
      tokens: s.tokens.total,
      lines: target?.lines ?? null,
      targetLabel: target === ref ? 'llegaron a la versión de referencia' : 'llegaron a Git',
      per100: target?.tokens_per_100_effective_lines ?? null,
      per100Label: target === ref ? 'en la versión de referencia' : 'registradas en Git',
      deployedLines: dep?.lines.value ?? 0,
      deployed: dep ?? null,
    };
  });

  protected readonly attributionText = computed(() => {
    const s = valueOf(this.summary);
    if (!s) return '';
    const attr =
      s.attribution === 'exact'
        ? 'Atribución exacta: request_id compartido entre el IDE y MagiHub.'
        : 'Atribución estimada: API key dedicada + ventana horaria.';
    const prov =
      s.overall_provenance === 'simulated'
        ? ' Datos simulados (mock de MagiHub o seed de demo).'
        : s.overall_provenance === 'estimated'
          ? ' Algunas cifras son estimadas.'
          : '';
    return attr + prov;
  });

  /**
   * Segmentos de la barra de tokens. on_mechanical es parte de on_accepted; las regeneraciones
   * redundantes pueden solaparse con aceptados/rechazados según el backend, así que se recortan
   * para que la suma nunca supere el total.
   */
  protected readonly tokenSegments = computed<TokenSegment[]>(() => {
    const s = valueOf(this.summary);
    if (!s) return [];
    const t = s.tokens;
    const total = Math.max(0, t.total.value ?? 0);
    const unrec = Math.min(total, Math.abs(t.unreconciled.value ?? 0));
    let room = total - unrec;
    const take = (v: number) => {
      const x = Math.max(0, Math.min(room, v));
      room -= x;
      return x;
    };
    const accepted = t.on_accepted.value ?? 0;
    const mech = Math.min(accepted, t.on_mechanical.value ?? 0);
    const useful = take(accepted - mech);
    const mechanical = take(mech);
    const redundant = take(t.on_redundant_regenerations.value ?? 0);
    // Si las regeneraciones redundantes ya están dentro de los rechazados, se descuentan de ellos.
    const rejected = take(t.on_rejected.value ?? 0);
    const rest = room;
    const segs: TokenSegment[] = [
      { id: 'useful', label: 'Código aceptado útil', value: useful, color: 'var(--ink)' },
      { id: 'mechanical', label: 'Código mecánico (imports, llaves)', value: mechanical, color: 'var(--seg-mechanical)' },
      { id: 'rejected', label: 'Exploración rechazada', value: rejected, color: 'var(--seg-rejected)' },
      { id: 'redundant', label: 'Regeneraciones redundantes', value: redundant, color: 'var(--estimated)' },
      { id: 'unreconciled', label: `Sin conciliar (${formatPercent(total ? unrec / total : null)})`, value: unrec, color: 'var(--seg-unreconciled)', hatched: true },
    ];
    if (rest > 0.5) segs.push({ id: 'rest', label: 'Sin clasificar', value: rest, color: 'var(--track)' });
    return segs;
  });

  protected readonly tokenAria = computed(() => {
    const s = valueOf(this.summary);
    if (!s) return '';
    return (
      `Distribución de ${formatNumber(s.tokens.total.value)} tokens: ` +
      this.tokenSegments()
        .map((x) => `${formatNumber(x.value)} en ${x.label.toLowerCase()}`)
        .join(', ')
    );
  });

  protected readonly kinds = computed(() => {
    const s = valueOf(this.summary);
    if (!s) return [];
    const entries = Object.entries(s.dimensions.importance.by_kind ?? {}).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...entries.map(([, n]) => n));
    return entries.map(([k, n]) => ({ name: LINE_KIND_LABEL[k] ?? k, n, bar: (n / max) * 100 }));
  });

  protected readonly acceptedLines = computed(() => {
    const s = valueOf(this.summary);
    return s ? (this.stage(s, 'accepted')?.lines.value ?? 0) : 0;
  });

  protected readonly nonTrivial = computed(() => {
    const s = valueOf(this.summary);
    if (!s) return 0;
    const byKind = s.dimensions.importance.by_kind ?? {};
    const total = Object.values(byKind).reduce((a, b) => a + b, 0);
    return total - (byKind['trivial'] ?? 0);
  });

  protected readonly redundantLines = computed(() => {
    const r = valueOf(this.summary)?.dimensions.redundancy;
    return r ? r.intra_change + r.existing_in_repo + r.repeated_in_session : 0;
  });

  // ── Por tarea ──────────────────────────────────────────────────────
  protected readonly taskRows = computed(() => {
    const tasks = valueOf(this.tasks) ?? [];
    const changes = valueOf(this.changes) ?? [];
    const worst = new Map<string, { level: Criticality; score: number }>();
    for (const c of changes) {
      if (!c.task_key || !c.scores) continue;
      const cur = worst.get(c.task_key);
      if (!cur || c.scores.criticality_score > cur.score) {
        worst.set(c.task_key, { level: c.scores.criticality, score: c.scores.criticality_score });
      }
    }
    const rows = tasks.map((t) => ({
      key: t.task_key,
      title: t.title,
      link: true,
      status: TASK_CATEGORY_LABEL[t.status_category] ?? t.status,
      branch: t.branches[0] ?? '—',
      moreBranches: Math.max(0, t.branches.length - 1),
      pr: t.pull_requests.length
        ? t.pull_requests.map((p) => `#${p.number} ${PR_STATE_LABEL[p.state] ?? p.state}`).join(', ')
        : '—',
      tokens: t.tokens,
      eff: t.effective_lines,
      crit: worst.get(t.task_key) ?? null,
      deploy: t.deployed ? 'desplegada' : '—',
    }));
    // Tokens sin tarea: total del ámbito − Σ tareas (si es positivo).
    const total = valueOf(this.summary)?.tokens.total.value ?? null;
    const sum = tasks.reduce((a, t) => a + (t.tokens.value ?? 0), 0);
    if (total !== null && total - sum > 0.5 && tasks.length) {
      rows.push({
        key: 'Sin tarea',
        title: 'Sesiones sin clave de tarea',
        link: false,
        status: '—',
        branch: '—',
        moreBranches: 0,
        pr: '—',
        tokens: { value: total - sum, provenance: 'estimated' },
        eff: 0,
        crit: null,
        deploy: '—',
      });
    }
    return rows;
  });

  protected readonly taskHint = computed(() => {
    const s = valueOf(this.summary);
    if (!s) return '';
    return `${formatNumber(s.counts.tasks)} tareas · ${formatNumber(s.counts.pull_requests)} pull requests (${formatNumber(s.counts.pull_requests_merged)} fusionados)`;
  });

  protected critRank(level: Criticality): number {
    return CRIT_RANK[level];
  }
  protected readonly critLabel = CRITICALITY_LABEL;

  // ── Línea de tiempo ────────────────────────────────────────────────
  protected readonly chart = computed(() => {
    const pts = valueOf(this.timeline) ?? [];
    const hourly = this.scope.range().days <= 2;
    const labels = pts.map((p) => (hourly ? formatDateTime(p.bucket_start).split(' ').pop()! : formatDay(p.bucket_start)));
    const tokens: ChartSeries[] = [{ id: 'tokens', label: 'Tokens', color: 'var(--ink)', values: pts.map((p) => p.tokens) }];
    const lines: ChartSeries[] = [
      { id: 'accepted', label: 'Aceptadas', color: 'var(--ink)', values: pts.map((p) => p.accepted_lines) },
      { id: 'effective', label: 'Efectivas', color: 'var(--accent)', values: pts.map((p) => p.effective_lines) },
      { id: 'committed', label: 'En Git', color: 'var(--faint)', values: pts.map((p) => p.committed_lines), dashed: true },
    ];
    const sumTok = pts.reduce((a, p) => a + p.tokens, 0);
    const peak = pts.reduce((m, p, i) => (p.tokens > (pts[m]?.tokens ?? -1) ? i : m), 0);
    const sumAcc = pts.reduce((a, p) => a + p.accepted_lines, 0);
    const sumEff = pts.reduce((a, p) => a + p.effective_lines, 0);
    return {
      labels,
      tokens,
      lines,
      tokensAria: pts.length
        ? `Tokens por ${hourly ? 'hora' : 'día'}: ${formatNumber(sumTok)} en ${pts.length} intervalos; pico de ${formatNumber(pts[peak]?.tokens)} el ${labels[peak]}.`
        : 'Sin datos',
      linesAria: pts.length
        ? `Líneas por ${hourly ? 'hora' : 'día'}: ${formatNumber(sumAcc)} aceptadas y ${formatNumber(sumEff, 1)} efectivas en total.`
        : 'Sin datos',
      empty: pts.length === 0,
    };
  });
}
