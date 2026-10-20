import { HttpContextToken } from '@angular/common/http';

/** Petición que NO debe llevar el Bearer de la sesión (p. ej. /whoami con la key a validar). */
export const SKIP_AUTH = new HttpContextToken<boolean>(() => false);
/** Petición que no debe disparar el toast global de error (la página lo maneja). */
export const SILENT_ERRORS = new HttpContextToken<boolean>(() => false);
