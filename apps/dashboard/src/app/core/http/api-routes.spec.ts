import * as contracts from '@magicode/contracts';

import { API_PREFIX, CRITICALITY_THRESHOLDS, ROUTES, WEBHOOK_SIGNATURE_HEADERS, buildPath } from './api-routes';

describe('api-routes (copia local de contracts)', () => {
  it('coincide con @magicode/contracts', () => {
    expect(API_PREFIX).toBe(contracts.API_PREFIX);
    expect(ROUTES).toEqual(contracts.ROUTES);
    expect(CRITICALITY_THRESHOLDS).toEqual(contracts.CRITICALITY_THRESHOLDS);
    expect(WEBHOOK_SIGNATURE_HEADERS).toEqual(contracts.WEBHOOK_SIGNATURE_HEADERS);
  });
  it('codifica parámetros (repo org/repo → org%2Frepo)', () => {
    expect(buildPath(ROUTES.repositoryReadiness, { repository: 'magihub/demo' })).toBe('/repositories/magihub%2Fdemo/readiness');
  });
});
