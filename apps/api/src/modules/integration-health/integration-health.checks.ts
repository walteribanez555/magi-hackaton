import type { CheckId, CheckResult, HealthStatus } from '@magicode/contracts';
import { hourOf } from './integration-health.repository';
import {
  DELIVERY_OUTCOMES,
  type DeliveryOutcome,
  type HealthBucketItem,
  type LocalHealthInput,
} from './integration-health.types';

const DAY_MS = 86_400_000;
const PROVIDER_NAME: Record<string, string> = { github: 'GitHub', bitbucket: 'Bitbucket', gitlab: 'GitLab', jira: 'Jira', linear: 'Linear' };
export const providerName = (p: string | null | undefined): string => (p ? (PROVIDER_NAME[p] ?? p) : 'el proveedor');

type Action = CheckResult['action'];
type Details = CheckResult['details'];

export const mk = (id: CheckId, status: CheckResult['status'], message: string, checkedAt: string, action: Action = null, details?: Details): CheckResult => ({
  id,
  status,
  message,
  action,
  checked_at: checkedAt,
  ...(details ? { details } : {}),
});

/** Suma de los contadores horarios de las últimas 24 h. */
export function deliveries24h(buckets: HealthBucketItem[], now: string): Record<DeliveryOutcome, number> {
  const from = hourOf(new Date(Date.parse(now) - DAY_MS).toISOString());
  const out = Object.fromEntries(DELIVERY_OUTCOMES.map((o) => [o, 0])) as Record<DeliveryOutcome, number>;
  for (const b of buckets) {
    if (b.hour < from) continue;
    for (const o of DELIVERY_OUTCOMES) out[o] += Number(b[o] ?? 0);
  }
  return out;
}

const olderThan = (iso: string | null | undefined, now: string, ms: number) => !iso || Date.parse(now) - Date.parse(iso) > ms;

export function checkIntegrationExists(i: LocalHealthInput): CheckResult {
  if (i.status === 'disabled') {
    return mk('integration_exists', 'fail', `La integración de ${providerName(i.provider)} está deshabilitada. Crea una nueva para este proyecto.`, i.now, 'create_integration');
  }
  return mk('integration_exists', 'pass', `Integración de ${providerName(i.provider)} configurada.`, i.now);
}

export function checkSignatureValid(i: LocalHealthInput): CheckResult {
  const h = i.health;
  const rejected = i.deliveries_24h.rejected_signature;
  if (!h?.last_delivery_at) return mk('signature_valid', 'skipped', 'Todavía no llegó ninguna entrega para verificar la firma.', i.now, 'run_test');
  const lastRej = h.last_rejected_signature_at;
  const lastOk = h.last_valid_delivery_at;
  if (lastRej && (!lastOk || lastOk < lastRej)) {
    return mk(
      'signature_valid',
      'fail',
      `Las últimas entregas de ${providerName(i.provider)} llegan con firma inválida (${rejected} en 24 h): el secreto configurado en el proveedor no coincide. Rota el secreto y pégalo en la configuración del webhook.`,
      i.now,
      'rotate_secret',
      { rejected_24h: rejected, last_rejected_at: lastRej },
    );
  }
  if (rejected > 0) {
    return mk(
      'signature_valid',
      'warn',
      `${rejected} entregas con firma inválida en 24 h, aunque después llegaron entregas válidas. ¿Hay otro webhook (duplicado) con un secreto antiguo?`,
      i.now,
      'open_provider_settings',
      { rejected_24h: rejected },
    );
  }
  return mk('signature_valid', 'pass', 'Las entregas llegan con firma válida.', i.now);
}

export function checkRecentDelivery(i: LocalHealthInput): CheckResult {
  const last = i.health?.last_valid_delivery_at ?? null;
  const p = providerName(i.provider);
  const sessions = i.ide_sessions_7d ?? 0;
  if (i.role === 'repository') {
    if (!last) {
      return sessions > 0
        ? mk('recent_delivery', 'warn', `Hubo ${sessions} sesiones del IDE en 7 días pero ${p} nunca envió eventos. Registra el webhook o lanza la prueba.`, i.now, 'register_webhook', { sessions_7d: sessions })
        : mk('recent_delivery', 'warn', `Aún no llegó ningún evento de ${p}. Haz un push o lanza la prueba de ida y vuelta.`, i.now, 'run_test');
    }
    if (olderThan(last, i.now, 7 * DAY_MS)) {
      return sessions > 0
        ? mk('recent_delivery', 'warn', `Sin eventos de ${p} en 7 días aunque hubo ${sessions} sesiones del IDE: revisa que el webhook siga activo.`, i.now, 'open_provider_settings', { last_delivery_at: last, sessions_7d: sessions })
        : mk('recent_delivery', 'pass', `Sin eventos en 7 días, pero tampoco hubo sesiones del IDE (último evento ${last}).`, i.now, null, { last_delivery_at: last });
    }
    return mk('recent_delivery', 'pass', `Último evento recibido: ${last}.`, i.now, null, { last_delivery_at: last });
  }
  if (!last) return mk('recent_delivery', 'warn', `Aún no llegó ningún evento de ${p}. Edita un issue del proyecto o lanza la prueba.`, i.now, 'run_test');
  if (olderThan(last, i.now, 7 * DAY_MS)) {
    return mk('recent_delivery', 'warn', `Sin eventos de ${p} en 7 días: revisa que el webhook siga activo y que el filtro JQL incluya el proyecto.`, i.now, 'open_provider_settings', { last_delivery_at: last });
  }
  return mk('recent_delivery', 'pass', `Último evento recibido: ${last}.`, i.now, null, { last_delivery_at: last });
}

