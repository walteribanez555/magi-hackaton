import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import type { CheckResult, IntegrationHealth } from '@magicode/contracts';
import { of } from 'rxjs';

import { StatusMarkComponent } from '@/shared/components/ui/status-mark.component';
import { CHECK_ACTION_LABEL, CHECK_LABEL, CHECK_STATUS_LABEL, HEALTH_LABEL } from '@/shared/labels/labels';
import { formatAgo } from '@/shared/utils/format';
import { IntegracionesData, errorText } from './integraciones.data';
import { BTN_LINK, BTN_QUIET, CHECK_TONE, HEALTH_TONE } from './integraciones.ui';

/** Salud de una integración: estado, contadores 24 h y tabla de comprobaciones. */
@Component({
  selector: 'app-health-panel',
  imports: [StatusMarkComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (health.value(); as h) {
      <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 py-3.5">
        <app-status class="text-sm" [tone]="healthTone[h.status]" [label]="healthLabel[h.status]" [emphasize]="true" />
        <div class="text-[13px] text-muted">{{ counters() }}</div>
      </div>
      @if (h.last_error) {
        <p class="m-0 pb-3 text-[13px] text-critical">{{ h.last_error }}</p>
      }
      <div class="overflow-x-auto">
        <table class="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr class="text-xs text-muted">
              <th scope="col" class="w-[26%] py-2.5 pr-3 text-left font-medium">Comprobación</th>
              <th scope="col" class="w-[14%] px-3 py-2.5 text-left font-medium">Resultado</th>
              <th scope="col" class="py-2.5 pl-3 text-left font-medium">Mensaje</th>
            </tr>
          </thead>
          <tbody>
            @for (c of h.checks; track c.id) {
              <tr class="border-t border-rule align-top">
                <td class="py-2.5 pr-3">{{ checkLabel[c.id] ?? c.id }}</td>
                <td class="px-3 py-2.5"><app-status [tone]="checkTone[c.status]" [label]="checkStatus[c.status]" /></td>
                <td class="py-2.5 pl-3 text-ink-2">
                  {{ c.message }}
                  @if (actionFor(c); as a) {
                    <span class="block">
                      <button type="button" [class]="link" [disabled]="busy()" (click)="act(a)">{{ actionLabel[a] }}</button>
                    </span>
                  }
                </td>
              </tr>
            } @empty {
              <tr class="border-t border-rule"><td colspan="3" class="py-2.5 text-muted">Sin comprobaciones.</td></tr>
            }
          </tbody>
        </table>
      </div>
    } @else if (health.isLoading()) {
      <p class="m-0 border-t border-rule py-4 text-sm text-muted" role="status">Comprobando…</p>
    } @else if (health.error()) {
      <p class="m-0 border-t border-rule py-4 text-sm text-critical" role="alert">No se pudo leer el estado: {{ err() }}</p>
    }
    <div class="flex flex-wrap gap-x-6 border-t border-rule pt-1">
      <button type="button" [class]="link" [disabled]="health.isLoading()" (click)="health.reload()">
        {{ health.isLoading() ? 'Actualizando…' : 'Actualizar estado' }}
      </button>
    </div>
    @if (notice()) {
      <p class="m-0 text-[13px] text-ink-2" role="status">{{ notice() }}</p>
    }
  `,
})
export class HealthPanelComponent {
  private readonly data = inject(IntegracionesData);

  readonly integrationId = input.required<string>();

  protected readonly healthTone = HEALTH_TONE;
  protected readonly healthLabel = HEALTH_LABEL;
  protected readonly checkTone = CHECK_TONE;
  protected readonly checkStatus = CHECK_STATUS_LABEL;
  protected readonly checkLabel: Record<string, string | undefined> = CHECK_LABEL;
  protected readonly actionLabel = CHECK_ACTION_LABEL;
  protected readonly link = BTN_LINK;
  protected readonly quiet = BTN_QUIET;

  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);

  protected readonly health = rxResource<IntegrationHealth | null, string>({
    params: () => this.integrationId(),
    stream: ({ params }) => (params ? this.data.health(params) : of(null)),
  });

  protected readonly err = computed(() => errorText(this.health.error()));

  protected readonly counters = computed(() => {
    const h = this.health.value();
    if (!h) return '';
    const d = h.deliveries_24h;
    const parts = [
      `24 h: ${d.accepted} aceptadas`,
      `${d.duplicate} duplicadas`,
      `${d.ignored} ignoradas`,
      `${d.rejected_signature} con firma inválida`,
    ];
    if (d.rejected_other) parts.push(`${d.rejected_other} rechazadas por otro motivo`);
    parts.push(h.last_delivery_at ? `última entrega ${formatAgo(h.last_delivery_at)}` : 'sin entregas');
    return parts.join(' · ');
  });

  /** Solo las acciones que esta vista resuelve en línea. */
  protected actionFor(c: CheckResult): 'register_webhook' | 'rotate_secret' | null {
    return c.action === 'register_webhook' || c.action === 'rotate_secret' ? c.action : null;
  }

  protected act(a: 'register_webhook' | 'rotate_secret'): void {
    const id = this.integrationId();
    this.busy.set(true);
    this.notice.set(null);
    const done = (msg: string) => {
      this.busy.set(false);
      this.notice.set(msg);
      this.health.reload();
    };
    const fail = (e: unknown) => {
      this.busy.set(false);
      this.notice.set(errorText(e));
    };
    if (a === 'register_webhook') {
      this.data.registerWebhook(id).subscribe({
        next: (r) => done(r.created ? `Webhook ${r.provider_hook_id} creado en el proveedor.` : `Webhook ${r.provider_hook_id} actualizado.`),
        error: fail,
      });
    } else {
      this.data.rotateSecret(id).subscribe({
        next: (r) => done(`Nuevo secreto (no se volverá a mostrar): ${r.webhook_secret}`),
        error: fail,
      });
    }
  }
}
