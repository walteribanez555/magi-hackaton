import type { KeyIdentity, UsageGranularity, UsageResponse } from '@magicode/contracts';

export interface UsageQuery {
  from: string;
  to: string;
  granularity: UsageGranularity;
}

/** Adaptador a MagiHub. La implementación real va por HTTP; los tests inyectan un fake. */
export interface MagiHubClient {
  /** GET {base}/v1/keys/self — identidad de la key (tenant, key_id). 401 ⇒ MagiHubAuthError */
  whoami(apiKey: string): Promise<KeyIdentity>;
  /** GET {base}/v1/usage — consumo por key + intervalo (fuente de verdad de tokens) */
  usage(apiKey: string, query: UsageQuery): Promise<UsageResponse>;
}

/** La key no es válida para MagiHub (401/403). */
export class MagiHubAuthError extends Error {
  constructor(readonly status: number) {
    super(`MagiHub rejected the API key (${status})`);
    this.name = 'MagiHubAuthError';
  }
}

/** MagiHub no soporta la granularidad pedida (400/404/422 sobre `granularity`). */
export class MagiHubUnsupportedError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'MagiHubUnsupportedError';
  }
}

/** Fallo de red, timeout, 5xx o respuesta que no cumple el contrato. */
export class MagiHubUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MagiHubUnavailableError';
  }
}
