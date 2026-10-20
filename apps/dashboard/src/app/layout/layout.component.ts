import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map, startWith } from 'rxjs';

import { AuthService } from '@/core/auth/auth.service';
import { SessionService } from '@/core/auth/session.service';
import { RuntimeConfigService } from '@/core/config/runtime-config.service';
import { PERIODS, ScopeService, type PeriodId } from '@/core/data/scope.service';
import { ScopeMenuComponent } from '@/shared/components/ui/scope-menu.component';
import { environment } from '../../environments/environment';

interface NavItem {
  label: string;
  link: string;
}

/** Shell del diseño: cabecera con el ámbito, navegación lateral (se apila en teléfono), aviso de readiness. */
@Component({
  selector: 'app-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ScopeMenuComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a href="#contenido" class="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:bg-bg focus:px-3 focus:py-2">Saltar al contenido</a>
    <div class="min-h-screen bg-bg text-ink">
      <header class="border-b border-rule px-4 sm:px-8">
        <div class="mx-auto flex min-h-14 max-w-[1376px] flex-wrap items-center gap-x-7 gap-y-1 py-1">
          <a routerLink="/resumen" class="flex items-baseline gap-2.5 text-ink no-underline hover:text-ink">
            <span class="text-base font-bold tracking-[-0.01em]">MagiHub</span>
            <span class="text-faint" aria-hidden="true">/</span>
            <span class="font-medium">MagiCode</span>
          </a>
          <nav aria-label="Ámbito" class="flex flex-[1_1_480px] flex-wrap items-center gap-x-[22px] gap-y-1 text-sm">
            @if (identity(); as id) {
              <span class="py-2 text-muted">Tenant <span class="font-medium text-ink">{{ id.tenant_id }}</span></span>
            }
            <app-scope-menu
              label="Proyecto"
              [value]="scope.projectId()"
              [valueLabel]="scope.projectId()"
              placeholder="—"
              [options]="projectOptions()"
              (select)="scope.selectProject($event)"
            />
            <app-scope-menu
              label="Periodo"
              [value]="scope.period()"
              [valueLabel]="scope.periodLabel()"
              [options]="periodOptions"
              (select)="selectPeriod($event)"
            />
            @if (identity(); as id) {
              <span class="py-2 text-muted">API key <span class="font-mono text-[13px] text-ink">{{ id.key_id }}</span></span>
            }
          </nav>
          <div class="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
            @if (demoMode()) {
              <span class="text-muted">Modo demo · sin login</span>
            }
            @if (hasKey()) {
              <button type="button" class="cursor-pointer py-2 text-muted hover:text-ink" (click)="auth.logout()">Desconectar</button>
            } @else if (demoMode()) {
              <a routerLink="/conectar" class="py-2 no-underline">Usar mi API key</a>
            }
            <a routerLink="/guia" class="py-2 no-underline">Guía de métricas</a>
          </div>
        </div>
      </header>

      @if (useMocks) {
        <p class="m-0 border-b border-rule px-4 py-2 text-center text-[13px] text-estimated sm:px-8">
          Datos de ejemplo: el dashboard muestra fixtures locales, no datos de MagiHub.
        </p>
      }

      @if (notReady(); as n) {
        <div class="border-b border-rule px-4 sm:px-8" role="status">
          <div class="mx-auto flex max-w-[1376px] flex-wrap items-baseline gap-x-4 gap-y-1 py-2.5 text-sm">
            <span class="font-medium text-estimated">El proyecto no está listo:</span>
            <span class="text-ink-2">{{ n.text }}</span>
            <a [routerLink]="['/integraciones']" [queryParams]="n.repo ? { repo: n.repo } : {}" class="py-1">Revisar integraciones</a>
          </div>
        </div>
      }

      <div class="mx-auto box-border flex max-w-[1440px] flex-wrap gap-x-14 px-4 sm:px-8">
        <nav aria-label="Secciones" class="flex w-full flex-wrap gap-x-5 gap-y-0 border-b border-rule pt-3 pb-2 text-sm md:w-auto md:max-w-[200px] md:flex-[1_1_180px] md:flex-col md:flex-nowrap md:gap-0.5 md:border-0 md:pt-10">
          @for (item of mainNav; track item.link) {
            <a
              [routerLink]="item.link"
              routerLinkActive="!text-ink font-semibold"
              ariaCurrentWhenActive="page"
              class="py-2 text-muted no-underline hover:text-ink"
              >{{ item.label }}</a
            >
          }
          <div class="my-3 hidden h-px bg-rule md:block" aria-hidden="true"></div>
          @for (item of secondaryNav; track item.link) {
            <a
              [routerLink]="item.link"
              routerLinkActive="!text-ink font-semibold"
              ariaCurrentWhenActive="page"
              class="py-2 text-muted no-underline hover:text-ink"
              >{{ item.label }}</a
            >
          }
        </nav>
        <main id="contenido" class="min-w-0 flex-[999_1_560px] pt-8 pb-24 md:pt-10" tabindex="-1">
          <router-outlet />
        </main>
      </div>
    </div>
  `,
})
export class LayoutComponent {
  protected readonly scope = inject(ScopeService);
  protected readonly auth = inject(AuthService);
  private readonly session = inject(SessionService);
  private readonly config = inject(RuntimeConfigService);
  private readonly router = inject(Router);

  protected readonly useMocks = environment.useMocks;
  protected readonly identity = this.session.identity;
  protected readonly hasKey = this.session.isAuthenticated;
  protected readonly demoMode = computed(() => this.config.config().demoMode === true);

  protected readonly mainNav: NavItem[] = [
    { label: 'Resumen', link: '/resumen' },
    { label: 'Tareas', link: '/tareas' },
    { label: 'Ramas', link: '/actividad/ramas' },
    { label: 'Sesiones', link: '/actividad/sesiones' },
    { label: 'Cambios', link: '/actividad/cambios' },
    { label: 'Pull requests', link: '/actividad/pull-requests' },
  ];
  protected readonly secondaryNav: NavItem[] = [
    { label: 'Integraciones', link: '/integraciones' },
    { label: 'Guía', link: '/guia' },
  ];

  protected readonly periodOptions = PERIODS.map((p) => ({ id: p.id, label: p.label }));
  protected readonly projectOptions = computed(() =>
    (this.scope.projects.value() ?? []).map((p) => ({ id: p.project_id, label: p.project_id, hint: p.repositories.join(', ') })),
  );

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map(() => this.router.url),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /** Aviso global: repos no listos (webhooks obligatorios) y razones. */
  protected readonly notReady = computed(() => {
    const r = this.scope.readiness.value();
    if (!r || r.ready) return null;
    const repos = (r.repositories ?? []).filter((x) => !x.ready);
    const reasons = r.blocking_reasons?.length ? r.blocking_reasons : repos.flatMap((x) => x.blocking_reasons ?? []);
    const repoText = repos.length ? `${repos.map((x) => x.repository).join(', ')} · ` : '';
    return {
      text: repoText + (reasons.length ? reasons.join(' · ') : 'faltan webhooks obligatorios por verificar'),
      repo: repos[0]?.repository ?? null,
      onIntegrations: this.url().startsWith('/integraciones'),
    };
  });

  protected selectPeriod(id: string): void {
    this.scope.selectPeriod(id as PeriodId);
  }
}
