import type { DataSource, Provenance, UsageGranularity, UsageRecord, UsageResponse } from '@magicode/contracts';

/** Marcador de cobertura de sincronización por key (SK `U#sync#latest`). */
export interface UsageSyncMarker {
  granularity: UsageGranularity;
  covered_from: string;
  covered_to: string;
  synced_at: string;
  provenance: Provenance;
  source: DataSource;
  /** MagiHub rechazó granularity=request ⇒ no se reintenta en cada sync */
  request_unsupported?: boolean;
  ingestion_delay_minutes?: number;
}

/** Registro de usage guardado (UsageSnapshot). */
export interface UsageSnapshotItem extends UsageRecord {
  PK: string;
  SK: string;
  entity: 'UsageSnapshot';
  tenant_id: string;
  key_id: string;
  granularity: UsageGranularity;
  simulated: boolean;
  provenance: Provenance;
  source: DataSource;
  synced_at: string;
  created_at: string;
  updated_at: string;
}

export interface UsageWindowResult {
  response: UsageResponse;
  granularity: UsageGranularity;
  provenance: Provenance;
  source: DataSource;
  synced: boolean;
  synced_at: string | null;
}
