import { describe, expect, it } from 'vitest';
import {
  checkCommitsReconciled,
  checkRecentDelivery,
  checkRoundtrip,
  checkSignatureValid,
  checkTasksReconciled,
  deliveries24h,
  localChecks,
  providerPlaceholders,
  rollup,
} from '../integration-health.checks';
import type { LocalHealthInput, TestRunItem } from '../integration-health.types';

const NOW = '2026-10-20T20:00:00.000Z';
const ago = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();
const zero = { accepted: 0, duplicate: 0, ignored: 0, rejected_signature: 0, rejected_other: 0 };

const input = (o: Partial<LocalHealthInput> = {}): LocalHealthInput => ({
  now: NOW,
  role: 'repository',
  provider: 'github',
  status: 'active',
  health: { PK: 'p', SK: 'HEALTH', entity: 'IntHealth', tenant_id: 't', integration_id: 'i', last_delivery_at: ago(1), last_valid_delivery_at: ago(1) },
  deliveries_24h: { ...zero, accepted: 3 },
  last_test: null,
  has_credentials: false,
  ide_sessions_7d: 0,
  unverified_commits: 0,
  ...o,
});

const test = (o: Partial<TestRunItem>): TestRunItem =>
  ({ test_id: 'test_1', status: 'passed', steps: [], finished_at: ago(2), latency_ms: 420, ...o }) as TestRunItem;

describe('deliveries24h', () => {
  it('suma solo los buckets de las últimas 24 h', () => {
    const buckets = [
      { SK: 'x', hour: '2026-10-20T19', accepted: 2, rejected_signature: 1 },
      { SK: 'x', hour: '2026-10-19T20', accepted: 5 },
      { SK: 'x', hour: '2026-10-19T19', accepted: 100 },
    ];
    expect(deliveries24h(buckets, NOW)).toEqual({ ...zero, accepted: 7, rejected_signature: 1 });
  });
});

describe('signature_valid', () => {
  it('skipped sin entregas; pass con entregas válidas', () => {
    expect(checkSignatureValid(input({ health: null })).status).toBe('skipped');
    expect(checkSignatureValid(input()).status).toBe('pass');
  });
  it('fail si la última entrega con firma inválida no tiene una válida posterior', () => {
    const c = checkSignatureValid(
      input({ health: { ...input().health!, last_rejected_signature_at: ago(0.5), last_valid_delivery_at: ago(3) }, deliveries_24h: { ...zero, rejected_signature: 4 } }),
    );
    expect(c).toMatchObject({ status: 'fail', action: 'rotate_secret' });
    expect(c.message).toMatch(/4 en 24 h/);
  });
  it('warn si hubo rechazos pero luego llegaron válidas (webhook duplicado con secreto viejo)', () => {
    const c = checkSignatureValid(input({ health: { ...input().health!, last_rejected_signature_at: ago(5) }, deliveries_24h: { ...zero, rejected_signature: 2 } }));
    expect(c).toMatchObject({ status: 'warn', action: 'open_provider_settings' });
  });
  it('fail si nunca hubo una entrega válida y sí rechazos', () => {
    expect(checkSignatureValid(input({ health: { ...input().health!, last_valid_delivery_at: undefined, last_rejected_signature_at: ago(1) } })).status).toBe('fail');
  });
});

describe('recent_delivery', () => {
  it('repositorio: warn si no hay eventos en 7 d pero sí sesiones del IDE; pass si tampoco hubo sesiones', () => {
    const old = { ...input().health!, last_valid_delivery_at: ago(24 * 8) };
    expect(checkRecentDelivery(input({ health: old, ide_sessions_7d: 3 }))).toMatchObject({ status: 'warn' });
    expect(checkRecentDelivery(input({ health: old, ide_sessions_7d: 0 })).status).toBe('pass');
    expect(checkRecentDelivery(input({ health: null, ide_sessions_7d: 2 }))).toMatchObject({ status: 'warn', action: 'register_webhook' });
    expect(checkRecentDelivery(input()).status).toBe('pass');
  });
  it('tareas: warn sin eventos en 7 d', () => {
    expect(checkRecentDelivery(input({ role: 'tasks', provider: 'jira', health: { ...input().health!, last_valid_delivery_at: ago(24 * 10) } })).status).toBe('warn');
  });
});

describe('roundtrip_test', () => {
  it('nunca → warn; passed reciente → pass; viejo → warn; failed/timeout → fail; pending → warn', () => {
    expect(checkRoundtrip(input()).status).toBe('warn');
    expect(checkRoundtrip(input({ last_test: test({}) }))).toMatchObject({ status: 'pass', details: { latency_ms: 420 } });
    expect(checkRoundtrip(input({ last_test: test({ finished_at: ago(24 * 9) }) })).status).toBe('warn');
    expect(checkRoundtrip(input({ last_test: test({ status: 'timeout' }) }))).toMatchObject({ status: 'fail', action: 'run_test' });
    expect(checkRoundtrip(input({ last_test: test({ status: 'failed', steps: [{ name: 'Firma válida', status: 'fail', at: NOW, message: 'Firma inválida' }] }) })).message).toContain('Firma inválida');
    expect(checkRoundtrip(input({ last_test: test({ status: 'pending' }) })).status).toBe('warn');
  });
});

describe('reconciliación', () => {
  it('commits del IDE sin push verificado → warn con el conteo', () => {
    expect(checkCommitsReconciled(input({ unverified_commits: 4 }))).toMatchObject({ status: 'warn', details: { unverified_commits: 4 } });
    expect(checkCommitsReconciled(input()).status).toBe('pass');
  });
  it('claves en ramas sin tarea → warn con hasta 5 claves', () => {
    const c = checkTasksReconciled(input({ role: 'tasks', provider: 'jira', unknown_task_keys: ['MAG-1', 'MAG-2', 'MAG-3', 'MAG-4', 'MAG-5', 'MAG-6'] }));
    expect(c.status).toBe('warn');
    expect(c.message).toContain('MAG-1, MAG-2, MAG-3, MAG-4, MAG-5.');
    expect(c.details).toMatchObject({ count: 6 });
  });
});

describe('placeholders del proveedor', () => {
  it('sin credenciales sugieren add_credentials; con credenciales piden refresh', () => {
    expect(providerPlaceholders(input()).map((c) => [c.id, c.status, c.action])).toEqual([
      ['credentials_valid', 'skipped', 'add_credentials'],
      ['webhook_registered', 'skipped', 'add_credentials'],
      ['webhook_events', 'skipped', 'add_credentials'],
      ['provider_last_response', 'skipped', 'add_credentials'],
    ]);
    expect(providerPlaceholders(input({ role: 'tasks', has_credentials: true })).map((c) => c.action)).toEqual([null, null, null]);
  });
});

describe('rollup', () => {
  const ok = localChecks(input({ last_test: test({}) }));
  it('healthy / degraded / failing / awaiting / disabled', () => {
    expect(ok.every((c) => c.status === 'pass')).toBe(true);
    expect(rollup('active', ok, ago(1))).toBe('healthy');
    expect(rollup('active', localChecks(input()), ago(1))).toBe('degraded'); // sin prueba de ida y vuelta
    expect(rollup('pending', localChecks(input({ health: null })), null)).toBe('awaiting_first_delivery');
    const failing = localChecks(input({ health: { ...input().health!, last_valid_delivery_at: undefined, last_rejected_signature_at: ago(1) } }));
    expect(rollup('pending', failing, null)).toBe('failing'); // la firma inválida explica por qué no hay entregas
    expect(rollup('disabled', ok, ago(1))).toBe('disabled');
  });
});
