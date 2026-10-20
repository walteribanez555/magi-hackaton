import { HttpContext } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { rxResource, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type {
  ChangeListItem,
  Provenance,
  SessionListItem,
  TaskCommitView,
  TaskDetail,
  TaskSessionView,
} from '@magicode/contracts';
import { catchError, map, of } from 'rxjs';

import { ApiClient } from '@/core/http/api-client';
import { SILENT_ERRORS } from '@/core/http/http-context';
import { AgoPipe, DateTimePipe, NumPipe } from '@/shared/components/ui/format.pipes';
import { ProvenanceComponent } from '@/shared/components/ui/provenance.component';
import { SectionComponent } from '@/shared/components/ui/section.component';
import { LoadingComponent, StateComponent } from '@/shared/components/ui/states.component';
import { CriticalityComponent, StatusMarkComponent } from '@/shared/components/ui/status-mark.component';
import { PR_STATE_LABEL, STAGE_SHORT } from '@/shared/labels/labels';
import {
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
  formatScore,
  formatSigned,
  shortSha,
} from '@/shared/utils/format';
import { JiraActionsComponent } from './jira-actions.component';
import { TD, TH, taskStatusLabel, taskTone } from './tareas.shared';

interface SessionRow {
  id: string;
  start: string | null;
  requests: number | null;
  tokens: number | null;
  prov: Provenance | null;
  accepted: number | null;
  effective: number | null;
  stage: string;
}

interface TraceRow {
  kind: string;
  id: string;
  href?: string | null;
  detail: string;
  link: string;
  indent: 0 | 1 | 2;
  fill: 'ink' | 'bg' | 'rule';
}

@Component({
  selector: 'app-task-detail-page',
  imports: [
    RouterLink,
    NumPipe,
    DateTimePipe,
    AgoPipe,
    ProvenanceComponent,
    SectionComponent,
    LoadingComponent,
    StateComponent,
    StatusMarkComponent,
    CriticalityComponent,
    JiraActionsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav aria-label="Ruta" class="text-sm text-muted">
      <a routerLink="/tareas" class="text-muted no-underline hover:text-accent">Tareas</a> /
      <span class="font-mono text-[13px] text-ink">{{ taskKey() }}</span>
    </nav>

    @if (task.error()) {
      <h1 class="m-0 mt-4 font-mono text-2xl font-medium">{{ taskKey() }}</h1>
      <app-state kind="error" message="No se pudo cargar la tarea." (retry)="task.reload()" />
    } @else if (!task.hasValue()) {
      <app-loading [rows]="6" label="Cargando tarea…" />
    } @else {
      @let t = task.value()!;
      <div class="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        @if (t.url) {
          <a [href]="t.url" target="_blank" rel="noopener" class="font-mono text-[15px] no-underline">{{ t.task_key }}</a>
        } @else {
          <span class="font-mono text-[15px] text-accent">{{ t.task_key }}</span>
        }
        <span class="text-[13px] text-muted">{{ t.url ? 'Jira' : 'Sin datos del gestor' }} · actualizada {{ t.updated_at | ago }}</span>
      </div>
      <h1 class="m-0 mt-1.5 text-[34px] leading-tight font-semibold tracking-[-0.02em]">
        {{ t.title && t.title !== t.task_key ? t.title : 'Tarea ' + t.task_key }}
      </h1>

      <dl class="m-0 mt-6 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-8 gap-y-4 border-t border-rule pt-[18px]">
        <div>
          <dt class="text-xs text-muted">Estado</dt>
          <dd class="m-0 mt-0.5"><app-status [tone]="tone(t)" [label]="statusLabel(t)" /></dd>
        </div>
        <div>
          <dt class="text-xs text-muted">Responsable</dt>
          <dd class="m-0 mt-0.5">{{ t.assignee ?? '—' }}</dd>
        </div>
        <div>
          <dt class="text-xs text-muted">Story points</dt>
          <dd class="m-0 mt-0.5 font-mono">{{ t.story_points | num: 0 }}</dd>
        </div>
        <div>
          <dt class="text-xs text-muted">Tokens</dt>
          <dd class="m-0 mt-0.5 font-mono">
            {{ t.tokens.value | num }}<app-prov [p]="t.tokens.value === null ? null : t.tokens.provenance" />
          </dd>
        </div>
        <div>
          <dt class="text-xs text-muted">Líneas efectivas</dt>
          <dd class="m-0 mt-0.5 font-mono">{{ t.effective_lines | num: 1 }}</dd>
        </div>
        <div>
          <dt class="text-xs text-muted">Tokens / 100 efectivas</dt>
          <dd class="m-0 mt-0.5 font-mono">{{ tokensPer100() | num }}</dd>
        </div>
        <div>
          <dt class="text-xs text-muted">Criticidad</dt>
          <dd class="m-0 mt-0.5"><app-crit [level]="t.criticality" /></dd>
        </div>
        <div>
          <dt class="text-xs text-muted">Desplegado</dt>
          <dd class="m-0 mt-0.5">{{ t.deployed ? 'Sí' : 'No' }}</dd>
        </div>
      </dl>

      <app-section title="Trazabilidad" headingId="h-trace">
        <span hint>Cómo se enlazó cada elemento con la tarea</span>
        <ol class="m-0 list-none p-0">
          @for (r of trace(); track $index) {
            <li
              class="grid grid-cols-[88px_20px_minmax(0,1fr)] items-start gap-x-3 border-t border-rule py-3.5 first:border-t-0 sm:grid-cols-[120px_28px_minmax(0,1fr)_minmax(0,220px)] sm:gap-x-4"
            >
              <span class="pt-0.5 text-xs text-muted">{{ r.kind }}</span>
              <span aria-hidden="true" class="flex justify-center" [class]="indentClass[r.indent]">
                <span class="mt-1.5 size-[9px] border-[1.5px] border-ink" [class]="fillClass[r.fill]"></span>
              </span>
              <div class="min-w-0" [class]="indentClass[r.indent]">
                <div class="font-mono text-sm [overflow-wrap:anywhere]">
                  @if (r.href) {
                    <a [href]="r.href" target="_blank" rel="noopener" class="no-underline">{{ r.id }}</a>
                  } @else {
                    {{ r.id }}
                  }
                </div>
                <div class="text-sm text-ink-2">{{ r.detail }}</div>
              </div>
              <span class="col-start-3 text-[13px] text-muted sm:col-start-auto sm:text-right">{{ r.link }}</span>
            </li>
          }
        </ol>
      </app-section>

      <app-section title="Sesiones de MagiCode" headingId="h-sessions">
        <span hint>{{ sessionsHint() }}</span>
        @if (sessionRows().length === 0) {
          <p class="m-0 py-5 text-[15px] text-ink-2">Sin sesiones de MagiCode enlazadas.</p>
        } @else {
          <div class="overflow-x-auto">
            <table class="w-full min-w-[820px] border-collapse text-sm">
              <thead>
                <tr>
                  <th scope="col" [class]="th">Sesión</th>
                  <th scope="col" [class]="th">Inicio</th>
                  <th scope="col" [class]="th + ' text-right'">Peticiones</th>
                  <th scope="col" [class]="th + ' text-right'">Tokens</th>
                  <th scope="col" [class]="th + ' text-right'">Aceptadas</th>
                  <th scope="col" [class]="th + ' text-right'">Efectivas</th>
                  <th scope="col" [class]="th">Llegó a</th>
                </tr>
              </thead>
              <tbody class="font-mono">
                @for (r of sessionRows(); track r.id) {
                  <tr class="border-t border-rule">
                    <td [class]="td + ' [overflow-wrap:anywhere]'">{{ r.id }}</td>
                    <td [class]="td + ' whitespace-nowrap text-ink-2'">{{ r.start | datetime }}</td>
                    <td [class]="td + ' text-right'">{{ r.requests | num }}</td>
                    <td [class]="td + ' text-right whitespace-nowrap'">{{ r.tokens | num }}<app-prov [p]="r.tokens === null ? null : r.prov" /></td>
                    <td [class]="td + ' text-right'">{{ r.accepted | num }}</td>
                    <td [class]="td + ' text-right'">{{ r.effective | num: 1 }}</td>
                    <td [class]="td + ' font-sans text-ink-2'">{{ r.stage }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </app-section>

      <app-jira-actions [taskKey]="t.task_key" />

      <p class="mt-10 mb-0 max-w-[820px] text-[13px] text-muted">
        Los tokens de una tarea se atribuyen por enlace: sesiones cuya rama o task_key coincide con {{ t.task_key }}. Por
        eso se marcan como estimados aunque el total del proyecto sea real.
      </p>
    }
  `,
})
export class TaskDetailPage {
  private readonly api = inject(ApiClient);
  private readonly route = inject(ActivatedRoute);

  protected readonly th = TH;
  protected readonly td = TD;
  protected readonly taskKey = toSignal(this.route.paramMap.pipe(map((p) => p.get('taskKey') ?? '')), {
    initialValue: '',
  });

  protected readonly task = rxResource({
    params: () => this.taskKey() || undefined,
    stream: ({ params }) => this.api.get<TaskDetail>('task', { params: { taskKey: params } }),
  });

  protected readonly tokensPer100 = computed(() => {
    const t = this.task.hasValue() ? this.task.value() : null;
    const tokens = t?.tokens.value;
    if (!t || tokens === null || tokens === undefined || !t.effective_lines) return null;
    return Math.round((tokens / t.effective_lines) * 100);
  });

  /** Sesiones con tokens/peticiones (GET /productivity/sessions?task_key); si falla, las de linked. */
  private readonly sessionList = rxResource({
    params: () => {
      const t = this.task.hasValue() ? this.task.value() : null;
      return t ? { project_id: t.project_id, task_key: t.task_key } : undefined;
    },
    stream: ({ params }) =>
      this.api
        .get<SessionListItem[]>('sessions', { query: params, context: new HttpContext().set(SILENT_ERRORS, true) })
        .pipe(catchError(() => of(null))),
  });

  /** Cambios de la tarea para la trazabilidad (opcional: sin ellos, la lista sigue). */
  private readonly changes = rxResource({
    params: () => {
      const t = this.task.hasValue() ? this.task.value() : null;
      return t ? { project_id: t.project_id, task_key: t.task_key } : undefined;
    },
    stream: ({ params }) =>
      this.api
        .get<ChangeListItem[]>('changes', { query: params, context: new HttpContext().set(SILENT_ERRORS, true) })
        .pipe(catchError(() => of([] as ChangeListItem[]))),
  });

  protected readonly sessionRows = computed<SessionRow[]>(() => {
    const t = this.task.hasValue() ? this.task.value() : null;
    if (!t) return [];
    const rich = this.sessionList.hasValue() ? this.sessionList.value() : null;
    if (rich && rich.length) {
      return rich.map((s) => ({
        id: s.session_id,
        start: s.started_at,
        requests: s.ai_requests,
        tokens: s.tokens.value,
        prov: s.tokens.provenance,
        accepted: s.accepted_lines,
        effective: s.effective_lines,
        stage: STAGE_SHORT[s.highest_stage] ?? s.highest_stage,
      }));
    }
    return (t.linked?.sessions ?? []).map((s) => ({
      id: s.session_id,
      start: s.started_at,
      requests: null,
      tokens: null,
      prov: null,
      accepted: null,
      effective: null,
      stage: '—',
    }));
  });

  protected readonly sessionsHint = computed(() => {
    const rows = this.sessionRows();
    const n = rows.length;
    const req = rows.reduce((acc, r) => acc + (r.requests ?? 0), 0);
    const base = `${formatNumber(n)} ${n === 1 ? 'sesión' : 'sesiones'}`;
    return req ? `${base} · ${formatNumber(req)} ${req === 1 ? 'petición' : 'peticiones'} a Smart Auto` : base;
  });

  protected readonly indentClass: Record<0 | 1 | 2, string> = { 0: 'pl-0', 1: 'pl-5', 2: 'pl-10' };
  protected readonly fillClass: Record<TraceRow['fill'], string> = { ink: 'bg-ink', bg: 'bg-bg', rule: 'bg-rule' };

  /** Tarea → Rama → Sesión → Cambio/Commit; luego PRs y despliegues. */
  protected readonly trace = computed<TraceRow[]>(() => {
    const t = this.task.hasValue() ? this.task.value() : null;
    if (!t) return [];
    const linked = t.linked ?? { sessions: [], commits: [], branches: [], pull_requests: [], deployments: [] };
    const rich = new Map((this.sessionList.hasValue() ? (this.sessionList.value() ?? []) : []).map((s) => [s.session_id, s]));
    const changes = this.changes.hasValue() ? this.changes.value() : [];
    const rows: TraceRow[] = [];
    const usedSessions = new Set<string>();
    const usedCommits = new Set<string>();
    const key = t.task_key.toLowerCase();

    rows.push({
      kind: t.url ? 'Tarea · Jira' : 'Tarea',
      id: t.task_key,
      href: t.url,
      detail: `estado ${taskStatusLabel(t)}`,
      link: t.url ? 'issue del gestor' : 'clave en ramas y commits',
      indent: 0,
      fill: 'ink',
    });

    const pushCommit = (c: TaskCommitView, indent: 0 | 1 | 2) => {
      usedCommits.add(c.sha);
      rows.push({
        kind: 'Commit',
        id: shortSha(c.sha),
        detail: commitDetail(c),
        link: commitLink(c),
        indent,
        fill: 'bg',
      });
    };

    const pushSession = (s: TaskSessionView, indent: 0 | 1) => {
      usedSessions.add(s.session_id);
      const r = rich.get(s.session_id);
      rows.push({
        kind: 'Sesión',
        id: s.session_id,
        detail: r
          ? `${formatNumber(r.ai_requests)} peticiones · ${formatNumber(r.tokens.value)} tokens`
          : `inicio ${formatDateTime(s.started_at)} · ${formatDuration(s.started_at, s.ended_at)}`,
        link: s.branch ? 'branch del evento' : 'task_key del evento',
        indent,
        fill: 'bg',
      });
      const child = (indent + 1) as 1 | 2;
      for (const ch of changes.filter((x) => x.session_id === s.session_id)) {
        const f = ch.files[0];
        const added = ch.files.reduce((n, x) => n + x.added, 0);
        const deleted = ch.files.reduce((n, x) => n + x.deleted, 0);
        rows.push({
          kind: 'Cambio',
          id: f ? `${ch.change_id} · ${f.path}${ch.files.length > 1 ? ` +${ch.files.length - 1}` : ''}` : ch.change_id,
          detail: `${formatSigned(added, '+')} ${formatSigned(deleted, '-')} · importancia ${formatScore(ch.importance_score)} · redundancia ${formatScore(ch.redundancy_score)}`,
          link: `ai_request_id ${ch.ai_request_id}`,
          indent: child,
          fill: 'bg',
        });
      }
      for (const c of linked.commits.filter((x) => x.session_id === s.session_id && !usedCommits.has(x.sha))) {
        pushCommit(c, child);
      }
    };

    for (const b of linked.branches) {
      rows.push({
        kind: 'Rama',
        id: b.branch,
        detail: `${b.repository} · ${formatNumber(b.commits)} commits${b.merged_into ? ` · fusionada en ${b.merged_into}` : ''}`,
        link: b.branch.toLowerCase().includes(key) ? 'clave en el nombre' : 'commits con la clave',
        indent: 0,
        fill: 'bg',
      });
      for (const s of linked.sessions.filter((x) => x.branch === b.branch && !usedSessions.has(x.session_id))) {
        pushSession(s, 1);
      }
      for (const c of linked.commits.filter((x) => x.branch === b.branch && !usedCommits.has(x.sha))) {
        pushCommit(c, 1);
      }
    }
    for (const s of linked.sessions.filter((x) => !usedSessions.has(x.session_id))) pushSession(s, 0);
    for (const c of linked.commits.filter((x) => !usedCommits.has(x.sha))) pushCommit(c, 0);

    for (const pr of linked.pull_requests) {
      rows.push({
        kind: 'Pull request',
        id: `#${pr.number} · ${pr.source_branch} → ${pr.target_branch}`,
        href: pr.url,
        detail: `${PR_STATE_LABEL[pr.state] ?? pr.state} · ${formatNumber(pr.ai.commits_with_ai)} commits con líneas IA`,
        link: pr.source_branch.toLowerCase().includes(key) ? 'rama de origen' : 'clave en el título',
        indent: 0,
        fill: 'bg',
      });
    }

    if (linked.deployments.length === 0) {
      rows.push({
        kind: 'Despliegue',
        id: 'sin evidencia',
        detail: 'ningún deployment success para estos SHA',
        link: '—',
        indent: 0,
        fill: 'rule',
      });
    }
    for (const d of linked.deployments) {
      rows.push({
        kind: 'Despliegue',
        id: `${d.environment ?? '—'} · ${shortSha(d.sha)}`,
        href: d.url,
        detail: `${d.state ?? '—'}${d.deployed ? ' · desplegado' : ''}`,
        link: 'SHA del commit o del PR',
        indent: 0,
        fill: d.deployed ? 'ink' : 'bg',
      });
    }
    return rows;
  });

  protected readonly tone = taskTone;
  protected readonly statusLabel = taskStatusLabel;
}

function commitDetail(c: TaskCommitView): string {
  if (c.ai_share === null || c.ai_matched_lines === null) return `${c.repository} · solo remoto, sin cruce de hashes`;
  return `${formatPercent(c.ai_share, 0)} del commit vino de la IA · ${formatNumber(c.ai_matched_lines)} de ${formatNumber(c.commit_added_lines)} líneas`;
}

function commitLink(c: TaskCommitView): string {
  const how = c.ai_matched_lines !== null ? 'hashes de línea' : 'clave en la rama';
  return c.verified_remote ? `${how} · SHA verificado por webhook` : `${how} · reportado por el IDE`;
}
