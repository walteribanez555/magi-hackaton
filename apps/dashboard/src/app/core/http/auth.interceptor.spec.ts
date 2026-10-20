import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { SessionService } from '@/core/auth/session.service';
import { RuntimeConfigService } from '@/core/config/runtime-config.service';
import { authInterceptor } from './auth.interceptor';

describe('authInterceptor', () => {
  let http: HttpClient;
  let ctrl: HttpTestingController;
  let session: SessionService;
  const api = (TestBed: unknown) => void TestBed;

  beforeEach(() => {
    api(null);
    try {
      sessionStorage.clear();
    } catch {
      /* noop */
    }
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    ctrl = TestBed.inject(HttpTestingController);
    session = TestBed.inject(SessionService);
  });

  const base = () => TestBed.inject(RuntimeConfigService).apiUrl;

  it('añade el Bearer solo hacia el API', () => {
    session.set('mh_secret_key', { tenant_id: 't', key_id: 'key_1', scopes: [] });
    http.get(`${base()}/api/v1/whoami`).subscribe();
    http.get('kb/index.json').subscribe();
    http.get('https://fonts.googleapis.com/css').subscribe();
    expect(ctrl.expectOne(`${base()}/api/v1/whoami`).request.headers.get('Authorization')).toBe('Bearer mh_secret_key');
    expect(ctrl.expectOne('kb/index.json').request.headers.has('Authorization')).toBe(false);
    expect(ctrl.expectOne('https://fonts.googleapis.com/css').request.headers.has('Authorization')).toBe(false);
    ctrl.verify();
  });

  it('sin key (modo demo) no envía Authorization', () => {
    http.get(`${base()}/api/v1/productivity/summary`).subscribe();
    expect(ctrl.expectOne(`${base()}/api/v1/productivity/summary`).request.headers.has('Authorization')).toBe(false);
    ctrl.verify();
  });
});
