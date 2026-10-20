import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';

import { ToastService } from '@/shared/services/toast.service';

/** Botón de texto "Copiar" (copia al portapapeles; nunca registra el contenido). */
@Component({
  selector: 'app-copy',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button
    type="button"
    class="cursor-pointer py-2 text-sm text-accent hover:text-accent-hover"
    [attr.aria-label]="ariaLabel() ?? label()"
    (click)="copy()"
  >{{ copied() ? 'Copiado' : label() }}</button><span class="sr-only" aria-live="polite">{{ copied() ? 'Copiado al portapapeles' : '' }}</span>`,
})
export class CopyButtonComponent {
  private readonly toast = inject(ToastService);
  readonly text = input.required<string>();
  readonly label = input('Copiar');
  readonly ariaLabel = input<string | null>(null);
  protected readonly copied = signal(false);

  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.text());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      this.toast.error('No se pudo copiar', { description: 'Selecciona el texto y cópialo a mano.' });
    }
  }
}
