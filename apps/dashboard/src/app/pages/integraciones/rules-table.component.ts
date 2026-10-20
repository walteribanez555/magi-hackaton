import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import type { AutomationRule, AutomationRuleUpsert, RuleTrigger } from '@magicode/contracts';

import { RULE_TRIGGER_LABEL, TASK_CATEGORY_LABEL, describeTaskAction } from '@/shared/labels/labels';
import { IntegracionesData, errorText } from './integraciones.data';
import { BTN_LINK, BTN_PRIMARY, BTN_QUIET, FIELD, LABEL } from './integraciones.ui';

const TRIGGERS = Object.keys(RULE_TRIGGER_LABEL) as RuleTrigger[];

function toUpsert(r: AutomationRule, enabled = r.enabled): AutomationRuleUpsert {
  return { name: r.name, enabled, trigger: r.trigger, when: r.when ?? {}, action: r.action };
}

/** Reglas automáticas de una integración Jira: listar, activar/desactivar, borrar y agregar. */
@Component({
  selector: 'app-rules-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mt-12 block' },
  template: `
    <section aria-labelledby="h-rules">
      <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-ink pb-2.5">
        <h2 id="h-rules" class="m-0 text-lg font-semibold">Reglas automáticas</h2>
        <span class="text-[13px] text-muted">Qué escribe MagiCode en Jira y cuándo</span>
      </div>
      @if (rules.value(); as list) {
        <div class="overflow-x-auto">
          <table class="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr class="text-xs text-muted">
                <th scope="col" class="py-2.5 pr-3 text-left font-medium">Regla</th>
                <th scope="col" class="px-3 py-2.5 text-left font-medium">Cuándo</th>
                <th scope="col" class="px-3 py-2.5 text-left font-medium">Acción</th>
                <th scope="col" class="px-3 py-2.5 text-left font-medium">Estado</th>
                <th scope="col" class="py-2.5 pl-3 text-right font-medium"><span class="sr-only">Borrar</span></th>
              </tr>
            </thead>
            <tbody>
              @for (r of list; track r.rule_id) {
                <tr class="border-t border-rule align-top">
                  <td class="py-2.5 pr-3">{{ r.name }}</td>
                  <td class="px-3 py-2.5 text-ink-2">{{ when(r) }}</td>
                  <td class="px-3 py-2.5 text-ink-2">{{ describe(r) }}</td>
                  <td class="px-3 py-1">
                    <label class="flex min-h-11 cursor-pointer items-center gap-2">
                      <input type="checkbox" [checked]="r.enabled" [disabled]="busy() === r.rule_id" (change)="toggle(r, $any($event.target).checked)" />
                      {{ r.enabled ? 'Activa' : 'Inactiva' }}
                      <span class="sr-only">: {{ r.name }}</span>
                    </label>
                  </td>
                  <td class="py-0.5 pl-3 text-right whitespace-nowrap">
                    @if (confirming() === r.rule_id) {
                      <span class="text-[13px] text-ink-2">¿Borrar?</span>
                      <button type="button" class="ml-3 cursor-pointer py-3 text-sm text-critical" (click)="remove(r)">Sí, borrar</button>
                      <button type="button" class="ml-3" [class]="quiet" (click)="confirming.set(null)">No</button>
                    } @else {
                      <button type="button" [class]="quiet" [disabled]="busy() === r.rule_id" (click)="confirming.set(r.rule_id)">
                        Borrar<span class="sr-only"> {{ r.name }}</span>
                      </button>
                    }
                  </td>
                </tr>
              } @empty {
                <tr class="border-t border-rule"><td colspan="5" class="py-3 text-ink-2">Sin reglas.</td></tr>
              }
            </tbody>
          </table>
        </div>
      } @else if (rules.isLoading()) {
        <p class="m-0 py-4 text-sm text-muted" role="status">Cargando reglas…</p>
      } @else if (rules.error()) {
        <p class="m-0 py-4 text-sm text-critical" role="alert">
          No se pudieron leer las reglas. <button type="button" [class]="link" (click)="rules.reload()">Reintentar</button>
        </p>
      }

      @if (adding()) {
        <form class="mt-5 flex max-w-[460px] flex-col gap-3.5 border-t border-ink pt-4" (submit)="$event.preventDefault(); add()">
          <h3 class="m-0 text-[15px] font-semibold">Nueva regla</h3>
          <label [class]="label">Nombre<input [class]="field" class="font-sans" type="text" [value]="name()" (input)="name.set($any($event.target).value)" /></label>
          <label [class]="label">
            Cuándo
            <select [class]="field" class="font-sans" (change)="trigger.set($any($event.target).value)">
              @for (t of triggers; track t) {
                <option [value]="t" [selected]="t === trigger()">Cuando {{ triggerLabel[t] }}</option>
              }
            </select>
          </label>
          <label [class]="label">
            Acción
            <select [class]="field" class="font-sans" (change)="kind.set($any($event.target).value)">
              <option value="transition" [selected]="kind() === 'transition'">Mover la tarea a un estado</option>
              <option value="comment" [selected]="kind() === 'comment'">Comentar en la tarea</option>
            </select>
          </label>
          <label [class]="label">
            {{ kind() === 'transition' ? 'Estado destino' : commentHint }}
            <input [class]="field" class="font-sans" type="text" [value]="text()" (input)="text.set($any($event.target).value)" />
          </label>
          <div class="flex flex-wrap items-center gap-x-6">
            <button type="submit" [class]="primary" [disabled]="busy() === 'new' || !name().trim() || !text().trim()">Agregar regla</button>
            <button type="button" [class]="quiet" (click)="adding.set(false)">Cancelar</button>
          </div>
        </form>
      } @else {
        <div class="border-t border-rule pt-1"><button type="button" [class]="link" (click)="adding.set(true)">Agregar regla</button></div>
      }
      @if (error()) {
        <p class="m-0 mt-2 text-[13px] text-critical" role="alert">{{ error() }}</p>
      }
    </section>
  `,
})
export class RulesTableComponent {
  private readonly data = inject(IntegracionesData);

