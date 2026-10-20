import type { Integration, IntegrationProvider } from '@magicode/contracts';
import type { PendingTest } from '../integration-health/integration-health.types';

/**
 * Fila `Integration` (PK T#{t} · SK INT#{id}). NUNCA lleva el secreto: es lo que lista el dashboard.
 * `base_url` (Jira/Linear) se guarda para construir enlaces a la tarea.
 */
export interface IntegrationItem extends Integration {
  PK: string;
  SK: string;
  entity: 'Integration';
  key_id: string;
  base_url?: string;
  updated_at: string;
  disabled_at?: string;
  /** write-back configurado (las credenciales viven en Secrets Manager, nunca aquí) */
  credentials_configured_at?: string;
  provenance: 'real';
}

/**
 * Fila `IntLookup` (PK INT#{id} · SK META). La resuelve el webhook (que no trae API key) para
 * obtener tenant + proyecto + secreto HMAC. Es la ÚNICA fila que guarda el secreto.
 */
export interface IntLookupItem {
  PK: string;
  SK: 'META';
  entity: 'IntLookup';
  integration_id: string;
  tenant_id: string;
  key_id: string;
  project_id: string;
  provider: IntegrationProvider;
  repository?: string;
  task_project_keys?: string[];
  base_url?: string;
  /** 32 bytes hex — cifrado en reposo por DynamoDB (ver docs/integrations.md) */
  secret: string;
  status: Integration['status'];
  created_at: string;
  updated_at: string;
  secret_rotated_at?: string;
  /** write-back: accountId de la cuenta de servicio (anti-bucle) y campos que gestiona MagiCode */
  service_account_id?: string;
  managed_field_ids?: string[];
  credentials_configured_at?: string;
  /** id del webhook en el proveedor (register-webhook / descubierto por health) */
  provider_hook_id?: string;
  /** prueba de ida y vuelta pendiente (la completa la próxima entrega que encaje) */
  pending_test?: PendingTest | null;
}

export interface CallerScope {
  tenant_id: string;
  key_id: string;
}
