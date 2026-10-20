import { CdkMenu, CdkMenuItemRadio, CdkMenuTrigger } from '@angular/cdk/menu';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

export interface ScopeOption {
  id: string;
  label: string;
  hint?: string;
}

/**
 * Selector de ámbito como botón de texto "Proyecto magicode-demo ▾" (diseño), con menú
 * accesible de CDK (role=menu, menuitemradio, teclado y foco gestionados).
 */
@Component({
  selector: 'app-scope-menu',
  imports: [CdkMenuTrigger, CdkMenu, CdkMenuItemRadio],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      [cdkMenuTriggerFor]="menu"
      class="cursor-pointer py-2 text-left text-sm text-muted hover:text-ink aria-expanded:text-ink"
      [attr.aria-label]="label() + ': ' + (valueLabel() || placeholder())"
    >
      {{ label() }}
      <span class="font-medium text-ink" [class.font-mono]="mono()" [class.text-[13px]]="mono()">{{ valueLabel() || placeholder() }}</span>
      <span aria-hidden="true">▾</span>
    </button>
    <ng-template #menu>
      <div
        cdkMenu
        class="z-50 mt-1 max-h-80 min-w-56 overflow-y-auto border border-rule bg-bg py-1 text-sm shadow-[0_6px_24px_rgba(0,0,0,0.08)]"
      >
        @for (o of options(); track o.id) {
          <button
            type="button"
            cdkMenuItemRadio
            [cdkMenuItemChecked]="o.id === value()"
            (cdkMenuItemTriggered)="select.emit(o.id)"
            class="flex w-full cursor-pointer items-baseline justify-between gap-6 px-3 py-2 text-left text-ink hover:bg-track focus:bg-track focus:outline-none"
          >
            <span [class.font-semibold]="o.id === value()">{{ o.label }}</span>
            @if (o.hint) {
              <span class="text-xs text-muted">{{ o.hint }}</span>
            }
          </button>
        } @empty {
          <p class="m-0 px-3 py-2 text-muted">Sin opciones</p>
        }
      </div>
    </ng-template>
  `,
})
export class ScopeMenuComponent {
  readonly label = input.required<string>();
  readonly value = input<string | null>(null);
  readonly valueLabel = input<string | null>(null);
  readonly placeholder = input('Todas');
  readonly options = input<ScopeOption[]>([]);
  readonly mono = input(false);
  readonly select = output<string>();
}
