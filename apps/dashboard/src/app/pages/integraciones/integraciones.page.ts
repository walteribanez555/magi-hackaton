import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import type { Integration } from '@magicode/contracts';

import { ScopeService } from '@/core/data/scope.service';
import { CopyButtonComponent } from '@/shared/components/ui/copy-button.component';
import { StatusMarkComponent, type Tone } from '@/shared/components/ui/status-mark.component';
import { PROVIDER_LABEL } from '@/shared/labels/labels';
import { formatAgo } from '@/shared/utils/format';
import { CreateIntegrationComponent } from './create-integration.component';
import { HealthPanelComponent } from './health-panel.component';
import { IntegracionesData } from './integraciones.data';
import { BTN_LINK, BTN_PRIMARY, BTN_QUIET } from './integraciones.ui';
import { TestPanelComponent } from './test-panel.component';

const STATUS: Record<Integration['status'], { tone: Tone; label: string }> = {
  active: { tone: 'info', label: 'Activa' },
  pending: { tone: 'warn', label: 'Esperando primer evento' },
  disabled: { tone: 'muted', label: 'Desactivada' },
};

@Component({
  selector: 'app-integraciones-page',
  imports: [StatusMarkComponent, CopyButtonComponent, CreateIntegrationComponent, HealthPanelComponent, TestPanelComponent],
  providers: [IntegracionesData],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="m-0 text-[34px] leading-tight font-semibold tracking-[-0.02em]">Integraciones</h1>
    <p class="m-0 mt-2.5 max-w-[780px] text-base text-ink-2">
      Un proyecto necesita las dos: el repositorio confirma commits, pull requests y despliegues; el gestor de tareas da el contexto de
      cada cambio. Comprobar envía un evento real de ida y vuelta.
    </p>

    <section aria-labelledby="h-integrations" class="mt-10">
      <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-ink pb-2.5">
        <h2 id="h-integrations" class="m-0 text-lg font-semibold">Webhooks del proyecto</h2>
        <span class="text-[13px] text-muted">Proyecto <span class="font-mono">{{ projectId() }}</span></span>
      </div>

      @if (list.value(); as items) {
        <div class="overflow-x-auto">
          <table class="w-full min-w-[860px] border-collapse text-sm">
            <thead>
              <tr class="text-xs text-muted">
                <th scope="col" class="py-2.5 pr-3 text-left font-medium">Proveedor</th>
                <th scope="col" class="px-3 py-2.5 text-left font-medium">Destino</th>
                <th scope="col" class="px-3 py-2.5 text-left font-medium">Estado</th>
                <th scope="col" class="px-3 py-2.5 text-left font-medium">Última entrega</th>
                <th scope="col" class="px-3 py-2.5 text-left font-medium">URL del webhook</th>
                <th scope="col" class="py-2.5 pl-3 text-right font-medium"><span class="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              @for (i of items; track i.integration_id) {
                <tr class="border-t border-rule align-top" [class.bg-selected]="selected()?.id === i.integration_id">
                  <td class="py-2.5 pr-3 font-medium">{{ providerLabel[i.provider] ?? i.provider }}</td>
                  <td class="px-3 py-2.5 font-mono text-[13px]">{{ target(i) }}</td>
                  <td class="px-3 py-2.5"><app-status [tone]="status[i.status].tone" [label]="status[i.status].label" /></td>
                  <td class="px-3 py-2.5 text-ink-2">{{ ago(i.last_delivery_at) }}</td>
                  <td class="px-3 py-2.5">
                    <span class="font-mono text-xs break-all text-ink-2">{{ i.webhook_url }}</span>
                    <app-copy class="ml-2" [text]="i.webhook_url" ariaLabel="Copiar URL del webhook" />
                  </td>
                  <td class="py-0.5 pl-3 text-right whitespace-nowrap">
                    <button type="button" [class]="link" (click)="open(i, 'health')">Comprobar</button>
                    <button type="button" class="ml-5" [class]="link" (click)="open(i, 'test')">Probar</button>
                  </td>
                </tr>
              } @empty {
                <tr class="border-t border-rule">
                  <td colspan="6" class="py-4 text-ink-2">
                    <span class="mr-2 inline-block size-2 border border-faint align-[1px]" aria-hidden="true"></span>Sin configurar: este proyecto
                    aún no tiene webhooks. Crea la integración del repositorio y la del gestor de tareas.
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      } @else if (list.isLoading()) {
        <p class="m-0 py-4 text-sm text-muted" role="status">Cargando integraciones…</p>
      } @else if (list.error()) {
        <p class="m-0 py-4 text-sm text-critical" role="alert">
          No se pudieron leer las integraciones.
          <button type="button" [class]="link" (click)="list.reload()">Reintentar</button>
        </p>
      }

      <div class="flex flex-wrap items-center gap-x-6 border-t border-rule pt-3.5">
        @if (!creating()) {
          <button type="button" [class]="primary" (click)="creating.set(true)">Crear integración</button>
        }
        <button type="button" [class]="quiet" [disabled]="list.isLoading()" (click)="list.reload()">Actualizar lista</button>
      </div>

      @if (creating()) {
        <app-create-integration [projectId]="projectId()" [repository]="defaultRepo()" (createdIntegration)="list.reload()" (done)="creating.set(false)" />
      }
    </section>

    @if (selectedIntegration(); as s) {
      <section aria-labelledby="h-detail" class="mt-12">
        <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-ink pb-2.5">
          <h2 id="h-detail" class="m-0 text-lg font-semibold">
            {{ providerLabel[s.provider] ?? s.provider }}
            <span class="ml-2 font-mono text-[13px] font-normal text-ink-2">{{ target(s) }}</span>
          </h2>
          <span class="flex gap-x-6">
            <button type="button" [class]="link" [attr.aria-pressed]="selected()?.view === 'health'" (click)="open(s, 'health')">Estado</button>
            <button type="button" [class]="link" [attr.aria-pressed]="selected()?.view === 'test'" (click)="open(s, 'test')">Comprobar ahora</button>
            <button type="button" [class]="quiet" (click)="selected.set(null)">Cerrar</button>
          </span>
        </div>
        @if (selected()?.view === 'test') {
          <app-test-panel [integrationId]="s.integration_id" [provider]="s.provider" (closed)="open(s, 'health')" (finished)="list.reload()" />
        } @else {
          <app-health-panel [integrationId]="s.integration_id" />
        }
      </section>
    }

    <footer class="mt-12 flex flex-wrap gap-x-7 gap-y-2 border-t border-rule pt-3.5 text-xs text-muted">
      <app-status tone="info" label="Pasa" />
      <app-status tone="warn" label="Advertencia" />
      <app-status tone="fail" label="Falla" />
      <app-status tone="muted" label="Omitido o pendiente" />
    </footer>
  `,
})
export class IntegracionesPage {
  private readonly data = inject(IntegracionesData);
  private readonly scope = inject(ScopeService);

  protected readonly providerLabel: Record<string, string | undefined> = PROVIDER_LABEL;
  protected readonly status = STATUS;
  protected readonly link = BTN_LINK;
  protected readonly primary = BTN_PRIMARY;
  protected readonly quiet = BTN_QUIET;

  protected readonly projectId = computed(() => this.scope.projectId() ?? 'magicode-demo');
  protected readonly defaultRepo = computed(() => this.scope.project()?.repositories[0] ?? '');

  protected readonly list = rxResource<Integration[], string>({
    params: () => this.projectId(),
    stream: ({ params }) => this.data.integrations(params),
  });

  protected readonly creating = signal(false);
  protected readonly selected = signal<{ id: string; view: 'health' | 'test' } | null>(null);
  protected readonly selectedIntegration = computed(() => {
    const s = this.selected();
    return s ? ((this.list.value() ?? []).find((i) => i.integration_id === s.id) ?? null) : null;
  });

  protected open(i: Integration, view: 'health' | 'test'): void {
    this.selected.set({ id: i.integration_id, view });
  }

  protected target(i: Integration): string {
    return i.repository ?? i.task_project_keys?.join(', ') ?? '—';
  }

  protected ago(v: string | null): string {
    return v ? formatAgo(v) : 'Nunca';
  }
}
