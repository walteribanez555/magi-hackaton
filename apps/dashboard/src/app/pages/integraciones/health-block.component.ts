import { ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal, output, signal } from '@angular/core';
import type { CheckResult, Integration, IntegrationHealth } from '@magicode/contracts';

import { CopyButtonComponent } from '@/shared/components/ui/copy-button.component';
import { StatusMarkComponent } from '@/shared/components/ui/status-mark.component';
import { CHECK_ACTION_LABEL, CHECK_LABEL, CHECK_STATUS_LABEL, HEALTH_LABEL, PROVIDER_LABEL } from '@/shared/labels/labels';
import { formatAgo } from '@/shared/utils/format';
import { CreateIntegrationComponent } from './create-integration.component';
import { CredentialsFormComponent } from './credentials-form.component';
import { IntegracionesData, errorText } from './integraciones.data';
import { BTN_LINK, BTN_PRIMARY, BTN_QUIET, CHECK_TONE, HEALTH_TONE } from './integraciones.ui';
import { TestPanelComponent } from './test-panel.component';

type Action = NonNullable<CheckResult['action']>;
type Panel = 'create' | 'credentials' | 'test' | null;
const ORDER: Action[] = ['create_integration', 'run_test', 'register_webhook', 'add_credentials', 'rotate_secret'];

