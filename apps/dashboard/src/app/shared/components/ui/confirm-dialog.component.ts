import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injectable,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
}

/** `await confirm.ask({...})` → true/false. Usa <dialog> nativo (foco y Escape del navegador). */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly current = signal<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);

  ask(opts: ConfirmOptions): Promise<boolean> {
    this.current()?.resolve(false);
    return new Promise((resolve) => this.current.set({ ...opts, resolve }));
  }

  close(result: boolean): void {
    const c = this.current();
    this.current.set(null);
    c?.resolve(result);
  }
}

@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dlg
      class="m-auto w-[min(440px,calc(100vw-32px))] border border-rule bg-bg p-6 text-ink backdrop:bg-black/30"
      aria-labelledby="confirm-title"
      (close)="svc.close(false)"
    >
      @if (svc.current(); as c) {
        <h2 id="confirm-title" class="m-0 text-lg font-semibold">{{ c.title }}</h2>
        @if (c.message) {
          <p class="m-0 mt-2 text-[15px] text-ink-2">{{ c.message }}</p>
        }
        <div class="mt-6 flex flex-wrap justify-end gap-3">
          <button type="button" class="min-h-11 cursor-pointer px-4 text-[15px] text-ink-2 hover:text-ink" (click)="svc.close(false)">
            {{ c.cancelText ?? 'Cancelar' }}
          </button>
          <button
            type="button"
            class="min-h-11 cursor-pointer rounded-[4px] px-5 text-[15px] font-semibold"
            [class]="c.destructive ? 'bg-critical text-white' : 'bg-ink text-on-ink'"
            (click)="svc.close(true)"
          >
            {{ c.confirmText ?? 'Confirmar' }}
          </button>
        </div>
      }
    </dialog>
  `,
})
export class ConfirmDialogComponent {
  protected readonly svc = inject(ConfirmService);
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  constructor() {
    effect(() => {
      const el = this.dlg().nativeElement;
      const open = !!this.svc.current();
      if (open && !el.open) el.showModal?.();
      if (!open && el.open) el.close();
    });
  }
}
