export const environment = {
  production: true,
  /** Nunca fixtures en producción. */
  useMocks: false,
  /** Respaldo: en producción manda `/config.json` (escrito por CDK en el bucket). */
  apiUrl: '',
  buildVersion: 'prod',
};