/** Bloque "Repositorio · obligatorio" / "Tareas · obligatorio" de un repositorio. */
@Component({
  selector: 'app-health-block',
  imports: [StatusMarkComponent, CopyButtonComponent, CreateIntegrationComponent, CredentialsFormComponent, TestPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mt-12 block' },
  template: `
    @let h = current();
    <section [attr.aria-labelledby]="'h-' + role()" [id]="role() === 'tasks' ? 'tareas' : 'repositorio'">
      <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-ink pb-2.5">
        <h2 [id]="'h-' + role()" class="m-0 text-lg font-semibold">
          {{ role() === 'tasks' ? 'Tareas' : 'Repositorio' }} <span class="font-normal text-muted">· obligatorio</span>
        </h2>
        <app-status class="text-sm" [tone]="healthTone[h.status]" [label]="healthLabel[h.status]" [emphasize]="true" />
      </div>

      <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 py-3.5">
        <div>
          @if (h.provider) {
            <span class="font-medium">{{ providerLabel[h.provider] ?? h.provider }}</span>
            @if (target()) {
              <span class="ml-2 font-mono text-[13px] text-ink-2">{{ target() }}</span>
            }
          } @else {
            <span class="text-ink-2">{{ role() === 'tasks' ? 'Sin gestor de tareas conectado' : 'Sin integración de repositorio' }}</span>
          }
        </div>
        @if (h.integration_id) {
          <div class="text-[13px] text-muted">{{ counters() }}</div>
        }
      </div>

      @if (integration()?.webhook_url; as url) {
        <div class="flex flex-wrap items-baseline gap-x-3 border-t border-rule py-1.5 text-[13px]">
          <span class="text-ink-2">URL del webhook</span>
          <span class="font-mono break-all">{{ url }}</span>
          <app-copy [text]="url" ariaLabel="Copiar URL del webhook" />
        </div>
      }
      @if (h.last_error) {
        <p class="m-0 border-t border-rule py-2.5 text-[13px] text-critical">{{ h.last_error }}</p>
      }

      <div class="overflow-x-auto">
        <table class="w-full min-w-[760px] border-collapse text-sm">
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
                <td class="py-2.5 pl-3 text-ink-2">{{ c.message }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <div class="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-rule pt-3.5">
        @for (a of actions(); track a; let first = $first) {
          <button
            type="button"
            [class]="first && (a === 'create_integration' || a === 'run_test') ? primary : a === 'rotate_secret' ? quiet : link"
            [disabled]="busy()"
            [attr.aria-expanded]="panelFor(a) ? panel() === panelFor(a) : null"
            (click)="act(a)"
          >
            {{ a === 'register_webhook' && busy() ? 'Registrando…' : actionLabel[a] }}
          </button>
        }
        @if (h.integration_id) {
          <button type="button" [class]="link" [disabled]="refreshing()" (click)="refresh()">
            {{ refreshing() ? 'Actualizando…' : 'Actualizar estado' }}
          </button>
        }
      </div>

      @if (notice(); as n) {
        <p class="m-0 mt-2 text-[13px]" [class.text-critical]="n.error" [class.text-ink-2]="!n.error" [attr.role]="n.error ? 'alert' : 'status'">
          {{ n.text }}
        </p>
      }
      @if (secret(); as s) {
        <div class="mt-2 flex flex-wrap items-baseline gap-x-3 text-[13px]" role="status">
          <span class="text-estimated">Nuevo secreto, no se volverá a mostrar:</span>
          <span class="font-mono break-all">{{ s }}</span>
          <app-copy [text]="s" ariaLabel="Copiar secreto" />
        </div>
      }

      @switch (panel()) {
        @case ('create') {
          <app-create-integration
            [role]="role()"
            [projectId]="projectId()"
            [repository]="repository()"
            (createdIntegration)="changed.emit()"
            (done)="panel.set(null)"
          />
        }
        @case ('credentials') {
          @if (h.integration_id && h.provider) {
            <app-credentials-form
              [integrationId]="h.integration_id"
              [provider]="h.provider"
              (saved)="onCredentialsSaved()"
              (closed)="panel.set(null)"
            />
          }
        }
        @case ('test') {
          @if (h.integration_id) {
            <app-test-panel [integrationId]="h.integration_id" [provider]="h.provider" (closed)="panel.set(null)" (finished)="refresh()" />
          }
        }
      }
    </section>
  `,
})
export class HealthBlockComponent {
  private readonly data = inject(IntegracionesData);

  readonly role = input.required<'repository' | 'tasks'>();
  readonly health = input.required<IntegrationHealth>();
  readonly integration = input<Integration | null>(null);
  readonly repository = input('');
  readonly projectId = input('magicode-demo');
  readonly changed = output<void>();

  protected readonly healthTone = HEALTH_TONE;
  protected readonly healthLabel = HEALTH_LABEL;
  protected readonly checkTone = CHECK_TONE;
  protected readonly checkStatus = CHECK_STATUS_LABEL;
  protected readonly checkLabel: Record<string, string | undefined> = CHECK_LABEL;
  protected readonly actionLabel = CHECK_ACTION_LABEL;
  protected readonly providerLabel: Record<string, string | undefined> = PROVIDER_LABEL;
  protected readonly link = BTN_LINK;
  protected readonly primary = BTN_PRIMARY;
  protected readonly quiet = BTN_QUIET;

  /** salud mostrada: la del readiness, o la recién pedida con "Actualizar estado" */
  protected readonly current = linkedSignal(() => this.health());
  protected readonly panel = signal<Panel>(null);
  protected readonly busy = signal(false);
  protected readonly refreshing = signal(false);
  protected readonly notice = signal<{ text: string; error: boolean } | null>(null);
  protected readonly secret = signal<string | null>(null);

  protected readonly target = computed(() => {
    if (this.role() === 'repository') return this.integration()?.repository ?? this.repository();
    return this.integration()?.task_project_keys?.join(', ') ?? '';
  });

  protected readonly actions = computed<Action[]>(() => {
    const h = this.current();
    const set = new Set<Action>();
    for (const c of h.checks) if (c.action && c.action !== 'open_provider_settings') set.add(c.action);
    if (h.integration_id) {
      set.add('run_test');
      set.add('register_webhook');
      set.add('add_credentials');
      set.add('rotate_secret');
      set.delete('create_integration');
    } else {
      set.clear();
      set.add('create_integration');
    }
    return ORDER.filter((a) => set.has(a));
  });

  protected readonly counters = computed(() => {
    const h = this.current();
    const d = h.deliveries_24h;
    const parts = [`24 h: ${d.accepted} aceptadas`, `${d.duplicate} duplicadas`, `${d.ignored} ignoradas`, `${d.rejected_signature} con firma inválida`];
    if (d.rejected_other) parts.push(`${d.rejected_other} rechazadas por otro motivo`);
    parts.push(h.last_delivery_at ? `última entrega ${formatAgo(h.last_delivery_at)}` : 'sin entregas todavía');
    return parts.join(' · ');
  });

  protected panelFor(a: Action): Panel {
    return a === 'create_integration' ? 'create' : a === 'add_credentials' ? 'credentials' : a === 'run_test' ? 'test' : null;
  }

  protected act(a: Action): void {
    const p = this.panelFor(a);
    if (p) {
      this.panel.set(this.panel() === p ? null : p);
      return;
    }
    const id = this.current().integration_id;
    if (!id) return;
    this.busy.set(true);
    this.notice.set(null);
    const fail = (e: unknown) => {
      this.busy.set(false);
      this.notice.set({ text: errorText(e), error: true });
    };
    if (a === 'register_webhook') {
      this.data.registerWebhook(id).subscribe({
        next: (r) => {
          this.busy.set(false);
          this.notice.set({
            text: `${r.created ? 'Webhook creado' : 'Webhook actualizado'} en el proveedor (hook ${r.provider_hook_id})${r.events.length ? ': ' + r.events.join(', ') : ''}.`,
            error: false,
          });
          this.refresh();
        },
        error: fail,
      });
    } else if (a === 'rotate_secret') {
      if (!confirm('Al rotar el secreto, el webhook actual dejará de validar hasta que pegues el nuevo en el proveedor. ¿Continuar?')) {
        this.busy.set(false);
        return;
      }
      this.data.rotateSecret(id).subscribe({
        next: (r) => {
          this.busy.set(false);
          this.secret.set(r.webhook_secret);
        },
        error: fail,
      });
    }
  }

  protected onCredentialsSaved(): void {
    this.panel.set(null);
    this.notice.set({ text: 'Credenciales guardadas. Ya puedes registrar el webhook automáticamente.', error: false });
    this.refresh();
  }

  protected refresh(): void {
    const id = this.current().integration_id;
    if (!id) return;
    this.refreshing.set(true);
    this.data.health(id).subscribe({
      next: (h) => {
        this.refreshing.set(false);
        this.current.set(h);
      },
      error: (e: unknown) => {
        this.refreshing.set(false);
        this.notice.set({ text: `No se pudo actualizar el estado: ${errorText(e)}`, error: true });
      },
    });
  }
}
