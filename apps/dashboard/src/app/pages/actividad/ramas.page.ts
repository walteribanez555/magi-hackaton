import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';

import { ScopeService } from '@/core/data/scope.service';
import { TasksService } from '@/core/data/tasks.service';
import { AgoPipe, NumPipe, ShaPipe } from '@/shared/components/ui/format.pipes';
import { LoadingComponent, StateComponent } from '@/shared/components/ui/states.component';

@Component({
  selector: 'app-ramas-page',
  imports: [AgoPipe, NumPipe, ShaPipe, LoadingComponent, StateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="m-0 text-[34px] font-semibold leading-tight tracking-[-0.02em]">Ramas</h1>
    <p class="m-0 mt-2.5 max-w-[820px] text-base text-ink-2">
      Ramas con actividad de MagiCode o vistas por webhook, con sus tareas, sesiones y commits.
    </p>
    <div class="mt-8">
      @if (branches.error()) {
        <app-state kind="error" message="No se pudieron cargar las ramas." (retry)="branches.reload()" />
      } @else if (branches.isLoading() || (!scope.projectId() && scope.projects.isLoading())) {
        <app-loading label="Cargando ramas…" />
      } @else if (!(branches.value() ?? []).length) {
        <app-state message="Todavía no hay ramas registradas para este proyecto." />
      } @else {
        <div class="overflow-x-auto">
          <table class="w-full min-w-[880px] border-collapse text-sm">
            <caption class="sr-only">Ramas</caption>
            <thead>
              <tr class="border-b border-ink text-xs text-muted">
                <th scope="col" class="py-2.5 pr-3 text-left font-medium">Rama</th>
                <th scope="col" class="px-3 py-2.5 text-left font-medium">Tareas</th>
                <th scope="col" class="px-3 py-2.5 text-right font-medium">Sesiones</th>
                <th scope="col" class="px-3 py-2.5 text-right font-medium">Commits</th>
                <th scope="col" class="px-3 py-2.5 text-left font-medium">Head</th>
                <th scope="col" class="px-3 py-2.5 text-left font-medium">Fusionada en</th>
                <th scope="col" class="py-2.5 pl-3 text-left font-medium">Última actividad</th>
              </tr>
            </thead>
            <tbody>
              @for (b of branches.value() ?? []; track b.repository + b.branch) {
                <tr class="border-b border-rule">
                  <td class="py-3 pr-3">
                    <div class="font-mono text-[13px]">{{ b.branch }}</div>
                    <div class="text-xs text-muted">{{ b.repository }}</div>
                  </td>
                  <td class="px-3 py-3 font-mono text-[13px]">{{ b.task_keys.length ? b.task_keys.join(', ') : '—' }}</td>
                  <td class="px-3 py-3 text-right font-mono">{{ b.sessions | num }}</td>
                  <td class="px-3 py-3 text-right font-mono">{{ b.commits | num }}</td>
                  <td class="px-3 py-3 font-mono text-[13px]">{{ b.head_sha | sha }}</td>
                  <td class="px-3 py-3 font-mono text-[13px]">{{ b.merged_into ?? '—' }}</td>
                  <td class="whitespace-nowrap py-3 pl-3">{{ b.last_activity_at | ago }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
})
export class RamasPage {
  protected readonly scope = inject(ScopeService);
  private readonly tasks = inject(TasksService);

  protected readonly branches = rxResource({
    params: () => this.scope.projectQuery(),
    stream: ({ params }) => this.tasks.branches(params),
  });
}
