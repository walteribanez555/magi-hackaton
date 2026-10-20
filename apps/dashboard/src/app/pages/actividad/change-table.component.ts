import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { ChangeListItem } from '@magicode/contracts';

import { DateTimePipe, PctPipe, ScorePipe } from '@/shared/components/ui/format.pipes';
import { CriticalityComponent } from '@/shared/components/ui/status-mark.component';
import { CHANGE_STATUS_LABEL } from '@/shared/labels/labels';

/** Tabla de cambios (diseño Cambios): fila seleccionable con un botón real en la primera celda. */
@Component({
  selector: 'app-change-table',
  imports: [CriticalityComponent, ScorePipe, PctPipe, DateTimePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="overflow-x-auto">
      <table class="w-full min-w-[1040px] border-collapse text-sm">
        <caption class="sr-only">{{ caption() }}</caption>
        <thead>
          <tr class="border-b border-ink text-xs text-muted">
            <th scope="col" class="py-2.5 pr-3 text-left font-medium">Cambio</th>
            <th scope="col" class="px-3 py-2.5 text-left font-medium">Tarea</th>
            <th scope="col" class="px-3 py-2.5 text-right font-medium">Líneas</th>
            <th scope="col" class="px-3 py-2.5 text-right font-medium">Importancia</th>
            <th scope="col" class="px-3 py-2.5 text-right font-medium">Redundancia</th>
            <th scope="col" class="px-3 py-2.5 text-right font-medium">Mecánico</th>
            <th scope="col" class="px-3 py-2.5 text-right font-medium">Supervivencia</th>
            <th scope="col" class="px-3 py-2.5 text-right font-medium">Retrabajo</th>
            <th scope="col" class="py-2.5 pl-3 text-left font-medium">Criticidad</th>
          </tr>
        </thead>
        <tbody>
          @for (c of changes(); track c.change_id) {
            <tr
              class="cursor-pointer border-b border-rule hover:bg-selected"
              [class.bg-selected]="c.change_id === selectedId()"
              (click)="select.emit(c.change_id)"
            >
              <td class="py-3 pr-3">
                <button
                  type="button"
                  class="cursor-pointer text-left font-mono text-[13px] text-ink hover:text-accent"
                  [attr.aria-pressed]="c.change_id === selectedId()"
                  (click)="$event.stopPropagation(); select.emit(c.change_id)"
                >
                  {{ c.files[0]?.path ?? c.change_id }}@if (c.files.length > 1) {<span class="font-sans text-xs text-muted"> +{{ c.files.length - 1 }} archivos</span>}
                </button>
                <div class="text-xs text-muted">
                  <span class="font-mono">{{ c.change_id }}</span> · {{ statusLabel(c.status) }} · {{ c.occurred_at | datetime }}
                </div>
              </td>
              <td class="px-3 py-3 font-mono text-[13px]">{{ c.task_key ?? '—' }}</td>
              <td class="px-3 py-3 text-right font-mono">{{ c.accepted_added_lines }}</td>
              <td class="px-3 py-3 text-right font-mono">{{ c.importance_score | score }}</td>
              <td class="px-3 py-3 text-right font-mono">{{ c.redundancy_score | score }}</td>
              <td class="px-3 py-3 text-right font-mono">{{ c.mechanical_share | pct: 0 }}</td>
              <td class="px-3 py-3 text-right font-mono">{{ c.scores?.survival_probability | score }}</td>
              <td class="px-3 py-3 text-right font-mono">{{ c.scores?.rework_risk | score }}</td>
              <td class="whitespace-nowrap py-3 pl-3">
                <app-crit [level]="c.scores?.criticality" [score]="c.scores?.criticality_score" emptyText="sin puntuar" />
              </td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class ChangeTableComponent {
  readonly changes = input.required<ChangeListItem[]>();
  readonly selectedId = input<string | null>(null);
  readonly caption = input('Cambios');
  readonly select = output<string>();

  protected statusLabel(s: string): string {
    return CHANGE_STATUS_LABEL[s] ?? s;
  }
}
