import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { AuthService } from '@/core/auth/auth.service';
import { RuntimeConfigService } from '@/core/config/runtime-config.service';
import { environment } from '../../../environments/environment';

/** Pegar una API key de MagiHub (validada con GET /whoami). Solo sessionStorage. */
@Component({
  selector: 'app-conectar',
  imports: [FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="min-h-screen bg-bg px-4 py-16 text-ink sm:px-8">
      <main class="mx-auto max-w-[520px]">
        <p class="m-0 text-[13px] text-muted">MagiHub / MagiCode</p>
        <h1 class="m-0 mt-1 text-[34px] leading-tight font-semibold tracking-[-0.02em]">Conectar con MagiHub</h1>
        <p class="mt-3 text-base text-ink-2">
          Pega una API key de MagiHub. Se guarda solo en esta pestaña y se envía únicamente al API de MagiCode como
          <span class="font-mono text-sm">Authorization: Bearer</span>.
        </p>
        <form class="mt-8 flex flex-col gap-4" (ngSubmit)="submit()">
          <label class="flex flex-col gap-1.5 text-[13px] text-ink-2" for="api-key">
            API key de MagiHub
            <input
              id="api-key"
              name="apiKey"
              type="password"
              autocomplete="off"
              spellcheck="false"
              [(ngModel)]="key"
              [attr.aria-invalid]="error() ? 'true' : null"
              aria-describedby="api-key-error"
              class="min-h-11 rounded-[4px] border border-field bg-bg px-3 py-2.5 font-mono text-[15px] text-ink outline-none focus-visible:border-accent"
            />
          </label>
          <p id="api-key-error" class="m-0 min-h-5 text-sm text-critical" aria-live="polite">{{ error() }}</p>
          <div class="flex flex-wrap items-center gap-x-6 gap-y-2">
            <button type="submit" class="min-h-11 cursor-pointer rounded-[4px] bg-ink px-5 text-[15px] font-semibold text-on-ink disabled:opacity-60" [disabled]="busy()">
              {{ busy() ? 'Validando…' : 'Conectar' }}
            </button>
            @if (demoMode()) {
              <a routerLink="/resumen" class="py-2">Entrar sin key (modo demo)</a>
            }
          </div>
          @if (useMocks) {
            <p class="m-0 text-[13px] text-estimated">Datos de ejemplo: cualquier key sirve.</p>
          }
        </form>
      </main>
    </div>
  `,
})
export class ConectarComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly config = inject(RuntimeConfigService);

  readonly returnUrl = input<string | undefined>(undefined);
  protected readonly useMocks = environment.useMocks;
  protected readonly demoMode = computed(() => this.config.config().demoMode === true);
  protected key = '';
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    const res = await this.auth.connect(this.key);
    this.busy.set(false);
    if (!res.ok) {
      this.error.set(res.message);
      return;
    }
    this.key = '';
    const target = this.returnUrl();
    void this.router.navigateByUrl(target && target.startsWith('/') && !target.startsWith('//') ? target : '/resumen');
  }
}
