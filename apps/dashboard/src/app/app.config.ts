import {
  type ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import { provideTranslateHttpLoader } from '@ngx-translate/http-loader';
import { firstValueFrom } from 'rxjs';

import { RuntimeConfigService } from '@/core/config/runtime-config.service';
import { authInterceptor } from '@/core/http/auth.interceptor';
import { errorToastInterceptor } from '@/core/http/error-toast.interceptor';
import { mockInterceptor } from '@/core/http/mock.interceptor';
import { environment } from '../environments/environment';
import { routes } from './app.routes';

const I18N_VERSION = environment.buildVersion || 'dev';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: 'top', anchorScrolling: 'enabled' }),
    ),
    // Orden: auth (Bearer) → toast de error → mock (sirve fixtures si environment.useMocks).
    provideHttpClient(withFetch(), withInterceptors([authInterceptor, errorToastInterceptor, mockInterceptor])),
    provideTranslateService({
      lang: 'es',
      fallbackLang: 'es',
      loader: provideTranslateHttpLoader({ prefix: 'i18n/', suffix: `.json?v=${I18N_VERSION}` }),
    }),
    // Config de runtime (/config.json escrito por CDK) + traducciones antes del primer render.
    provideAppInitializer(async () => {
      const config = inject(RuntimeConfigService);
      const translate = inject(TranslateService);
      await config.load();
      try {
        await firstValueFrom(translate.use('es'));
      } catch {
        /* sin i18n: se ven las claves, la app sigue funcionando */
      }
    }),
  ],
};
