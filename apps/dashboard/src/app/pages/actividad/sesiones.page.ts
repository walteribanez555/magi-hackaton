import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';

import { ProductivityService } from '@/core/data/productivity.service';
import { ScopeService } from '@/core/data/scope.service';
import type { SessionWithDeveloper } from '@/core/data/types';
import { DateTimePipe, NumPipe } from '@/shared/components/ui/format.pipes';
import { MetricComponent } from '@/shared/components/ui/metric.component';
import { LoadingComponent, StateComponent } from '@/shared/components/ui/states.component';
import { STAGE_SHORT } from '@/shared/labels/labels';
import { formatDuration } from '@/shared/utils/format';

@Component({
  selector: 'app-sesiones-page',
  imports: [RouterLink, DateTimePipe, NumPipe, MetricComponent, LoadingComponent, StateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="m-0 text-[34px] font-semibold leading-tight tracking-[-0.02em]">Sesiones</h1>
    <p class="m-0 mt-2.5 max-w-[820px] text-base text-ink-2">
      Cada sesión de MagiCode en el editor: peticiones a la IA, tokens imputados, líneas aceptadas y hasta qué etapa llegaron.
    </p>
    <div class="mt-8">
      @if (sessions.error()) {
        <app-state kind="error" message="No se pudieron cargar las sesiones." (retry)="sessions.reload()" />
      } @else if (sessions.isLoading() || (!scope.projectId() && scope.projects.isLoading())) {
        <app-loading label="Cargando sesiones…" />
      } @else if (!(sessions.value() ?? []).length) {
        <app-state message="No hay sesiones en este periodo." />
      } @else {
        <div class="overflow-x-auto">
          <table class="w-full min-w-[1160px] border-collapse text-sm">
            <caption class="sr-only">Sesiones</caption>
            <thead>
              <tr class="border-b border-ink text-xs text-muted">
                <th scope="col" class="py-2.5 pr-3 text-left font-medium">Sesión</th>
                <th scope="col" class="px-3 py-2.5 text-left font-medium">Developer</th>
                <th scope="col" class="px-3 py-2.5 text-left font-medium">Rama</th>
                <th scope="col" class="px-3 py-2.5 text-left font-medium">Tarea</th>
                <th scope="col" class="px-3 py-2.5 text-left font-medium">Inicio</th>
                <th scope="col" class="px-3 py-2.5 text-right font-medium">Duración</th>
                <th scope="col" class="px-3 py-2.5 text-right font-medium">Peticiones</th>
                <th scope="col" class="px-3 py-2.5 text-right font-medium">Tokens</th>
                <th scope="col" class="px-3 py-2.5 text-right font-medium">Aceptadas</th>
                <th scope="col" class="px-3 py-2.5 text-right font-medium">Efectivas</th>
                <th scope="col" class="px-3 py-2.5 text-right font-medium">Commits</th>
                <th scope="col" class="py-2.5 pl-3 text-left font-medium">Etapa</th>
              </tr>
            </thead>
            <tbody>
              @for (s of sessions.value() ?? []; track s.session_id) {
                <tr class="border-b border-rule">
                  <td class="py-3 pr-3">
                    <a class="font-mono text-[13px]" [routerLink]="[s.session_id]">{{ s.session_id }}</a>
                    <div class="text-xs text-muted">{{ s.repository }}</div>
                  </td>
                  <td class="px-3 py-3" [attr.title]="devTitle(s)">{{ dev(s) }}</td>
                  <td class="px-3 py-3 font-mono text-[13px]">{{ s.branch ?? '—' }}</td>
                  <td class="px-3 py-3 font-mono text-[13px]">{{ s.task_key ?? '—' }}</td>
                  <td class="whitespace-nowrap px-3 py-3">{{ s.started_at | datetime }}</td>
                  <td class="whitespace-nowrap px-3 py-3 text-right font-mono">{{ duration(s.started_at, s.ended_at) }}</td>
                  <td class="px-3 py-3 text-right font-mono">{{ s.ai_requests | num }}</td>
                  <td class="px-3 py-3 text-right font-mono"><app-metric [m]="s.tokens" /></td>
                  <td class="px-3 py-3 text-right font-mono">{{ s.accepted_lines | num }}</td>
                  <td class="px-3 py-3 text-right font-mono">{{ s.effective_lines | num: 1 }}</td>
                  <td class="px-3 py-3 text-right font-mono">{{ s.commits.length | num }}</td>
                  <td class="whitespace-nowrap py-3 pl-3">{{ stage(s.highest_stage) }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
})
export class SesionesPage {
  protected readonly scope = inject(ScopeService);
  private readonly productivity = inject(ProductivityService);

  protected readonly sessions = rxResource({
    params: () => this.scope.query() ?? undefined,
    stream: ({ params }) => this.productivity.sessions(params),
  });

  protected dev(s: SessionWithDeveloper): string {
    return s.developer_name || s.developer || '—';
  }
  protected devTitle(s: SessionWithDeveloper): string | null {
    return s.developer_name && s.developer ? s.developer : null;
  }
  protected duration(a: string, b: string | null): string {
    return formatDuration(a, b);
  }
  protected stage(s: keyof typeof STAGE_SHORT): string {
    return STAGE_SHORT[s];
  }
}
