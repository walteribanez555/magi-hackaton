export enum Environment {
  DEVELOPMENT = 'development',
  STAGING = 'staging',
  PRODUCTION = 'production',
}

export type MagiHubMode = 'real' | 'mock';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppConfig {
  environment: Environment;
  logLevel: LogLevel;
  tableName: string;
  /** solo local: endpoint de dynamodb-local */
  dynamoEndpoint?: string;
  region: string;
  cors: { origins: string[]; methods: string[]; headers: string[] };
  magihub: {
    baseUrl: string;
    /** mock ⇒ toda cifra de tokens es `simulated` con source `magihub-mock` */
    mode: MagiHubMode;
    usagePath: string;
    keysSelfPath: string;
    timeoutMs: number;
  };
  auth: {
    cacheTtlSeconds: number;
    /**
     * Modo demo de acceso abierto: sin `Authorization`, la petición actúa con `demoApiKey`
     * (tenant/key de demo). Solo para la demo; nunca se habilita en producción.
     */
    demoOpenAccess: boolean;
    demoApiKey?: string;
  };
  usage: { staleSeconds: number; maxWindowDays: number };
  /** entornos cuyo Deployment success cuenta como "desplegado" (DEPLOY_PRODUCTION_ENVIRONMENTS) */
  deployments: { productionEnvironments: string[] };
  /** secreto RDS (JSON {host,port,username,password,dbname}) — solo projector/migrator */
  dbSecretArn?: string;
}

/**
 * Config singleton. Se lee de process.env de forma perezosa y puede recargarse con `reload()`
 * después de `waitForSecrets()` (en Lambda, APP_SECRET_ARN se mezcla en process.env en el cold start).
 */
class Config {
  private static instance: Config;
  private config?: AppConfig;

  static getInstance(): Config {
    if (!Config.instance) Config.instance = new Config();
    return Config.instance;
  }

  private load(): AppConfig {
    const env = (process.env.APP_ENV || 'development') as Environment;
    const e = process.env;
    const mode: MagiHubMode = e.MAGIHUB_MODE === 'real' ? 'real' : 'mock';
    return {
      environment: env,
      logLevel: (e.LOG_LEVEL as LogLevel) || (env === Environment.PRODUCTION ? 'info' : 'debug'),
      tableName: e.TABLE_NAME || 'magicode-dev-productivity',
      dynamoEndpoint: e.DYNAMO_ENDPOINT || undefined,
      region: e.AWS_REGION || e.AWS_DEFAULT_REGION || 'us-east-1',
      cors: {
        origins: (e.CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        headers: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With', 'X-Request-Id'],
      },
      magihub: {
        baseUrl: (e.MAGIHUB_BASE_URL || 'http://localhost:4010').replace(/\/+$/, ''),
        mode,
        usagePath: e.MAGIHUB_USAGE_PATH || '/v1/usage',
        keysSelfPath: e.MAGIHUB_KEYS_SELF_PATH || '/v1/keys/self',
        timeoutMs: Number(e.MAGIHUB_TIMEOUT_MS || 5000),
      },
      auth: {
        cacheTtlSeconds: Number(e.AUTH_CACHE_TTL_SECONDS || 300),
        demoOpenAccess: e.DEMO_OPEN_ACCESS === 'true' && env !== Environment.PRODUCTION && !!e.DEMO_API_KEY,
        demoApiKey: e.DEMO_API_KEY || undefined,
      },
      usage: {
        staleSeconds: Number(e.USAGE_STALE_SECONDS || 300),
        maxWindowDays: Number(e.USAGE_MAX_WINDOW_DAYS || 90),
      },
      deployments: {
        productionEnvironments: (e.DEPLOY_PRODUCTION_ENVIRONMENTS || 'production,prod')
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      },
      dbSecretArn: e.DB_SECRET_ARN || undefined,
    };
  }

  get(): AppConfig {
    return (this.config ??= this.load());
  }
  getValue<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.get()[key];
  }
  /** vuelve a leer process.env (tras cargar secretos o en tests) */
  reload(): AppConfig {
    this.config = this.load();
    return this.config;
  }
  isProduction(): boolean {
    return this.get().environment === Environment.PRODUCTION;
  }
}

export const config = Config.getInstance();
export default config;
