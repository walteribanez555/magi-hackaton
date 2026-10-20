import { inject, Injectable } from '@angular/core';

import { ZardSonnerService } from '@/shared/components/sonner/sonner.service';

export interface ToastOptions {
  description?: string;
  duration?: number;
  action?: { label: string; onClick: () => void };
}

/** Servicio de toasts de la app (mismo patrón que coolfix-v2): envuelve ZardSonnerService. */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly sonner = inject(ZardSonnerService);

  success(message: string, opts?: ToastOptions): void {
    this.sonner.success(message, this.map(opts));
  }

  error(message: string, opts?: ToastOptions): void {
    this.sonner.error(message, this.map(opts));
  }

  warning(message: string, opts?: ToastOptions): void {
    this.sonner.warning(message, this.map(opts));
  }

  info(message: string, opts?: ToastOptions): void {
    this.sonner.info(message, this.map(opts));
  }

  dismiss(id?: string | number): void {
    this.sonner.dismiss(id);
  }

  private map(opts?: ToastOptions) {
    if (!opts) return undefined;
    return {
      description: opts.description,
      duration: opts.duration,
      action: opts.action ? { label: opts.action.label, onClick: opts.action.onClick } : undefined,
    };
  }
}
