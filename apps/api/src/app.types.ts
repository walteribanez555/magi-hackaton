import type { KeyIdentity } from '@magicode/contracts';
import type { ILogger } from './config/types';

/** Identidad derivada de la API key vía MagiHub (GET /v1/keys/self) — sin la key. */
export interface CallerIdentity extends KeyIdentity {
  /** sha256(key)[:12] — lo único que se persiste de la key */
  key_fingerprint: string;
}

export interface AppVariables {
  identity: CallerIdentity;
  tenant_id: string;
  key_id: string;
  key_fingerprint: string;
  /**
   * API key cruda: vive SOLO en el contexto de esta petición para llamar a MagiHub con la
   * key del propio usuario (usage). Nunca se loguea, ni se guarda, ni se devuelve.
   */
  apiKey: string;
  requestId: string;
  logger: ILogger;
}

export type AppEnv = { Variables: AppVariables };
