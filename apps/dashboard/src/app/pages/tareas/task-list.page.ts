import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';

import { ScopeService } from '@/core/data/scope.service';
import { TasksService } from '@/core/data/tasks.service';
import { NumPipe } from '@/shared/components/ui/format.pipes';
import { ProvenanceComponent } from '@/shared/components/ui/provenance.component';
import { LoadingComponent, StateComponent } from '@/shared/components/ui/states.component';
import { StatusMarkComponent } from '@/shared/components/ui/status-mark.component';
import { SELECT, TD, TH, prLabel, taskStatusLabel, taskTone } from './tareas.shared';

type CategoryFilter = '' | 'todo' | 'in_progress' | 'done';

@Component({
  selector: 'app-task-list-page',
  imports: [RouterLink, NumPipe, ProvenanceComponent, StatusMarkComponent, LoadingComponent, StateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div>
        <h1 class="m-0 text-[34px] leading-tight font-semibold tracking-[-0.02em]">Tareas</h1>
        <p class="m-0 mt-1 text-[13px] text-muted">
          Enlazadas por rama y commits{{ projectId() ? ' · ' + projectId() : '' }}
        </p>
      </div>
      <label class="flex flex-col gap-1.5 text-[13px] text-ink-2">
        Estado
        <select [class]="selectClass" [value]="category()" (change)="setCategory($event)">
          <option value="">Todos</option>
          <option value="todo">Por hacer</option>
          <option value="in_progress">En curso</option>
          <option value="done">Hecha</option>
        </select>
      </label>
    </div>

    <section class="mt-10" aria-labelledby="h-task-list">
      <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-ink pb-2.5">
        <h2 id="h-task-list" class="m-0 text-lg font-semibold">Por tarea</h2>
        @if (rows(); as list) {
          <span class="text-[13px] text-muted">{{ list.length | num }} {{ list.length === 1 ? 'tarea' : 'tareas' }}</span>
        }
      </div>

      @if (tasks.error()) {
        <app-state kind="error" message="No se pudieron cargar las tareas." (retry)="tasks.reload()" />
      } @else if (rows() === null) {
        <app-loading [rows]="5" label="Cargando tareas…" />
      } @else if (rows()!.length === 0) {
        <app-state
          message="Todavía no hay tareas enlazadas."
          detail="Aparecen cuando una rama, un commit o un trailer MagiCode-Task lleva la clave de la tarea (p. ej. feature/MAG-123-…)."
        />
      } @else {
        <div class="overflow-x-auto">
          <table class="w-full min-w-[900px] border-collapse text-sm">
            <thead>
              <tr>
                <th scope="col" [class]="th">Tarea</th>
                <th scope="col" [class]="th">Estado</th>
                <th scope="col" [class]="th">Ramas</th>
                <th scope="col" [class]="th">PRs</th>
                <th scope="col" [class]="th + ' text-right'">Tokens</th>
                <th scope="col" [class]="th + ' text-right'">Líneas efectivas</th>
                <th scope="col" [class]="th">Desplegado</th>
              </tr>
            </thead>
            <tbody>
              @for (t of rows(); track t.task_key) {
                <tr class="border-t border-rule">
                  <td [class]="td">
                    <a [routerLink]="[t.task_key]" class="font-mono text-[13px] no-underline">{{ t.task_key }}</a>
                    @if (t.title && t.title !== t.task_key) {
                      <div class="text-ink">{{ t.title }}</div>
                    }
                  </td>
                  <td [class]="td + ' text-ink-2'">
                    <app-status [tone]="tone(t)" [label]="statusLabel(t)" />
                  </td>
                  <td [class]="td + ' font-mono text-[13px] text-ink-2'">
                    @for (b of t.branches; track b) {
                      <div class="[overflow-wrap:anywhere]">{{ b }}</div>
                    } @empty {
                      —
                    }
                  </td>
                  <td [class]="td + ' whitespace-nowrap text-ink-2'">
                    @for (pr of t.pull_requests; track pr.number) {
                      <div><a [href]="pr.url" target="_blank" rel="noopener" class="no-underline">{{ prText(pr) }}</a></div>
                    } @empty {
                      —
                    }
                  </td>
                  <td [class]="td + ' text-right font-mono whitespace-nowrap'">
                    {{ t.tokens.value | num }}<app-prov [p]="t.tokens.value === null ? null : t.tokens.provenance" />
                  </td>
                  <td [class]="td + ' text-right font-mono'">{{ t.effective_lines | num: 1 }}</td>
                  <td [class]="td + ' text-ink-2'">{{ t.deployed ? 'Sí' : '—' }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>

    <p class="mt-10 mb-0 max-w-[820px] text-[13px] text-muted">
      Los tokens de una tarea se atribuyen por enlace (sesiones cuya rama o task_key coincide), por eso suelen ser
      estimados aunque el total del proyecto sea real.
    </p>
  `,
})
export class TaskListPage {
  private readonly scope = inject(ScopeService);
  private readonly api = inject(TasksService);

  protected readonly th = TH;
  protected readonly td = TD;
  protected readonly selectClass = SELECT;
  protected readonly category = signal<CategoryFilter>('');
  protected readonly projectId = this.scope.projectId;

  protected readonly tasks = rxResource({
    params: () =>
      this.scope.projects.isLoading()
        ? undefined
        : { project_id: this.scope.projectId() ?? undefined, status_category: this.category() || undefined },
    stream: ({ params }) => this.api.tasks(params),
  });

  /** null mientras carga. El filtro se aplica también en cliente por si el API lo ignora. */
  protected readonly rows = computed(() => {
    if (!this.tasks.hasValue()) return null;
    const c = this.category();
    const list = this.tasks.value() ?? [];
    return c ? list.filter((t) => t.status_category === c) : list;
  });

  protected readonly tone = taskTone;
  protected readonly statusLabel = taskStatusLabel;
  protected readonly prText = prLabel;

  protected setCategory(e: Event): void {
    this.category.set((e.target as HTMLSelectElement).value as CategoryFilter);
  }
}
