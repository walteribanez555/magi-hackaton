import { HttpErrorResponse, type HttpParams } from '@angular/common/http';

export interface MockResult {
  status?: number;
  body: unknown;
}

/** Router de fixtures ("Datos de ejemplo"). undefined ⇒ 404. */
export function handleMock(
  method: string,
  path: string,
  params: HttpParams,
  body: unknown,
): MockResult | HttpErrorResponse | undefined {
  void params;
  void body;
  if (method === 'GET' && path === '/whoami') {
    return { body: { tenant_id: 'acme-retail', key_id: 'key_8f3a91c2', key_name: 'Acme Retail · dev', scopes: [] } };
  }
  return undefined;
}
