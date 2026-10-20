import type { CheckResult, IntegrationHealth, IntegrationTestRun } from '@magicode/contracts';

/** Resultado de una entrega para la contabilidad (sin payloads). */
export type DeliveryOutcome = 'accepted' | 'duplicate' | 'ignored' | 'rejected_signature' | 'rejected_other';
export const DELIVERY_OUTCOMES: DeliveryOutcome[] = ['accepted', 'duplicate', 'ignored', 'rejected_signature', 'rejected_other'];

export type Role = IntegrationHealth['role'];

/** Qué entrega completa una prueba de ida y vuelta pendiente. */
export type TestExpectation = 'ping' | 'push' | 'jira_label' | 'any';

/** Prueba pendiente guardada en IntLookup (el webhook ya lee esa fila: cero lecturas extra). */
export interface PendingTest {
  test_id: string;
  sk: string;
  expect: TestExpectation;
  triggered_at: string;
  deadline_at: string;
}

/**
 * Fila IntHealth (PK T#{t}#INT#{id} · SK HEALTH). Atributos planos `last_event_at:<evento>`
 * (una entrada por tipo de evento) + caché de los checks contra la API del proveedor.
 */
export interface IntHealthItem {
  PK: string;
  SK: 'HEALTH';
  entity: 'IntHealth';
  tenant_id: string;
  integration_id: string;
  last_delivery_at?: string;
  last_valid_delivery_at?: string;
  last_accepted_at?: string;
  last_rejected_signature_at?: string;
  last_error?: string | null;
  last_error_at?: string;
  provider_checks?: CheckResult[];
  checked_at?: string;
  last_test?: IntegrationHealth['last_test'];
  [k: string]: unknown;
}

/** Contador horario (PK T#{t}#INT#{id} · SK HEALTH#H#{yyyy-mm-ddThh}), TTL 3 días. */
export interface HealthBucketItem {
  SK: string;
  hour: string;
  accepted?: number;
  duplicate?: number;
  ignored?: number;
  rejected_signature?: number;
  rejected_other?: number;
}

export interface TestRunItem extends IntegrationTestRun {
  PK: string;
  SK: string;
  entity: 'IntTestRun';
  tenant_id: string;
  expect: TestExpectation;
  deadline_at: string;
  triggered_at: string | null;
  expires_at: number;
}

/** Hook tal como lo devuelve el proveedor (normalizado). */
export interface HookInfo {
  id: string;
  url: string;
  active: boolean;
  events: string[];
}

export interface ProviderDelivery {
  status_code: number;
  event: string;
  delivered_at: string;
}

/** Datos locales (baratos, sin API del proveedor) con los que se evalúan los checks. */
export interface LocalHealthInput {
  now: string;
  role: Role;
  provider: string;
  status: 'pending' | 'active' | 'disabled';
  health: IntHealthItem | null;
  deliveries_24h: Record<DeliveryOutcome, number>;
  last_test: TestRunItem | null;
  /** solo repositorio */
  ide_sessions_7d?: number;
  unverified_commits?: number;
  /** solo tareas */
  unknown_task_keys?: string[];
  has_credentials: boolean;
}
