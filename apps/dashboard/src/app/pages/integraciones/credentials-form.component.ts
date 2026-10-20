import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import type { GitProviderCredentials, TaskProviderCredentials } from '@magicode/contracts';

import { PROVIDER_LABEL } from '@/shared/labels/labels';
import { IntegracionesData, errorText } from './integraciones.data';
import { BTN_PRIMARY, BTN_QUIET, FIELD, LABEL } from './integraciones.ui';

/** PUT /integrations/:id/credentials — los secretos nunca se vuelven a mostrar. */
@Component({
  selector: 'app-credentials-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mt-5 block border-t border-ink pt-4' },
  template: `
    <form class="flex max-w-[460px] flex-col gap-3.5" autocomplete="off" (submit)="$event.preventDefault(); submit()">
      <h3 class="m-0 text-[15px] font-semibold">Credenciales de {{ providerLabel[provider()] ?? provider() }}</h3>
      <p class="m-0 text-[13px] text-ink-2">{{ hint() }}</p>
      @switch (provider()) {
        @case ('bitbucket') {
          <label [class]="label">Usuario<input [class]="field" type="text" (input)="set('username', $event)" /></label>
          <label [class]="label">App password<input [class]="field" type="password" (input)="set('app_password', $event)" /></label>
        }
        @case ('jira') {
          <label [class]="label">Sitio<input [class]="field" type="url" placeholder="https://empresa.atlassian.net" (input)="set('site_url', $event)" /></label>
          <label [class]="label">Correo de la cuenta<input [class]="field" type="email" (input)="set('email', $event)" /></label>
          <label [class]="label">API token<input [class]="field" type="password" (input)="set('api_token', $event)" /></label>
        }
        @case ('linear') {
          <label [class]="label">API key<input [class]="field" type="password" (input)="set('api_key', $event)" /></label>
        }
        @default {
          <label [class]="label">Token de acceso<input [class]="field" type="password" (input)="set('token', $event)" /></label>
        }
      }
      <div class="flex flex-wrap items-center gap-x-6">
        <button type="submit" [class]="primary" [disabled]="busy() || !valid()">{{ busy() ? 'Guardando…' : 'Guardar credenciales' }}</button>
        <button type="button" [class]="quiet" (click)="closed.emit()">Cancelar</button>
      </div>
      @if (error()) {
        <p class="m-0 text-[13px] text-critical" role="alert">{{ error() }}</p>
      }
    </form>
  `,
})
export class CredentialsFormComponent {
  private readonly data = inject(IntegracionesData);

  readonly integrationId = input.required<string>();
  readonly provider = input.required<string>();
  readonly saved = output<void>();
  readonly closed = output<void>();

  protected readonly field = FIELD;
  protected readonly label = LABEL;
  protected readonly primary = BTN_PRIMARY;
  protected readonly quiet = BTN_QUIET;
  protected readonly providerLabel: Record<string, string | undefined> = PROVIDER_LABEL;

  private readonly values = signal<Record<string, string>>({});
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly hint = computed(() => {
    switch (this.provider()) {
      case 'github':
        return 'Token fine-grained con «Webhooks: read & write» y «Metadata: read» sobre el repositorio.';
      case 'bitbucket':
        return 'App password con permisos de webhooks y repository:read.';
      case 'jira':
        return 'API token de una cuenta con acceso al proyecto (id.atlassian.com → Seguridad → API tokens).';
      default:
        return 'Se guardan cifradas y no se vuelven a mostrar.';
    }
  });

  private readonly body = computed<GitProviderCredentials | TaskProviderCredentials | null>(() => {
    const v = this.values();
    const has = (k: string, min = 1) => (v[k] ?? '').length >= min;
    switch (this.provider()) {
      case 'github':
        return has('token', 20) ? { provider: 'github', token: v['token']! } : null;
      case 'gitlab':
        return has('token', 20) ? { provider: 'gitlab', token: v['token']! } : null;
      case 'bitbucket':
        return has('username') && has('app_password', 10)
          ? { provider: 'bitbucket', username: v['username']!, app_password: v['app_password']! }
          : null;
      case 'jira':
        return /^https?:\/\/.+/.test(v['site_url'] ?? '') && /.+@.+/.test(v['email'] ?? '') && has('api_token', 10)
          ? { provider: 'jira', site_url: v['site_url']!, email: v['email']!, api_token: v['api_token']! }
          : null;
      case 'linear':
        return has('api_key', 10) ? { provider: 'linear', api_key: v['api_key']! } : null;
      default:
        return null;
    }
  });
  protected readonly valid = computed(() => this.body() !== null);

  protected set(key: string, ev: Event): void {
    const value = (ev.target as HTMLInputElement).value.trim();
    this.values.update((v) => ({ ...v, [key]: value }));
  }

  protected submit(): void {
    const body = this.body();
    if (!body) return;
    this.busy.set(true);
    this.error.set(null);
    this.data.saveCredentials(this.integrationId(), body).subscribe({
      next: () => {
        this.busy.set(false);
        this.values.set({});
        this.saved.emit();
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.error.set(errorText(e));
      },
    });
  }
}
