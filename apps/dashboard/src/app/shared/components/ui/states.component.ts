import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { ZardSkeletonComponent } from '@/shared/components/skeleton';

/** Filas de carga (skeleton) con la misma regla fina que las tablas. */
@Component({
  selector: 'app-loading',
  imports: [ZardSkeletonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div role="status" aria-live="polite">
      <span class="sr-only">{{ label() }}</span>
      @for (r of rowsArr(); track $index) {
        <div class="flex items-center gap-4 border-t border-rule py-4">
          <z-skeleton class="h-3.5 w-1/4" />
          <z-skeleton class="h-3.5 flex-1" />
          <z-skeleton class="h-3.5 w-16" />
        </div>
      }
    </div>
  `,
})
export class LoadingComponent {
  readonly rows = input(4);
  readonly label = input('Cargando…');
  protected rowsArr(): number[] {
    return Array.from({ length: this.rows() });
  }
}

/** Estado vacío o de error: texto, sin cajas. */
@Component({
  selector: 'app-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="border-t border-rule py-6 text-[15px]" [attr.role]="kind() === 'error' ? 'alert' : null">
      <p class="m-0" [class.text-critical]="kind() === 'error'" [class.text-ink-2]="kind() !== 'error'">{{ message() }}</p>
      @if (detail()) {
        <p class="m-0 mt-1 text-[13px] text-muted">{{ detail() }}</p>
      }
      @if (kind() === 'error') {
        <button type="button" class="mt-2 cursor-pointer py-2 text-sm text-accent hover:text-accent-hover" (click)="retry.emit()">
          Reintentar
        </button>
      }
      <ng-content />
    </div>
  `,
})
export class StateComponent {
  readonly kind = input<'empty' | 'error'>('empty');
  readonly message = input.required<string>();
  readonly detail = input<string | null>(null);
  readonly retry = output<void>();
}
