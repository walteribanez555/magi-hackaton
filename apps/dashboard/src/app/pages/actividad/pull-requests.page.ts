import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import type { PullRequestListItem } from '@magicode/contracts';

import { ScopeService } from '@/core/data/scope.service';
import { TasksService } from '@/core/data/tasks.service';
import { NumPipe, ShaPipe } from '@/shared/components/ui/format.pipes';
import { ProvenanceComponent } from '@/shared/components/ui/provenance.component';
import { LoadingComponent, StateComponent } from '@/shared/components/ui/states.component';
import { StatusMarkComponent, type Tone } from '@/shared/components/ui/status-mark.component';
import { PR_STATE_LABEL } from '@/shared/labels/labels';

/** El contrato no trae título; si el API lo agrega se muestra. */
type PrRow = PullRequestListItem & { title?: string | null };

const STATE_TONE: Record<string, Tone> = { open: 'info', merged: 'ok', closed: 'muted' };

@Component({
  selector: 'app-pull-requests-page',
  imports: [NumPipe, ShaPipe, ProvenanceComponent, LoadingComponent, StateComponent, StatusMarkComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="m-0 text-[34px] font-semibold leading-tight tracking-[-0.02em]">Pull requests</h1>
    <p class="m-0 mt-2.5 max-w-[820px] text-base text-ink-2">
      Pull requests recibidos por webhook del repositorio, con las tareas que mencionan y si contienen líneas escritas con IA.
    </p>
    @if (totals(); as t) {
      <p class="m-0 mt-2 text-[13px] text-muted">
        <span class="font-mono text-ink">{{ t.open | num }}</span> abiertos ·
        <span class="font-mono text-ink">{{ t.merged | num }}</span> fusionados ·
        <span class="font-mono text-ink">{{ t.closed | num }}</span> cerrados ·
        <span class="font-mono text-ink">{{ t.with_ai_lines | num }}</span> con líneas IA
      </p>
    }

    <div class="mt-8 flex flex-wrap items-end gap-x-6 gap-y-3 text-sm">
      <label class="flex flex-col gap-1 text-muted">
        Estado
        <select class="min-h-10 border border-field bg-bg px-2 text-ink" [value]="state()" (change)="state.set(val($event))">
          <option value="">Todos</option>
          <option value="open">Abiertos</option>
          <option value="merged">Fusionados</option>
          <option value="closed">Cerrados</option>
        </select>
      </label>
    </div>

    <div class="mt-4">
      @if (prs.error()) {
        <app-state kind="error" message="No se pudieron cargar los pull requests." (retry)="prs.reload()" />
      } @else if (prs.isLoading() || (!scope.projectId() && scope.projects.isLoading())) {
        <app-loading label="Cargando pull requests…" />
      } @else if (!rows().length) {
        <app-state
          message="Todavía no hay pull requests."
          detail="Aparecen cuando el webhook del repositorio envía eventos pull_request."
        />
      } @else {
        <div class="overflow-x-auto">
          <table class="w-full min-w-[1060px] border-collapse text-sm">
            <caption class="sr-only">Pull requests</caption>
            <thead>
              <tr class="border-b border-ink text-xs text-muted">
                <th scope="col" class="py-2.5 pr-3 text-left font-medium">Número</th>
                <th scope="col" class="px-3 py-2.5 text-left font-medium">Título / tareas</th>
                <th scope="col" class="px-3 py-2.5 text-left font-medium">Autor</th>
                <th scope="col" class="px-3 py-2.5 text-left font-medium">Rama origen → destino</th>
                <th scope="col" class="px-3 py-2.5 text-left font-medium">Estado</th>
                <th scope="col" class="px-3 py-2.5 text-left font-medium">Con líneas IA</th>
                <th scope="col" class="py-2.5 pl-3 text-left font-medium">Merge SHA</th>
              </tr>
            </thead>
            <tbody>
              @for (p of rows(); track p.repository + p.number) {
                <tr class="border-b border-rule">
                  <td class="py-3 pr-3">
                    <a class="font-mono text-[13px]" [href]="p.url" target="_blank" rel="noopener">#{{ p.number }}</a>
                    <div class="text-xs text-muted">{{ p.repository }}</div>
                  </td>
                  <td class="px-3 py-3">
                    @if (p.title) {<div>{{ p.title }}</div>}
                    <div class="font-mono text-[13px]" [class.text-muted]="!!p.title">{{ p.task_keys.length ? p.task_keys.join(', ') : '—' }}</div>
                  </td>
                  <td class="px-3 py-3 font-mono text-[13px]">{{ p.author_login ?? '—' }}</td>
                  <td class="px-3 py-3 font-mono text-[13px]">{{ p.source_branch }} → {{ p.target_branch }}</td>
                  <td class="px-3 py-3"><app-status [tone]="tone(p.state)" [label]="stateLabel(p.state)" /></td>
                  <td class="whitespace-nowrap px-3 py-3">
                    @if (p.ai.contains_ai_lines) {
                      sí · <span class="font-mono">{{ p.ai.ai_matched_lines | num }}</span> de
                      <span class="font-mono">{{ p.ai.commit_added_lines | num }}</span><app-prov [p]="p.ai.provenance" />
                    } @else {
                      no<app-prov [p]="p.ai.provenance" />
                    }
                  </td>
                  <td class="py-3 pl-3 font-mono text-[13px]">{{ p.merge_sha | sha }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
})
export class PullRequestsPage {
  protected readonly scope = inject(ScopeService);
  private readonly tasksApi = inject(TasksService);

  protected readonly state = signal('');

  /** Se pide el cuerpo completo: `meta` trae los totales históricos (PullRequestTotals). */
  protected readonly prs = rxResource({
    params: () => {
      const q = this.scope.projectQuery();
      return q ? { ...q, state: this.state() } : undefined;
    },
    stream: ({ params }) => this.tasksApi.pullRequestsWithTotals<PrRow>(params),
  });

  protected readonly rows = computed(() => this.prs.value()?.data ?? []);
  protected readonly totals = computed(() => this.prs.value()?.meta ?? null);

  protected tone(s: string): Tone {
    return STATE_TONE[s] ?? 'muted';
  }
  protected stateLabel(s: string): string {
    return PR_STATE_LABEL[s] ?? s;
  }
  protected val(e: Event): string {
    return (e.target as HTMLSelectElement).value;
  }
}
