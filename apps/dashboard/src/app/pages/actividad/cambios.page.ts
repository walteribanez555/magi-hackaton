import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import type { ChangeListItem } from '@magicode/contracts';

import { ProductivityService } from '@/core/data/productivity.service';
import { ScopeService } from '@/core/data/scope.service';
import { ProvenanceComponent } from '@/shared/components/ui/provenance.component';
import { LoadingComponent, StateComponent } from '@/shared/components/ui/states.component';
import { CHANGE_STATUS_LABEL } from '@/shared/labels/labels';
import { ChangeDetailComponent } from './change-detail.component';
import { ChangeTableComponent } from './change-table.component';
import { byCriticality, byDate, byLines } from './sort';

type Estado = 'accepted_plus' | 'all' | ChangeListItem['status'];
type Orden = 'criticality' | 'date' | 'lines';

const ACCEPTED_PLUS = new Set(['accepted', 'committed', 'in_reference']);

@Component({
  selector: 'app-cambios-page',
  imports: [ChangeTableComponent, ChangeDetailComponent, LoadingComponent, StateComponent, ProvenanceComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="m-0 text-[34px] font-semibold leading-tight tracking-[-0.02em]">Cambios</h1>
    <p class="m-0 mt-2.5 max-w-[820px] text-base text-ink-2">
      Cada cambio lleva sus tres aristas, calculadas en el editor sin enviar código, y dos puntuaciones del modelo:
      probabilidad de llegar a la versión de referencia y riesgo de retrabajo.
    </p>
    @if (model(); as m) {
      <p class="m-0 mt-2 text-[13px] text-muted">
        Modelo <span class="font-mono">{{ m.version }}</span><app-prov [p]="m.provenance" />
      </p>
    }

    <div class="mt-8 flex flex-wrap items-end gap-x-6 gap-y-3 text-sm">
      <label class="flex flex-col gap-1 text-muted">
        Tarea
        <select class="min-h-10 border border-field bg-bg px-2 text-ink" [value]="task()" (change)="task.set(val($event))">
          <option value="">Todas</option>
          @for (t of taskKeys(); track t) {
            <option [value]="t">{{ t }}</option>
          }
        </select>
      </label>
      <label class="flex flex-col gap-1 text-muted">
        Estado
        <select class="min-h-10 border border-field bg-bg px-2 text-ink" [value]="estado()" (change)="estado.set($any(val($event)))">
          <option value="accepted_plus">Aceptados y posteriores</option>
          <option value="all">Todos</option>
          @for (s of statuses; track s) {
            <option [value]="s">{{ statusLabel(s) }}</option>
          }
        </select>
      </label>
      <label class="flex flex-col gap-1 text-muted">
        Orden
        <select class="min-h-10 border border-field bg-bg px-2 text-ink" [value]="orden()" (change)="orden.set($any(val($event)))">
          <option value="criticality">Criticidad</option>
          <option value="date">Más recientes</option>
          <option value="lines">Más líneas</option>
        </select>
      </label>
      <span class="ml-auto text-[13px] text-muted">{{ rows().length }} de {{ (changes.value() ?? []).length }} cambios</span>
    </div>

    <div class="mt-4">
      @if (changes.error()) {
        <app-state kind="error" message="No se pudieron cargar los cambios." (retry)="changes.reload()" />
      } @else if (changes.isLoading() || !scope.projectId()) {
        @if (!scope.projects.isLoading() && !scope.projectId()) {
          <app-state message="Todavía no hay proyectos con actividad." />
        } @else {
          <app-loading label="Cargando cambios…" />
        }
      } @else if (!rows().length) {
        <app-state message="No hay cambios en este periodo con los filtros elegidos." />
      } @else {
        <app-change-table [changes]="rows()" [selectedId]="selected()?.change_id ?? null" (select)="selectedId.set($event)" />
        @if (selected(); as c) {
          <app-change-detail [change]="c" />
        }
      }
    </div>
  `,
})
export class CambiosPage {
  protected readonly scope = inject(ScopeService);
  private readonly productivity = inject(ProductivityService);

  protected readonly statuses: ChangeListItem['status'][] = ['proposed', 'accepted', 'rejected', 'committed', 'in_reference'];
  protected readonly task = signal('');
  protected readonly estado = signal<Estado>('accepted_plus');
  protected readonly orden = signal<Orden>('criticality');
  protected readonly selectedId = signal<string | null>(inject(ActivatedRoute).snapshot.queryParamMap.get('cambio'));

  protected readonly changes = rxResource({
    params: () => {
      const q = this.scope.query();
      return q ? { project_id: q.project_id, from: q.from, to: q.to } : undefined;
    },
    stream: ({ params }) => this.productivity.changes(params),
  });

  protected readonly taskKeys = computed(() =>
    [...new Set((this.changes.value() ?? []).map((c) => c.task_key).filter((k): k is string => !!k))].sort(),
  );

  protected readonly rows = computed(() => {
    const task = this.task();
    const estado = this.estado();
    const list = (this.changes.value() ?? []).filter(
      (c) =>
        (!task || c.task_key === task) &&
        (estado === 'all' || (estado === 'accepted_plus' ? ACCEPTED_PLUS.has(c.status) : c.status === estado)),
    );
    const cmp = this.orden() === 'date' ? byDate : this.orden() === 'lines' ? byLines : byCriticality;
    return [...list].sort(cmp);
  });

  protected readonly selected = computed<ChangeListItem | null>(() => {
    const rows = this.rows();
    return rows.find((c) => c.change_id === this.selectedId()) ?? rows[0] ?? null;
  });

  protected readonly model = computed(() => {
    const s = (this.changes.value() ?? []).find((c) => c.scores)?.scores;
    return s ? { version: s.model_version, provenance: s.provenance } : null;
  });

  protected val(e: Event): string {
    return (e.target as HTMLSelectElement).value;
  }
  protected statusLabel(s: string): string {
    return CHANGE_STATUS_LABEL[s] ?? s;
  }
}