export function checkRoundtrip(i: LocalHealthInput): CheckResult {
  const t = i.last_test;
  if (!t) return mk('roundtrip_test', 'warn', 'Nunca se ejecutó la prueba de ida y vuelta.', i.now, 'run_test');
  if (t.status === 'pending') return mk('roundtrip_test', 'warn', 'Hay una prueba de ida y vuelta en curso.', i.now, null, { test_id: t.test_id });
  if (t.status === 'failed' || t.status === 'timeout') {
    const why = t.steps.find((s) => s.status === 'fail')?.message ?? (t.status === 'timeout' ? 'no llegó el evento a tiempo' : 'error');
    return mk('roundtrip_test', 'fail', `La última prueba ${t.status === 'timeout' ? 'expiró' : 'falló'}: ${why}.`, i.now, 'run_test', { test_id: t.test_id });
  }
  if (olderThan(t.finished_at, i.now, 7 * DAY_MS)) {
    return mk('roundtrip_test', 'warn', `La última prueba exitosa es de hace más de 7 días (${t.finished_at}).`, i.now, 'run_test', { test_id: t.test_id });
  }
  return mk('roundtrip_test', 'pass', `Prueba de ida y vuelta OK${t.latency_ms !== null ? ` (latencia ${t.latency_ms} ms)` : ''}.`, i.now, null, {
    test_id: t.test_id,
    latency_ms: t.latency_ms,
  });
}

export function checkCommitsReconciled(i: LocalHealthInput): CheckResult {
  const n = i.unverified_commits ?? 0;
  if (n > 0) {
    return mk(
      'commits_reconciled',
      'warn',
      `${n} commits reportados por el IDE hace más de 1 h no llegaron por el webhook push: ¿falta hacer push, o el webhook no tiene el evento push?`,
      i.now,
      'open_provider_settings',
      { unverified_commits: n },
    );
  }
  return mk('commits_reconciled', 'pass', 'Los commits del IDE coinciden con los recibidos por push.', i.now);
}

export function checkTasksReconciled(i: LocalHealthInput): CheckResult {
  const missing = i.unknown_task_keys ?? [];
  if (missing.length) {
    return mk(
      'tasks_reconciled',
      'warn',
      `Claves usadas en ramas sin tarea sincronizada desde ${providerName(i.provider)}: ${missing.slice(0, 5).join(', ')}. Revisa el filtro JQL del webhook o edita esas tareas para que se sincronicen.`,
      i.now,
      'open_provider_settings',
      { missing: missing.slice(0, 5).join(','), count: missing.length },
    );
  }
  return mk('tasks_reconciled', 'pass', 'Todas las claves usadas en ramas existen en el gestor de tareas.', i.now);
}

/** Checks que requieren la API del proveedor cuando no hay resultado en caché. */
export function providerPlaceholders(i: LocalHealthInput): CheckResult[] {
  const p = providerName(i.provider);
  const ids: CheckId[] = ['credentials_valid', 'webhook_registered', 'webhook_events', ...(i.role === 'repository' ? (['provider_last_response'] as CheckId[]) : [])];
  return ids.map((id) =>
    i.has_credentials
      ? mk(id, 'skipped', `Pulsa «Verificar» para consultar a ${p} (refresh=true).`, i.now)
      : mk(id, 'skipped', `Sin credenciales de ${p}: agrégalas para verificar y registrar el webhook automáticamente.`, i.now, 'add_credentials'),
  );
}

/** Todos los checks locales (sin API del proveedor), en orden estable. */
export function localChecks(i: LocalHealthInput): CheckResult[] {
  return [
    checkIntegrationExists(i),
    checkSignatureValid(i),
    checkRecentDelivery(i),
    checkRoundtrip(i),
    i.role === 'repository' ? checkCommitsReconciled(i) : checkTasksReconciled(i),
  ];
}

const ORDER: CheckId[] = [
  'integration_exists',
  'credentials_valid',
  'webhook_registered',
  'webhook_events',
  'signature_valid',
  'recent_delivery',
  'provider_last_response',
  'roundtrip_test',
  'commits_reconciled',
  'tasks_reconciled',
];
export const sortChecks = (checks: CheckResult[]): CheckResult[] =>
  [...checks].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));

/**
 * disabled → failing (cualquier fail: p. ej. firma inválida explica por qué no hay entregas)
 * → awaiting_first_delivery (nunca llegó un evento válido) → degraded (algún warn) → healthy.
 */
export function rollup(status: LocalHealthInput['status'], checks: CheckResult[], lastValidDeliveryAt: string | null | undefined): HealthStatus {
  if (status === 'disabled') return 'disabled';
  if (checks.some((c) => c.status === 'fail')) return 'failing';
  if (!lastValidDeliveryAt) return 'awaiting_first_delivery';
  if (checks.some((c) => c.status === 'warn')) return 'degraded';
  return 'healthy';
}
