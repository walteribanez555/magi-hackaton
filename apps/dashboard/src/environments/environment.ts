/**
 * Desarrollo local. La URL real del API llega en runtime desde `/config.json`
 * (en AWS lo escribe CDK en el bucket); `apiUrl` aquí es solo el respaldo si falta.
 */
export const environment = {
  production: false,
  /** true ⇒ el API se sirve con fixtures locales ("Datos de ejemplo"), sin backend. */
  useMocks: false,
  apiUrl: 'http://localhost:3000',
  buildVersion: 'dev',
};
