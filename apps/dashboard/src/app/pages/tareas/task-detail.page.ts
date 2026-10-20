import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { rxResource, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { TaskDetail, TaskSessionView } from '@magicode/contracts';
import { map } from 'rxjs';

import { ApiClient } from '@/core/http/api-client';
import { AgoPipe, DateTimePipe, NumPipe, ShaPipe } from '@/shared/components/ui/format.pipes';
import { ProvenanceComponent } from '@/shared/components/ui/provenance.component';
import { SectionComponent } from '@/shared/components/ui/section.component';
import { LoadingComponent, StateComponent } from '@/shared/components/ui/states.component';
import { CriticalityComponent, StatusMarkComponent } from '@/shared/components/ui/status-mark.component';
import { PR_STATE_LABEL } from '@/shared/labels/labels';
import { formatDuration, formatNumber, formatPercent } from '@/shared/utils/format';
import { JiraActionsComponent } from './jira-actions.component';
import { TD, TH, taskStatusLabel, taskTone } from './tareas.shared';

interface SessionRow {
  s: TaskSessionView;
  duration: string;
  commits: number;
  aiLines: number | null;
}

@Component({
  selector: 'app-task-detail-page',
  imports: [
    RouterLink,
    NumPipe,
    DateTimePipe,
    AgoPipe,
    ShaPipe,
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

      <app-section title="Enlaces" headingId="h-links">
        <span hint>Ramas, commits, pull requests y despliegues enlazados con la tarea</span>
        <ol class="m-0 list-none p-0">
          @for (b of t.linked.branches; track b.repository + b.branch) {
            <li [class]="li">
              <span class="pt-0.5 text-xs text-muted">Rama</span>
              <div class="min-w-0">
                <div class="font-mono text-sm [overflow-wrap:anywhere]">{{ b.branch }}</div>
                <div class="text-sm text-ink-2">
                  {{ b.repository }} · {{ b.commits | num }} commits · {{ b.sessions | num }} sesiones{{ b.merged_into ? ' · fusionada en ' + b.merged_into : '' }}
                </div>
              </div>
            </li>
          }
          @for (c of t.linked.commits; track c.sha) {
            <li [class]="li">
              <span class="pt-0.5 text-xs text-muted">Commit</span>
              <div class="min-w-0">
                <div class="font-mono text-sm">{{ c.sha | sha }}</div>
                <div class="text-sm text-ink-2">{{ commitDetail(c) }}</div>
              </div>
            </li>
          }
          @for (pr of t.linked.pull_requests; track pr.repository + pr.number) {
            <li [class]="li">
              <span class="pt-0.5 text-xs text-muted">Pull request</span>
              <div class="min-w-0">
                <div class="font-mono text-sm [overflow-wrap:anywhere]">
                  <a [href]="pr.url" target="_blank" rel="noopener" class="no-underline">#{{ pr.number }}</a> · {{ pr.source_branch }} → {{ pr.target_branch }}
                </div>
                <div class="text-sm text-ink-2">{{ prState(pr.state) }} · {{ pr.ai.commits_with_ai | num }} commits con líneas IA</div>
              </div>
            </li>
          }
          @for (d of t.linked.deployments; track d.deployment_id) {
            <li [class]="li">
              <span class="pt-0.5 text-xs text-muted">Despliegue</span>
              <div class="min-w-0">
                <div class="font-mono text-sm">{{ d.environment ?? '—' }} · {{ d.sha | sha }}</div>
                <div class="text-sm text-ink-2">{{ d.state ?? '—' }}{{ d.deployed ? ' · desplegado' : '' }}</div>
              </div>
            </li>
          } @empty {
            <li [class]="li">
              <span class="pt-0.5 text-xs text-muted">Despliegue</span>
              <div class="min-w-0">
                <div class="font-mono text-sm">sin evidencia</div>
                <div class="text-sm text-ink-2">ningún deployment success para estos SHA</div>
              </div>
            </li>
          }
        </ol>
      </app-section>

      <app-section title="Sesiones de MagiCode" headingId="h-sessions">
        <span hint>{{ sessions().length | num }} {{ sessions().length === 1 ? 'sesión' : 'sesiones' }}</span>
        @if (sessions().length === 0) {
          <p class="m-0 py-5 text-[15px] text-ink-2">Sin sesiones de MagiCode enlazadas.</p>
        } @else {
          <div class="overflow-x-auto">
            <table class="w-full min-w-[820px] border-collapse text-sm">
              <thead>
                <tr>
                  <th scope="col" [class]="th">Sesión</th>
                  <th scope="col" [class]="th">Inicio</th>
                  <th scope="col" [class]="th">Duración</th>
                  <th scope="col" [class]="th">Rama</th>
                  <th scope="col" [class]="th + ' text-right'">Commits</th>
                  <th scope="col" [class]="th + ' text-right'">Líneas IA en commits</th>
                </tr>
              </thead>
              <tbody class="font-mono">
                @for (r of sessions(); track r.s.session_id) {
                  <tr class="border-t border-rule">
                    <td [class]="td + ' [overflow-wrap:anywhere]'">{{ r.s.session_id }}</td>
                    <td [class]="td + ' whitespace-nowrap text-ink-2'">{{ r.s.started_at | datetime }}</td>
                    <td [class]="td + ' whitespace-nowrap text-ink-2'">{{ r.duration }}</td>
                    <td [class]="td + ' text-[13px] text-ink-2 [overflow-wrap:anywhere]'">{{ r.s.branch ?? '—' }}</td>
                    <td [class]="td + ' text-right'">{{ r.commits | num }}</td>
                    <td [class]="td + ' text-right'">{{ r.aiLines | num }}</td>
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
  protected readonly li =
    'grid grid-cols-[120px_minmax(0,1fr)] items-start gap-x-4 border-t border-rule py-3.5 first:border-t-0';

  protected readonly taskKey = toSignal(this.route.paramMap.pipe(map((p) => p.get('taskKey') ?? '')), {
    initialValue: '',
  });

  protected readonly task = rxResource({
    params: () => this.taskKey() || undefined,
    stream: ({ params }) => this.api.get<TaskDetail>('task', { params: { taskKey: params } }),
  });

  protected readonly tokensPer100 = computed(() => {
    const t = this.task.value();
    const tokens = t?.tokens.value;
    if (!t || tokens === null || tokens === undefined || !t.effective_lines) return null;
    return Math.round((tokens / t.effective_lines) * 100);
  });

  protected readonly sessions = computed<SessionRow[]>(() => {
    const t = this.task.value();
    if (!t) return [];
    const commits = t.linked?.commits ?? [];
    return (t.linked?.sessions ?? []).map((s) => {
      const own = commits.filter((c) => c.session_id === s.session_id);
      const known = own.filter((c) => c.ai_matched_lines !== null);
      return {
        s,
        duration: formatDuration(s.started_at, s.ended_at),
        commits: own.length,
        aiLines: known.length ? known.reduce((n, c) => n + (c.ai_matched_lines ?? 0), 0) : null,
      };
    });
  });

  protected readonly tone = taskTone;
  protected readonly statusLabel = taskStatusLabel;

  protected prState(s: string): string {
    return PR_STATE_LABEL[s] ?? s;
  }

  protected commitDetail(c: TaskDetail['linked']['commits'][number]): string {
    const origin = c.verified_remote ? 'SHA verificado por webhook' : 'reportado por el IDE';
    if (c.ai_share === null || c.ai_matched_lines === null) return `${c.repository} · solo remoto, sin cruce de hashes`;
    return `${formatPercent(c.ai_share, 0)} del commit vino de la IA · ${formatNumber(c.ai_matched_lines)} de ${formatNumber(c.commit_added_lines)} líneas · ${origin}`;
  }
}
