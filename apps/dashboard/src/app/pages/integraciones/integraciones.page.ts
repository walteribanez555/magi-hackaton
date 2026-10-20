import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import type { Integration, RepositoryOption } from '@magicode/contracts';
import { map, of } from 'rxjs';

import { ScopeService } from '@/core/data/scope.service';
import { CopyButtonComponent } from '@/shared/components/ui/copy-button.component';
import { StatusMarkComponent, type Tone } from '@/shared/components/ui/status-mark.component';
import { PROVIDER_LABEL } from '@/shared/labels/labels';
import { formatAgo } from '@/shared/utils/format';
import { CreateIntegrationComponent } from './create-integration.component';
import { HealthPanelComponent } from './health-panel.component';
import { HealthBlockComponent } from './health-block.component';
import { IntegracionesData, type RepoState } from './integraciones.data';
import { BTN_LINK, BTN_PRIMARY, BTN_QUIET } from './integraciones.ui';
import { TestPanelComponent } from './test-panel.component';

const STATUS: Record<Integration['status'], { tone: Tone; label: string }> = {
  active: { tone: 'info', label: 'Activa' },
  pending: { tone: 'warn', label: 'Esperando primer evento' },
  disabled: { tone: 'muted', label: 'Desactivada' },
};

@Component({
  selector: 'app-integraciones-page',
  imports: [StatusMarkComponent, CopyButtonComponent, CreateIntegrationComponent, HealthPanelComponent, TestPanelComponent, HealthBlockComponent],
  providers: [IntegracionesData],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="m-0 text-[34px] leading-tight font-semibold tracking-[-0.02em]">Integraciones</h1>
    <p class="m-0 mt-2.5 max-w-[780px] text-base text-ink-2">
      Un proyecto necesita las dos: el repositorio confirma commits, pull requests y despliegues; el gestor de tareas da el contexto de
      cada cambio. Comprobar envía un evento real de ida y vuelta.
    </p>

    <div class="mt-8 flex flex-wrap items-end gap-x-6 gap-y-3">
      <label class="flex flex-[0_1_460px] flex-col gap-1.5 text-[13px] text-ink-2">
        Repositorio
        <select
          class="min-h-11 rounded-[4px] border border-field bg-bg px-3 py-2.5 font-mono text-[15px] text-ink"
          [disabled]="!groups().length"
          (change)="selectRepo($any($event.target).value)"
        >
          @for (g of groups(); track g.project) {
            <optgroup [label]="g.project">
              @for (o of g.options; track o.repository) {
                <option [value]="o.repository" [selected]="o.repository === repo()">{{ o.repository }} — {{ o.ready ? 'Listo' : 'No listo' }}</option>
              }
            </optgroup>
          } @empty {
            <option>{{ repos.isLoading() ? 'Cargando repositorios…' : 'Sin repositorios con actividad' }}</option>
          }
        </select>
      </label>
      <span class="pb-3 text-[13px] text-muted">Cada repositorio tiene su propio conjunto de claves y webhooks.</span>
    </div>

    @if (repoState.value(); as st) {
      @if (st.readiness.blocking_reasons.length) {
        <ul class="m-0 mt-5 list-none p-0 text-sm text-estimated" role="status">
          @for (r of st.readiness.blocking_reasons; track r) {
            <li><span class="mr-2 inline-block size-2 bg-estimated align-[1px]" aria-hidden="true"></span>{{ r }}</li>
          }
        </ul>
      }
      <section aria-labelledby="h-keys" class="mt-10">
        <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-ink pb-2.5">
          <h2 id="h-keys" class="m-0 text-lg font-semibold">API keys de MagiHub</h2>
          <span class="text-[13px] text-muted">Usadas por MagiCode en este repositorio · nunca se muestra la key</span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr class="text-xs text-muted">
                <th scope="col" class="py-2.5 pr-3 text-left font-medium">Nombre</th>
                <th scope="col" class="px-3 py-2.5 text-left font-medium">Huella</th>
                <th scope="col" class="px-3 py-2.5 text-left font-medium">Uso</th>
                <th scope="col" class="px-3 py-2.5 text-left font-medium">Último uso</th>
                <th scope="col" class="py-2.5 pl-3 text-right font-medium">Sesiones 7 d</th>
              </tr>
            </thead>
            <tbody>
              @for (k of st.readiness.api_keys; track k.key_id) {
                <tr class="border-t border-rule">
                  <td class="py-2.5 pr-3" [class.text-muted]="!k.key_name">{{ k.key_name ?? '—' }}</td>
                  <td class="px-3 py-2.5 font-mono text-[13px]">{{ k.key_fingerprint }}</td>
                  <td class="px-3 py-2.5" [class.text-estimated]="k.usage === 'shared'">{{ k.usage === 'dedicated' ? 'Dedicada' : 'Compartida' }}</td>
                  <td class="px-3 py-2.5 text-ink-2">{{ ago(k.last_used_at) }}</td>
                  <td class="py-2.5 pl-3 text-right font-mono">{{ k.sessions_7d }}</td>
                </tr>
              } @empty {
                <tr class="border-t border-rule">
                  <td colspan="5" class="py-3 text-ink-2">Ninguna API key de MagiHub ha enviado eventos de este repositorio todavía.</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <p class="m-0 mt-2.5 max-w-[780px] text-[13px] text-muted">
          Una key dedicada a un solo repositorio permite atribuir sus tokens sin estimar. Las compartidas reparten el consumo por ventana horaria.
        </p>
      </section>

      <app-health-block
        role="repository"
        [health]="st.readiness.repository_webhook"
        [integration]="st.repositoryIntegration"
        [repository]="st.readiness.repository"
        [projectId]="st.readiness.project_id"
        (changed)="reloadAll()"
      />
      <app-health-block
        role="tasks"
        [health]="st.readiness.tasks_webhook"
        [integration]="st.tasksIntegration"
        [repository]="st.readiness.repository"
        [projectId]="st.readiness.project_id"
        (changed)="reloadAll()"
      />
      @if (st.derived) {
        <p class="m-0 mt-3 text-xs text-muted">Estado calculado a partir de la lista de integraciones: el servicio de salud no respondió.</p>
      }
    } @else if (repoState.isLoading()) {
      <p class="m-0 mt-10 border-t border-rule py-4 text-sm text-muted" role="status">Cargando el estado del repositorio…</p>
    } @else if (repoState.error()) {
      <p class="m-0 mt-10 border-t border-rule py-4 text-sm text-critical" role="alert">
        No se pudo leer el estado del repositorio.
        <button type="button" [class]="link" (click)="repoState.reload()">Reintentar</button>
      </p>
    }

    <section aria-labelledby="h-integrations" class="mt-14">
      <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-ink pb-2.5">
        <h2 id="h-integrations" class="m-0 text-lg font-semibold">Todas las integraciones del proyecto</h2>
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
        <app-create-integration [projectId]="projectId()" [repository]="defaultRepo()" (createdIntegration)="reloadAll()" (done)="creating.set(false)" />
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
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

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

  protected readonly repos = rxResource<RepositoryOption[], { projectId: string; fallback: { project_id: string; repositories: string[] }[] }>({
    params: () => ({ projectId: this.projectId(), fallback: this.scope.projects.value() ?? [] }),
    stream: ({ params }) => this.data.repositories(params.projectId, params.fallback),
  });

  protected readonly groups = computed(() => {
    const by = new Map<string, RepositoryOption[]>();
    for (const o of this.repos.value() ?? []) by.set(o.project_id, [...(by.get(o.project_id) ?? []), o]);
    return [...by].map(([project, options]) => ({ project, options }));
  });

  private readonly repoParam = toSignal(this.route.queryParamMap.pipe(map((q) => q.get('repo'))), { initialValue: null });

  /** repo efectivo: el de ?repo= si está en la lista; si no, el primero */
  protected readonly repo = computed<string | null>(() => {
    const list = this.repos.value() ?? [];
    const p = this.repoParam();
    if (p && list.some((o) => o.repository === p)) return p;
    return list[0]?.repository ?? null;
  });

  /** igualdad por valor: recargar la lista de repos no debe reiniciar el bloque (se perdería el secreto mostrado) */
  private readonly repoKey = computed<{ repo: string; projectId: string } | null>(
    () => {
      const repo = this.repo();
      if (!repo) return null;
      const opt = (this.repos.value() ?? []).find((o) => o.repository === repo);
      return { repo, projectId: opt?.project_id ?? this.projectId() };
    },
    { equal: (a, b) => a?.repo === b?.repo && a?.projectId === b?.projectId },
  );

  protected readonly repoState = rxResource<RepoState | null, { repo: string; projectId: string } | null>({
    params: () => this.repoKey(),
    stream: ({ params }) => (params ? this.data.state(params.repo, params.projectId) : of(null)),
  });

  protected selectRepo(repo: string): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { repo }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected reloadAll(): void {
    this.list.reload();
    this.repos.reload();
    this.repoState.reload();
  }

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
