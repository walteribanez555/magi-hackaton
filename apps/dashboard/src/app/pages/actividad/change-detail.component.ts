import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ChangeListItem } from '@magicode/contracts';

import { NumPipe, PctPipe, ScorePipe } from '@/shared/components/ui/format.pipes';
import { MetricComponent } from '@/shared/components/ui/metric.component';
import { ProvenanceComponent } from '@/shared/components/ui/provenance.component';
import { CriticalityComponent } from '@/shared/components/ui/status-mark.component';
import { CHANGE_STATUS_LABEL, FEATURE_LABEL, LINE_KIND_LABEL } from '@/shared/labels/labels';

/** Detalle del cambio seleccionado: factores del modelo, aristas, líneas, tokens, petición y commit. */
@Component({
  selector: 'app-change-detail',
  imports: [RouterLink, NumPipe, PctPipe, ScorePipe, MetricComponent, ProvenanceComponent, CriticalityComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let c = change();
    <section aria-labelledby="h-change-detail" class="mt-12 flex flex-wrap gap-x-16 gap-y-10">
      <div class="min-w-0 flex-[1_1_360px]">
        <p class="m-0 text-xs text-muted">Detalle del cambio seleccionado</p>
        <h2 id="h-change-detail" class="m-0 mt-1 break-all font-mono text-[22px] font-semibold tracking-[-0.01em]">
          {{ c.task_key ?? c.branch ?? 'sin tarea' }} · {{ c.files[0]?.path ?? c.change_id }}
        </h2>
        <p class="m-0 mt-2 text-ink-2">
          @if (c.scores; as s) {
            Criticidad <app-crit [level]="s.criticality" [score]="s.criticality_score" /> · modelo
            <span class="font-mono text-[13px]">{{ s.model_version }}</span><app-prov [p]="s.provenance" />
          } @else {
            Sin puntuar: el modelo aún no calculó supervivencia, retrabajo ni criticidad para este cambio.
          }
        </p>

        <h3 class="m-0 mb-2 mt-7 text-sm font-semibold">Factores que más pesaron</h3>
        @if (c.scores?.top_factors?.length) {
          <ol class="m-0 list-none border-b border-rule p-0 text-sm">
            @for (f of c.scores!.top_factors; track f.feature) {
              <li class="flex justify-between gap-4 border-t border-rule py-2.5">
                <span>{{ featureLabel(f.feature) }}</span>
                @if (f.direction === 'up') {
                  <span class="text-critical">sube el riesgo</span>
                } @else {
                  <span class="text-accent">baja el riesgo</span>
                }
              </li>
            }
          </ol>
        } @else {
          <p class="m-0 border-t border-rule py-2.5 text-sm text-muted">{{ c.scores ? 'El modelo no reportó factores.' : 'sin puntuar' }}</p>
        }

        <h3 class="m-0 mb-2 mt-7 text-sm font-semibold">Archivos</h3>
        <ul class="m-0 list-none border-b border-rule p-0 text-sm">
          @for (f of c.files; track f.path) {
            <li class="flex justify-between gap-4 border-t border-rule py-2.5">
              <span class="break-all font-mono text-[13px]">{{ f.path }}</span>
              <span class="whitespace-nowrap font-mono text-[13px] text-muted">+{{ f.added | num }} −{{ f.deleted | num }}</span>
            </li>
          }
        </ul>
      </div>

      <div class="min-w-0 flex-[1_1_360px]">
        <h3 class="m-0 mb-3 text-sm font-semibold">Las {{ c.accepted_added_lines | num }} líneas aceptadas</h3>
        @if (byKind().length) {
          <dl class="m-0 grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-sm">
            @for (k of byKind(); track k.kind) {
              <dt class="text-ink-2">{{ k.label }}</dt>
              <dd class="m-0 font-mono">{{ k.n | num }}</dd>
            }
          </dl>
          <div class="my-4 h-px bg-rule"></div>
        }
        <dl class="m-0 grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-sm">
          <dt class="text-ink-2">Estado</dt>
          <dd class="m-0">{{ statusLabel(c.status) }}</dd>
          <dt class="text-ink-2">Importancia</dt>
          <dd class="m-0 font-mono">{{ c.importance_score | score }}</dd>
          <dt class="text-ink-2">Redundancia</dt>
          <dd class="m-0 font-mono">{{ c.redundancy_score | score }}</dd>
          <dt class="text-ink-2">Mecánico</dt>
          <dd class="m-0 font-mono">{{ c.mechanical_share | pct: 0 }}</dd>
          <dt class="text-ink-2">Supervivencia</dt>
          <dd class="m-0 font-mono">{{ c.scores?.survival_probability | score }}</dd>
          <dt class="text-ink-2">Retrabajo</dt>
          <dd class="m-0 font-mono">{{ c.scores?.rework_risk | score }}</dd>
        </dl>
        <div class="my-4 h-px bg-rule"></div>
        <dl class="m-0 grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-sm">
          <dt class="text-ink-2">Líneas efectivas</dt>
          <dd class="m-0 font-mono">{{ c.effective_lines | num: 1 }}</dd>
          <dt class="text-ink-2">Tokens de la petición</dt>
          <dd class="m-0 font-mono"><app-metric [m]="c.tokens" /></dd>
          <dt class="text-ink-2">Tokens / 100 efectivas</dt>
          <dd class="m-0 font-mono"><app-metric [value]="tokensPer100()" [provenance]="c.tokens.provenance" /></dd>
          <dt class="text-ink-2">Petición</dt>
          <dd class="m-0 break-all font-mono text-[13px]">{{ c.ai_request_id }}</dd>
          <dt class="text-ink-2">Sesión</dt>
          <dd class="m-0 break-all font-mono text-[13px]">
            <a [routerLink]="['/actividad/sesiones', c.session_id]">{{ c.session_id }}</a>
          </dd>
          <dt class="text-ink-2">Rama</dt>
          <dd class="m-0 break-all font-mono text-[13px]">{{ c.branch ?? '—' }}</dd>
          <dt class="text-ink-2">Commit</dt>
          <dd class="m-0 break-all font-mono text-[13px]">{{ c.commit_sha ? c.commit_sha.slice(0, 12) : 'pendiente' }}</dd>
        </dl>
      </div>
    </section>
  `,
})
export class ChangeDetailComponent {
  readonly change = input.required<ChangeListItem>();

  /** El contrato no trae by_kind por cambio; si el API lo agrega, se muestra. */
  protected readonly byKind = computed(() => {
    const raw = (this.change() as ChangeListItem & { by_kind?: Record<string, number> }).by_kind;
    if (!raw) return [];
    return Object.entries(raw)
      .filter(([, n]) => n > 0)
      .map(([kind, n]) => ({ kind, n, label: LINE_KIND_LABEL[kind] ?? kind }));
  });

  protected readonly tokensPer100 = computed(() => {
    const c = this.change();
    const t = c.tokens.value;
    return t === null || !c.effective_lines ? null : (t / c.effective_lines) * 100;
  });

  protected featureLabel(f: string): string {
    return FEATURE_LABEL[f] ?? f;
  }
  protected statusLabel(s: string): string {
    return CHANGE_STATUS_LABEL[s] ?? s;
  }
}
