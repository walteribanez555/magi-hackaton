/** Formato de cifras para la UI. Puro: no importa 'vscode'. */
import type { SessionState, SessionStats } from './session';

export const TOKENS_NOTE = 'reportado por MagiHub en la respuesta; el dashboard usa la API de consumo';

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmt(n: number, decimals = 0): string {
  return n.toLocaleString('es', { maximumFractionDigits: decimals, minimumFractionDigits: 0 });
}

export function per100(tokens: number, lines: number): string {
  return lines > 0 ? fmt((tokens / lines) * 100) : '—';
}

export interface StatsContext {
  repository?: string;
  branch?: string;
  taskKey?: string;
  developer?: string;
  developerName?: string;
  pendingTelemetry: number;
}

/** "Nombre <email>", solo email, solo nombre o "—". */
export function developerLabel(email?: string, name?: string): string {
  if (email && name) return `${name} <${email}>`;
  return email ?? name ?? '—';
}

const SOURCE_LABEL = { bedrock: 'Bedrock (real)', 'magihub-mock': 'simulado', 'magihub-response': 'MagiHub' } as const;

/** Último modelo enrutado por Smart Auto + origen, y el desglose si hubo varios. */
export function modelLabel(st: SessionStats): string {
  if (!st.last_model) return '—';
  const src = st.last_usage_source ? ` · ${SOURCE_LABEL[st.last_usage_source]}` : '';
  const others = Object.entries(st.models ?? {});
  const breakdown = others.length > 1 ? ` (${others.map(([m, n]) => `${m}×${n}`).join(', ')})` : '';
  return `${st.last_model}${src}${breakdown}`;
}

/** Resumen en texto plano de la sesión (modal "Show Session Stats"). */
export function sessionSummary(s: SessionState, ctx: StatsContext): string {
  const st = s.stats;
  const lines = [
    `Sesión ${s.id.slice(0, 8)} · desde ${new Date(s.started_at).toLocaleString('es')}`,
    `Repo: ${ctx.repository ?? '—'} · rama: ${ctx.branch ?? '(detached)'} · tarea: ${ctx.taskKey ?? '—'}`,
    `Developer: ${developerLabel(ctx.developer, ctx.developerName)}`,
    '',
    `Peticiones Smart Auto: ${st.requests} (${st.request_errors} con error)`,
    `Modelo enrutado: ${modelLabel(st)}`,
    `Tokens: ${fmt(st.tokens_reported)} (${TOKENS_NOTE})`,
    `Propuestos: ${st.proposed} · aceptados: ${st.accepted} · rechazados: ${st.rejected}`,
    `Líneas aceptadas: ${fmt(st.accepted_lines)} · efectivas: ${fmt(st.effective_lines, 1)}`,
    `Tokens / 100 líneas efectivas (estimado): ${per100(st.tokens_reported, st.effective_lines)}`,
    `Commits con cambios IA: ${st.commits} · líneas IA en Git: ${fmt(st.ai_committed_lines)}`,
  ];
  if (s.reference) {
    lines.push(
      `Versión de referencia (demo): ${s.reference.tag} @ ${s.reference.sha.slice(0, 8)} · ` +
        `${fmt(s.reference.surviving_lines)} líneas sobreviven (${fmt(s.reference.surviving_effective_lines, 1)} efectivas)`,
    );
  }
  lines.push('', `Telemetría pendiente de envío: ${ctx.pendingTelemetry} eventos`);
  return lines.join('\n');
}
