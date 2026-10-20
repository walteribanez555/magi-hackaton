import { HttpContext } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import type { AvailableTransition, OutboxAction, OutboxStatus } from '@magicode/contracts';

import { TasksService } from '@/core/data/tasks.service';
import { ApiClient } from '@/core/http/api-client';
import { describeHttpError } from '@/core/http/error-toast.interceptor';
import { SILENT_ERRORS } from '@/core/http/http-context';
import { DateTimePipe } from '@/shared/components/ui/format.pipes';
import { SectionComponent } from '@/shared/components/ui/section.component';
import { StatusMarkComponent, type Tone } from '@/shared/components/ui/status-mark.component';
import { describeTaskAction } from '@/shared/labels/labels';
import { ToastService } from '@/shared/services/toast.service';
import { SELECT, TD, TH } from './tareas.shared';

const STATUS: Record<OutboxStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Pendiente', tone: 'muted' },
  sending: { label: 'Enviando', tone: 'warn' },
  sent: { label: 'Enviada', tone: 'info' },
  failed: { label: 'Fallida', tone: 'fail' },
  skipped: { label: 'Omitida', tone: 'none' },
};

@Component({
  selector: 'app-jira-actions',
  imports: [SectionComponent, StatusMarkComponent, DateTimePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-section title="Acciones en Jira" headingId="h-jira">
      <span hint>Se envían por la cola de salida; cada una queda auditada</span>

      @if (transitionsError(); as msg) {
        <p class="m-0 border-b border-rule py-5 text-[15px] text-ink-2" role="alert">No se pudo consultar Jira: {{ msg }}</p>
      } @else {
        <form class="flex flex-wrap items-end gap-x-6 gap-y-4 pt-5 pb-2" (submit)="apply($event)">
          <label class="flex flex-[0_1_240px] flex-col gap-1.5 text-[13px] text-ink-2">
            Mover a
            <select [class]="selectClass" [disabled]="transitions.isLoading()" (change)="selected.set($any($event.target).value)">
              @if (transitions.isLoading()) {
                <option value="">Consultando Jira…</option>
              } @else {
                <option value="" [selected]="!selected()">Elige un estado</option>
                @for (t of transitions.value() ?? []; track t.id) {
                  <option [value]="t.id" [selected]="t.id === selected()">{{ t.name }}{{ t.name !== t.to_status ? ' → ' + t.to_status : '' }}</option>
                }
              }
            </select>
          </label>
          <label class="flex flex-[1_1_360px] flex-col gap-1.5 text-[13px] text-ink-2">
            Comentario (opcional)
            <input
              type="text"
              maxlength="4000"
              class="min-h-11 rounded-[4px] border border-field bg-bg px-3 py-2.5 font-sans text-[15px] text-ink"
              [value]="comment()"
              (input)="comment.set($any($event.target).value)"
            />
          </label>
          <button
            type="submit"
            class="min-h-11 cursor-pointer rounded-[4px] border-0 bg-ink px-5 py-3 font-sans text-[15px] font-semibold text-on-ink disabled:cursor-not-allowed disabled:opacity-50"
            [disabled]="!selected() || sending()"
          >
            {{ sending() ? 'Enviando…' : 'Aplicar en Jira' }}
          </button>
        </form>
        @if (!transitions.isLoading() && (transitions.value() ?? []).length === 0) {
          <p class="m-0 pb-2 text-[13px] text-muted">Jira no ofrece transiciones para este issue ahora mismo.</p>
        }
      }

      <div class="mt-4 flex items-baseline justify-between">
        <h3 class="m-0 text-[15px] font-semibold">Auditoría</h3>
        <button type="button" class="cursor-pointer py-2 text-sm text-accent hover:text-accent-hover" (click)="actions.reload()">
          Actualizar
        </button>
      </div>
      @if (actions.error()) {
        <p class="m-0 border-t border-rule py-5 text-[15px] text-ink-2">No se pudo cargar la auditoría.</p>
      } @else if ((actions.value() ?? []).length === 0) {
        <p class="m-0 border-t border-rule py-5 text-[15px] text-ink-2">
          {{ actions.isLoading() ? 'Cargando…' : 'Sin acciones enviadas a Jira para esta tarea.' }}
        </p>
      } @else {
        <div class="overflow-x-auto">
          <table class="w-full min-w-[820px] border-collapse text-sm">
            <thead>
              <tr>
                <th scope="col" [class]="th">Cuándo</th>
                <th scope="col" [class]="th">Acción</th>
                <th scope="col" [class]="th">Origen</th>
                <th scope="col" [class]="th">Estado</th>
              </tr>
            </thead>
            <tbody>
              @for (a of sorted(); track a.action_id) {
                <tr class="border-t border-rule">
                  <td [class]="td + ' whitespace-nowrap text-ink-2'">{{ a.created_at | datetime }}</td>
                  <td [class]="td">{{ describe(a) }}</td>
                  <td [class]="td + ' text-ink-2'">
                    @if (a.origin.type === 'manual') {
                      Manual · <span class="font-mono text-[13px]">{{ a.origin.key_id }}</span>
                    } @else {
                      Regla <span class="font-mono text-[13px]">{{ a.origin.rule_id }}</span>
                    }
                  </td>
                  <td [class]="td">
                    <app-status [tone]="status(a).tone" [label]="statusText(a)" />
                    @if (a.last_error && (a.status === 'failed' || a.status === 'skipped')) {
                      <div class="text-xs text-muted">{{ a.last_error }}</div>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </app-section>
  `,
})
export class JiraActionsComponent {
  private readonly tasksApi = inject(TasksService);
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);

  readonly taskKey = input.required<string>();

  protected readonly th = TH;
  protected readonly td = TD;
  protected readonly selectClass = SELECT;
  protected readonly selected = signal('');
  protected readonly comment = signal('');
  protected readonly sending = signal(false);

  protected readonly transitions = rxResource({
    params: () => this.taskKey(),
    stream: ({ params }) =>
      this.api.get<AvailableTransition[]>('taskTransitions', {
        params: { taskKey: params },
        context: new HttpContext().set(SILENT_ERRORS, true),
      }),
  });

  protected readonly transitionsError = computed(() => {
    const err = this.transitions.error();
    if (!err) return null;
    return describeHttpError((err as { cause?: unknown }).cause ?? err);
  });

  protected readonly actions = rxResource({
    params: () => this.taskKey(),
    stream: ({ params }) => this.tasksApi.actions(params, true),
  });

  protected readonly sorted = computed(() =>
    [...(this.actions.value() ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at)),
  );

  protected describe(a: OutboxAction): string {
    return describeTaskAction(a.action);
  }

  protected status(a: OutboxAction): { label: string; tone: Tone } {
    return STATUS[a.status] ?? { label: a.status, tone: 'muted' };
  }

  protected statusText(a: OutboxAction): string {
    const s = this.status(a).label;
    return a.status === 'failed' && a.attempts > 1 ? `${s} · ${a.attempts} intentos` : s;
  }

  protected apply(e: Event): void {
    e.preventDefault();
    const t = (this.transitions.value() ?? []).find((x) => x.id === this.selected());
    if (!t || this.sending()) return;
    const comment = this.comment().trim();
    this.sending.set(true);
    this.tasksApi
      .enqueueAction(this.taskKey(), {
        action: { kind: 'transition', transition_id: t.id, to_status: t.to_status, ...(comment ? { comment } : {}) },
        idempotency_key: crypto.randomUUID(),
      })
      .subscribe({
        next: () => {
          this.sending.set(false);
          this.selected.set('');
          this.comment.set('');
          this.toast.success('Acción enviada a la cola', { description: `Transición → ${t.to_status}` });
          this.actions.reload();
        },
        error: () => this.sending.set(false),
      });
  }
}
