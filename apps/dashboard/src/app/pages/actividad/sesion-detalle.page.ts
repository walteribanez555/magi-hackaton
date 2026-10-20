import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import type { ChangeListItem } from '@magicode/contracts';

import { ProductivityService } from '@/core/data/productivity.service';
import { DateTimePipe, NumPipe } from '@/shared/components/ui/format.pipes';
import { MetricComponent } from '@/shared/components/ui/metric.component';
import { LoadingComponent, StateComponent } from '@/shared/components/ui/states.component';
import { STAGE_SHORT } from '@/shared/labels/labels';
import { formatDuration } from '@/shared/utils/format';
import { ChangeDetailComponent } from './change-detail.component';
import { ChangeTableComponent } from './change-table.component';
import { byCriticality } from './sort';

@Component({
  selector: 'app-sesion-detalle-page',
  imports: [RouterLink, DateTimePipe, NumPipe, MetricComponent, LoadingComponent, StateComponent, ChangeTableComponent, ChangeDetailComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a routerLink="/actividad/sesiones" class="text-sm no-underline">← Sesiones</a>
    <h1 class="m-0 mt-2 break-all font-mono text-[26px] font-semibold leading-tight tracking-[-0.01em]">{{ sessionId() }}</h1>
    @if (session.error()) {
      <div class="mt-8"><app-state kind="error" message="No se pudo cargar la sesión." (retry)="session.reload()" /></div>
    } @else if (session.isLoading()) {
      <div class="mt-8"><app-loading label="Cargando sesión…" /></div>
    } @else if (session.value(); as s) {
      <dl class="m-0 mt-8 grid max-w-[720px] grid-cols-[minmax(160px,auto)_1fr] gap-x-6 gap-y-2 border-t border-rule pt-4 text-sm">
        <dt class="text-ink-2">Repositorio</dt><dd class="m-0 font-mono text-[13px]">{{ s.repository }}</dd>
        <dt class="text-ink-2">Rama</dt><dd class="m-0 font-mono text-[13px]">{{ s.branch ?? '—' }}</dd>
        <dt class="text-ink-2">Tarea</dt><dd class="m-0 font-mono text-[13px]">{{ s.task_key ?? '—' }}</dd>
        <dt class="text-ink-2">Inicio</dt><dd class="m-0">{{ s.started_at | datetime }}</dd>
        <dt class="text-ink-2">Duración</dt><dd class="m-0 font-mono">{{ duration(s.started_at, s.ended_at) }}</dd>
        <dt class="text-ink-2">Peticiones a la IA</dt><dd class="m-0 font-mono">{{ s.ai_requests | num }}</dd>
        <dt class="text-ink-2">Tokens</dt><dd class="m-0 font-mono"><app-metric [m]="s.tokens" /></dd>
        <dt class="text-ink-2">Líneas aceptadas</dt><dd class="m-0 font-mono">{{ s.accepted_lines | num }}</dd>
        <dt class="text-ink-2">Líneas efectivas</dt><dd class="m-0 font-mono">{{ s.effective_lines | num: 1 }}</dd>
        <dt class="text-ink-2">Etapa más alta</dt><dd class="m-0">{{ stage(s.highest_stage) }}</dd>
        <dt class="text-ink-2">Commits</dt>
        <dd class="m-0 font-mono text-[13px]">
          @for (sha of s.commits; track sha) {<div>{{ sha.slice(0, 12) }}</div>} @empty {—}
        </dd>
      </dl>

      <h2 class="m-0 mt-12 border-b border-ink pb-2.5 text-lg font-semibold">Cambios de la sesión</h2>
      @if (rows().length) {
        <app-change-table caption="Cambios de la sesión" [changes]="rows()" [selectedId]="selected()?.change_id ?? null" (select)="selectedId.set($event)" />
        @if (selected(); as c) {
          <app-change-detail [change]="c" />
        }
      } @else {
        <app-state message="Esta sesión no tiene cambios registrados." />
      }
    }
  `,
})
export class SesionDetallePage {
  private readonly productivity = inject(ProductivityService);
  /** :sessionId (withComponentInputBinding) */
  readonly sessionId = input.required<string>();
  protected readonly selectedId = signal<string | null>(null);

  protected readonly session = rxResource({
    params: () => this.sessionId(),
    stream: ({ params }) => this.productivity.session(params),
  });

  protected readonly rows = computed(() => [...(this.session.value()?.changes ?? [])].sort(byCriticality));
  protected readonly selected = computed<ChangeListItem | null>(() => {
    const rows = this.rows();
    return rows.find((c) => c.change_id === this.selectedId()) ?? rows[0] ?? null;
  });

  protected duration(a: string, b: string | null): string {
    return formatDuration(a, b);
  }
  protected stage(s: keyof typeof STAGE_SHORT): string {
    return STAGE_SHORT[s];
  }
}
