import { ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal, output, signal } from '@angular/core';
import type { IntegrationCreate, IntegrationCreated } from '@magicode/contracts';

import { CopyButtonComponent } from '@/shared/components/ui/copy-button.component';
import { PROVIDER_EVENTS, PROVIDER_LABEL } from '@/shared/labels/labels';
import { IntegracionesData, errorText } from './integraciones.data';
import { BTN_PRIMARY, BTN_QUIET, FIELD, LABEL } from './integraciones.ui';

type Provider = 'github' | 'bitbucket' | 'gitlab' | 'jira' | 'linear';
const TASK_PROVIDERS = new Set<Provider>(['jira', 'linear']);
const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;

/** Formulario en línea de POST /integrations; muestra URL y secreto UNA vez. */
@Component({
  selector: 'app-create-integration',
  imports: [CopyButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mt-5 block border-t border-ink pt-4' },
  template: `
    @if (created(); as c) {
      <div role="status">
        <h3 class="m-0 text-[15px] font-semibold">Integración creada · {{ providerLabel[c.provider] ?? c.provider }}</h3>
        <p class="m-0 mt-1 text-[13px] text-estimated">Copia el secreto ahora: no se volverá a mostrar.</p>
        <dl class="m-0 mt-3 grid grid-cols-[max-content_minmax(0,1fr)_auto] items-baseline gap-x-4 text-sm">
          <dt class="border-t border-rule py-2.5 text-ink-2">URL del webhook</dt>
          <dd class="m-0 border-t border-rule py-2.5 font-mono text-[13px] break-all">{{ c.webhook_url }}</dd>
          <dd class="m-0 border-t border-rule"><app-copy [text]="c.webhook_url" ariaLabel="Copiar URL del webhook" /></dd>
          <dt class="border-t border-b border-rule py-2.5 text-ink-2">Secreto</dt>
          <dd class="m-0 border-t border-b border-rule py-2.5 font-mono text-[13px] break-all">{{ c.webhook_secret }}</dd>
          <dd class="m-0 border-t border-b border-rule"><app-copy [text]="c.webhook_secret" ariaLabel="Copiar secreto" /></dd>
        </dl>
        @if (events[c.provider]; as ev) {
          <p class="m-0 mt-3 text-[13px] text-ink-2">
            En el proveedor, crea el webhook con esa URL, tipo de contenido <span class="font-mono">application/json</span>, el secreto
            y los eventos <span class="font-mono">{{ ev }}</span>.
          </p>
        }
        <button type="button" [class]="quiet" (click)="done.emit()">Listo</button>
      </div>
    } @else {
      <form class="flex max-w-[460px] flex-col gap-3.5" (submit)="$event.preventDefault(); submit()">
        <h3 class="m-0 text-[15px] font-semibold">Crear integración</h3>
        <label [class]="label">
          Proveedor
          <select [class]="field" [value]="provider()" (change)="provider.set($any($event.target).value)">
            @for (p of providers(); track p) {
              <option [value]="p" [selected]="p === provider()">{{ providerLabel[p] }}</option>
            }
          </select>
        </label>
        <label [class]="label">
          Proyecto
          <input [class]="field" type="text" [value]="project()" (input)="project.set($any($event.target).value.trim())" />
        </label>
        @if (isTasks()) {
          <label [class]="label">
            Claves de proyecto en el gestor (separadas por coma)
            <input [class]="field" type="text" placeholder="MAG" [value]="keys()" (input)="keys.set($any($event.target).value.toUpperCase())" />
          </label>
          @if (provider() === 'jira') {
            <label [class]="label">
              Sitio de Jira (opcional)
              <input [class]="field" type="url" placeholder="https://empresa.atlassian.net" [value]="baseUrl()" (input)="baseUrl.set($any($event.target).value.trim())" />
            </label>
          }
        } @else {
          <label [class]="label">
            Repositorio
            <input [class]="field" type="text" placeholder="org/repo" [value]="repo()" (input)="repo.set($any($event.target).value.trim())" />
          </label>
        }
        <div class="flex flex-wrap items-center gap-x-6">
          <button type="submit" [class]="primary" [disabled]="busy() || !valid()">{{ busy() ? 'Creando…' : 'Crear integración' }}</button>
          <button type="button" [class]="quiet" (click)="done.emit()">Cancelar</button>
        </div>
        @if (error()) {
          <p class="m-0 text-[13px] text-critical" role="alert">{{ error() }}</p>
        }
      </form>
    }
  `,
})
export class CreateIntegrationComponent {
  private readonly data = inject(IntegracionesData);

  /** 'repository' | 'tasks' | 'any' — limita los proveedores ofrecidos. */
  readonly role = input<'repository' | 'tasks' | 'any'>('any');
  readonly projectId = input<string>('magicode-demo');
  readonly repository = input<string>('');
  readonly createdIntegration = output<IntegrationCreated>();
  readonly done = output<void>();

  protected readonly field = FIELD;
  protected readonly label = LABEL;
  protected readonly primary = BTN_PRIMARY;
  protected readonly quiet = BTN_QUIET;
  protected readonly providerLabel: Record<string, string | undefined> = PROVIDER_LABEL;
  protected readonly events = PROVIDER_EVENTS;

  protected readonly providers = computed<Provider[]>(() => {
    const r = this.role();
    if (r === 'repository') return ['github', 'bitbucket', 'gitlab'];
    if (r === 'tasks') return ['jira', 'linear'];
    return ['github', 'bitbucket', 'gitlab', 'jira', 'linear'];
  });
  protected readonly provider = linkedSignal<Provider>(() => this.providers()[0]!);
  protected readonly project = linkedSignal(() => this.projectId());
  protected readonly repo = linkedSignal(() => this.repository());
  protected readonly keys = signal('');
  protected readonly baseUrl = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly created = signal<IntegrationCreated | null>(null);

  protected readonly isTasks = computed(() => TASK_PROVIDERS.has(this.provider()));
  private readonly keyList = computed(() =>
    this.keys()
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
  );
  protected readonly valid = computed(() => {
    if (!this.project()) return false;
    if (this.isTasks()) return this.keyList().length > 0 && this.keyList().every((k) => KEY_RE.test(k));
    return /^[^/\s]+\/[^/\s]+$/.test(this.repo());
  });

  protected submit(): void {
    if (!this.valid()) return;
    const p = this.provider();
    const body: IntegrationCreate =
      p === 'jira' || p === 'linear'
        ? {
            provider: p,
            project_id: this.project(),
            task_project_keys: this.keyList(),
            ...(p === 'jira' && this.baseUrl() ? { base_url: this.baseUrl() } : {}),
          }
        : { provider: p, project_id: this.project(), repository: this.repo() };
    this.busy.set(true);
    this.error.set(null);
    this.data.create(body).subscribe({
      next: (c) => {
        this.busy.set(false);
        this.created.set(c);
        this.createdIntegration.emit(c);
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.error.set(errorText(e));
      },
    });
  }
}