  readonly integrationId = input.required<string>();

  protected readonly field = FIELD;
  protected readonly label = LABEL;
  protected readonly primary = BTN_PRIMARY;
  protected readonly link = BTN_LINK;
  protected readonly quiet = BTN_QUIET;
  protected readonly triggers = TRIGGERS;
  protected readonly triggerLabel = RULE_TRIGGER_LABEL;
  protected readonly commentHint = 'Comentario (admite {{task_key}}, {{pr_url}}, {{sha}}…)';

  protected readonly rules = rxResource<AutomationRule[], string>({
    params: () => this.integrationId(),
    stream: ({ params }) => this.data.rules(params),
  });

  protected readonly busy = signal<string | null>(null);
  protected readonly confirming = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly adding = signal(false);
  protected readonly name = signal('');
  protected readonly trigger = signal<RuleTrigger>('pr.opened');
  protected readonly kind = signal<'transition' | 'comment'>('transition');
  protected readonly text = signal('');

  protected when(r: AutomationRule): string {
    const w = r.when ?? {};
    const extra = [
      w.environment ? `en ${w.environment}` : null,
      w.target_branch ? `hacia ${w.target_branch}` : null,
      w.from_status_category ? `si está «${TASK_CATEGORY_LABEL[w.from_status_category]}»` : null,
    ].filter(Boolean);
    return `Cuando ${RULE_TRIGGER_LABEL[r.trigger] ?? r.trigger}${extra.length ? ' ' + extra.join(', ') : ''}`;
  }

  protected describe(r: AutomationRule): string {
    return describeTaskAction(r.action);
  }

  private patch(updated: AutomationRule): void {
    this.rules.update((list) => (list ?? []).map((x) => (x.rule_id === updated.rule_id ? updated : x)));
  }

  protected toggle(r: AutomationRule, enabled: boolean): void {
    this.busy.set(r.rule_id);
    this.error.set(null);
    this.data.updateRule(this.integrationId(), r.rule_id, toUpsert(r, enabled)).subscribe({
      next: (u) => {
        this.busy.set(null);
        this.patch({ ...r, ...u, enabled: u?.enabled ?? enabled });
      },
      error: (e: unknown) => {
        this.busy.set(null);
        this.error.set(errorText(e));
        this.rules.reload();
      },
    });
  }

  protected remove(r: AutomationRule): void {
    this.busy.set(r.rule_id);
    this.confirming.set(null);
    this.error.set(null);
    this.data.deleteRule(this.integrationId(), r.rule_id).subscribe({
      next: () => {
        this.busy.set(null);
        this.rules.update((list) => (list ?? []).filter((x) => x.rule_id !== r.rule_id));
      },
      error: (e: unknown) => {
        this.busy.set(null);
        this.error.set(errorText(e));
      },
    });
  }

  protected add(): void {
    const text = this.text().trim();
    const body: AutomationRuleUpsert = {
      name: this.name().trim(),
      enabled: true,
      trigger: this.trigger(),
      when: {},
      action: this.kind() === 'transition' ? { kind: 'transition', to_status: text } : { kind: 'comment', body_markdown: text },
    };
    this.busy.set('new');
    this.error.set(null);
    this.data.createRule(this.integrationId(), body).subscribe({
      next: () => {
        this.busy.set(null);
        this.adding.set(false);
        this.name.set('');
        this.text.set('');
        this.rules.reload();
      },
      error: (e: unknown) => {
        this.busy.set(null);
        this.error.set(errorText(e));
      },
    });
  }
}
