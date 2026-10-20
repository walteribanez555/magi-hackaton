import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, NodejsFunctionProps, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { DynamoEventSource, SqsDlq } from 'aws-cdk-lib/aws-lambda-event-sources';
import { HttpApi, HttpMethod, CorsHttpMethod, CfnStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as triggers from 'aws-cdk-lib/triggers';
// import * as acm from 'aws-cdk-lib/aws-certificatemanager';     // ← dominio propio (ver hook abajo)
// import * as route53 from 'aws-cdk-lib/aws-route53';
// import * as targets from 'aws-cdk-lib/aws-route53-targets';

/** Entidades operativas que el proyector NO replica a Postgres (outbox, idempotencia, webhooks). */
const PROJECTOR_IGNORED = ['OutboxAction', 'ActionIdem', 'WebhookDelivery'];

export interface MagicodeStackProps extends cdk.StackProps {
  /** Nombre del entorno: dev | staging | prod. */
  environment: string;

  /**
   * Desplegar el MagiHub SIMULADO (Lambda + HTTP API propios). Default true. Con `false`
   * es obligatorio `magihubBaseUrl` (MagiHub real).
   */
  deployMock?: boolean;
  /**
   * Demo sin login: la API acepta peticiones sin Authorization como la key de demo del mock.
   * Por defecto activo solo fuera de prod y con el mock (la key `mh_demo_*` no es un secreto).
   */
  demoOpenAccess?: boolean;

  /**
   * Base URL de MagiHub. Si no viene, la API usa la URL del mock desplegado aquí
   * (`MAGIHUB_MODE=mock`); si viene, `MAGIHUB_MODE=real`.
   */
  magihubBaseUrl?: string;

  /**
   * Carpeta del build de Angular a subir al bucket del dashboard. Default
   * `apps/dashboard/dist/dashboard/browser`; solo se sube si existe al sintetizar.
   */
  dashboardDistDir?: string;

  /**
   * Postgres EXTERNO para la réplica analítica (p. ej. la base `magicode` en la caja
   * CoolfixCore, `db-core.coolfix.com.bo`, TLS). Nombre del secreto JSON
   * {host,port,username,password,dbname}. Con él, proyector y migrador van FUERA de la VPC
   * (necesitan internet para llegar al host) y usan ese secreto en vez del de la RDS.
   */
  externalDbSecretName?: string;
}

/**
 * Infraestructura de MagiCode (tokens MagiHub ↔ código útil).
 *
 * Recursos que crea este stack:
 *   - DynamoDB `magicode-<env>-productivity` (single-table, ver packages/contracts/src/keys.ts).
 *     Store operativo PRIMARIO del MVP ("momentáneo"): la API escribe/lee aquí. Stream
 *     NEW_AND_OLD_IMAGES → Lambda proyector → RDS.
 *   - RDS PostgreSQL 16 (db.t4g.micro, single-AZ): réplica ANALÍTICA alimentada por el stream;
 *     a futuro pasa a ser el store primario. A diferencia de coolfix (RDS preexistente y
 *     pública con TLS), aquí la RDS es NUEVA, la gestiona este stack y es PRIVADA.
 *   - apps/api                 → Lambda `magicode-<env>-api` (Hono) + HTTP API (API Gateway v2).
 *   - apps/api (projector.ts)  → Lambda en VPC consumiendo el stream de Dynamo (DLQ SQS).
 *   - apps/api (migrator.ts)   → Lambda en VPC que corre las migraciones en CADA deploy
 *                                (aws-cdk-lib/triggers) tras crear la BD.
 *   - services/magihub-mock    → Lambda + HTTP API propios: MagiHub SIMULADO (tag simulated=true).
 *   - apps/dashboard           → estático S3 privado (OAC) + CloudFront (SPA Angular) +
 *                                `/config.json` con la URL de la API leída en runtime.
 *   - Webhooks de integraciones: misma HTTP API (POST /api/v1/webhooks/{provider}/{id});
 *     su dedupe vive en Dynamo con TTL `expires_at` (30 días).
 *   - Write-back a Jira (outbox): la API escribe ítems `OutboxAction` (status=pending) y
 *     TaskSyncFn (fuera de VPC) los consume del stream filtrado y llama a Jira. Los tokens
 *     de integraciones viven en Secrets Manager `magicode/<env>/integrations/*`.
 *   - Scoring XGBoost: la API invoca endpoints SageMaker `magicode-<env>-{survival,rework}`
 *     que crea el stack OPCIONAL MagicodeMlStack (`-c deployMl=true`); sin ellos, heurística.
 *
 * Red (decisión de costos):
 *   - VPC nueva, 2 AZ, SIN NAT Gateway (natGateways: 0 → ahorra ~US$33/mes por NAT).
 *   - Subredes PUBLIC (vacías por ahora: hook para un bastion futuro) + PRIVATE_ISOLATED
 *     (RDS + Lambdas en VPC). RDS exige un subnet group en ≥2 AZ aunque sea single-AZ.
 *   - Sin NAT, las Lambdas en VPC no tienen internet: se cubren con endpoints
 *       · Gateway endpoint DynamoDB (gratis).
 *       · UN interface endpoint de Secrets Manager en UNA sola subred/AZ (~US$7.3/mes) para
 *         leer el secreto de la BD. La otra AZ lo alcanza cross-AZ (DNS privado del endpoint).
 *   - La API (ApiFn) y el mock NO van en VPC: la API necesita internet para llamar a MagiHub
 *     y no toca la RDS (escribe en Dynamo; el proyector replica a Postgres).
 *   - SG de la BD: 5432 SOLO desde el SG de las Lambdas (proyector/migrador). Sin acceso
 *     público; para consultas ad-hoc, añadir un bastion en la subred pública (o SSM).
 */
export class MagicodeStack extends cdk.Stack {
  /** Tabla single-table (la consume MagicodeMlStack para features/etiquetas). */
  public readonly table: dynamodb.ITable;
  /** HTTP API principal. */
  public readonly api: HttpApi;

  constructor(scope: Construct, id: string, props: MagicodeStackProps) {
    super(scope, id, props);

    const env      = props.environment;                 // p.ej. 'dev'
    const isProd   = env === 'prod';
    const prefix   = `magicode-${env}`;
    const repoRoot = path.join(__dirname, '..', '..');
    const deployMock = props.deployMock ?? true;
    const demoOpenAccess = (props.demoOpenAccess ?? true) && !isProd && deployMock;

    if (!deployMock && !props.magihubBaseUrl) {
      throw new Error('deployMock=false requiere el contexto magihubBaseUrl (MagiHub real).');
    }

    cdk.Tags.of(this).add('project', 'magicode');
    cdk.Tags.of(this).add('environment', env);

    // ── DynamoDB single-table (store operativo del MVP) ─────────────────────────
    // PK/SK + GSI1 genéricos (keys.ts). On-demand: tráfico de demo ≈ US$0. PITR activo.
    // Stream NEW_AND_OLD_IMAGES: el proyector necesita la imagen vieja para deletes/updates.
    const table = new dynamodb.Table(this, 'ProductivityTable', {
      tableName:    `${prefix}-productivity`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode:  dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      stream:       dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      // TTL: los ítems de dedupe de entregas de webhooks expiran a los 30 días (epoch s).
      timeToLiveAttribute: 'expires_at',
      encryption:   dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
    table.addGlobalSecondaryIndex({
      indexName:      'GSI1',
      partitionKey:   { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey:        { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    this.table = table;

    // ── VPC (sin NAT) + endpoints ───────────────────────────────────────────────
    const vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName:     prefix,
      maxAzs:      2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public',   subnetType: ec2.SubnetType.PUBLIC,           cidrMask: 24 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    const isolatedSubnets: ec2.SubnetSelection = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };

    vpc.addGatewayEndpoint('DynamoDbEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
      subnets: [isolatedSubnets],
    });
    // UNA sola AZ a propósito (cada AZ extra suma ~US$7.3/mes). Sin HA del endpoint: si esa
    // AZ cae, las Lambdas en VPC no leen el secreto (aceptable para el MVP).
    const secretsEndpoint = vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service:           ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets:           { subnets: [vpc.isolatedSubnets[0]] },
      privateDnsEnabled: true,
    });

    // ── Security groups ─────────────────────────────────────────────────────────
    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc,
      securityGroupName: `${prefix}-lambda`,
      description:       'Lambdas en VPC (proyector, migrador) hacia RDS y endpoints',
      allowAllOutbound:  true,
    });
    const dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc,
      securityGroupName: `${prefix}-db`,
      description:       'RDS PostgreSQL: 5432 solo desde el SG de las Lambdas',
      allowAllOutbound:  false,
    });
    dbSg.addIngressRule(lambdaSg, ec2.Port.tcp(5432), 'Postgres desde Lambdas en VPC');

    // ── RDS PostgreSQL (réplica analítica; futuro store primario) ───────────────
    // 16.15 = última 16.x disponible en us-east-1 (describe-db-engine-versions, 2026-10).
    // El enum de CDK llega solo a 16.13 → versión explícita.
    const engine = rds.DatabaseInstanceEngine.postgres({
      version: rds.PostgresEngineVersion.of('16.15', '16'),
    });
    const dbParams = new rds.ParameterGroup(this, 'DbParams', {
      engine,
      description: `${prefix} postgres16 (TLS obligatorio)`,
      parameters:  { 'rds.force_ssl': '1' },
    });
    const db = new rds.DatabaseInstance(this, 'Db', {
      instanceIdentifier: `${prefix}-db`,
      engine,
      instanceType:       ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets:         isolatedSubnets,
      securityGroups:     [dbSg],
      publiclyAccessible: false,
      multiAz:            false,
      allocatedStorage:   20,
      storageType:        rds.StorageType.GP3,
      storageEncrypted:   true,
      databaseName:       'magicode',
      credentials:        rds.Credentials.fromGeneratedSecret('magicode_admin', {
        secretName: `magicode/${env}/db`,
      }),
      parameterGroup:     dbParams,
      backupRetention:    cdk.Duration.days(isProd ? 7 : 1),
      deletionProtection: isProd,
      removalPolicy:      cdk.RemovalPolicy.SNAPSHOT,
      autoMinorVersionUpgrade: true,
      enablePerformanceInsights: false,
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: logs.RetentionDays.TWO_WEEKS,
    });
    const rdsSecret = db.secret!;

    // Réplica analítica efectiva: Postgres externo (si se configuró) o la RDS de este stack.
    const externalDb = props.externalDbSecretName
      ? secretsmanager.Secret.fromSecretNameV2(this, 'ExternalDbSecret', props.externalDbSecretName)
      : undefined;
    const dbSecret: secretsmanager.ISecret = externalDb ?? rdsSecret;

    // ── Config común de las Lambdas ─────────────────────────────────────────────
    const lambdaCommon: Partial<NodejsFunctionProps> = {
      runtime:      lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler:      'handler',                          // export `handler` en cada entry
      timeout:      cdk.Duration.seconds(15),
      memorySize:   512,
      // Los entries viven fuera de infra/ (apps/*, services/*) → fijar el root del monorepo
      // para que NodejsFunction resuelva el bundling (workspaces) y el lockfile raíz.
      projectRoot:      repoRoot,
      depsLockFilePath: path.join(repoRoot, 'package-lock.json'),
      bundling: {
        minify:          true,
        sourceMap:       true,                          // + NODE_OPTIONS=--enable-source-maps
        target:          'node22',
        format:          OutputFormat.CJS,
        // AWS SDK v3 ya viene en el runtime; pg-native es opcional en `pg` y no se usa.
        externalModules: ['@aws-sdk/*', 'pg-native'],
      },
    };
    // Con Postgres externo, proyector y migrador no van en VPC (sin NAT no habría salida).
    const vpcCommon: Partial<NodejsFunctionProps> = externalDb ? {} : {
      vpc,
      vpcSubnets:     isolatedSubnets,
      securityGroups: [lambdaSg],
    };
    const baseEnv = {
      APP_ENV:      env,
      NODE_OPTIONS: '--enable-source-maps',
    };

    // LogGroup explícito por función (logRetention está deprecado): 2 semanas.
    const makeFn = (id: string, name: string, props: NodejsFunctionProps) => {
      const functionName = `${prefix}-${name}`;
      const logGroup = new logs.LogGroup(this, `${id}Logs`, {
        logGroupName:  `/aws/lambda/${functionName}`,
        retention:     logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      return new NodejsFunction(this, id, {
        ...lambdaCommon,
        ...props,
        functionName,
        logGroup,
      });
    };

    // ── MagiHub SIMULADO (mock) ─────────────────────────────────────────────────
    // Implementa el contrato MagiHub (Smart Auto + usage + keys/self) para dev/demo.
    // Guarda su estado en la misma tabla (prefijos propios, MOCK_TABLE_NAME).
    let mockApi: HttpApi | undefined;
    if (deployMock) {
      const mockFn = makeFn('MagiHubMockFn', 'magihub-mock', {
        description: 'MagiHub SIMULADO (mock del contrato MagiHub)',
        entry:       path.join(repoRoot, 'services/magihub-mock/src/index.ts'),
        environment: { ...baseEnv, MOCK_TABLE_NAME: table.tableName },
      });
      table.grantReadWriteData(mockFn);

      mockApi = new HttpApi(this, 'MagiHubMockHttpApi', {
        apiName:            `${prefix}-magihub-mock`,
        description:        'MagiHub SIMULADO',
        defaultIntegration: new HttpLambdaIntegration('MagiHubMockIntegration', mockFn),
      });
      cdk.Tags.of(mockFn).add('simulated', 'true');
      cdk.Tags.of(mockApi).add('simulated', 'true');
    }
    const magihubBaseUrl = props.magihubBaseUrl ?? mockApi!.apiEndpoint;
    const magihubMode    = props.magihubBaseUrl ? 'real' : 'mock';

    // ── Dashboard (S3 privado + CloudFront OAC, SPA Angular) ────────────────────
    // Va antes de la API: su URL entra en CORS_ORIGINS. defaultRootObject=index.html y
    // 403/404 → /index.html para que el router de Angular resuelva las rutas en cliente.
    const dashboardBucket = new s3.Bucket(this, 'DashboardSiteBucket', {
      bucketName:        `${prefix}-dashboard-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption:        s3.BucketEncryption.S3_MANAGED,
      enforceSSL:        true,
      removalPolicy:     isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    // Hook dominio propio (como coolfix): con cert ACM us-east-1 + zona Route53, pasar
    // `domainNames`/`certificate` a la distribución y crear alias A/AAAA:
    //   const certificate = acm.Certificate.fromCertificateArn(this, 'Cert', '<arn us-east-1>');
    //   const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId, zoneName });
    //   domainNames: [`app${isProd ? '' : `-${env}`}.<dominio>`], certificate,
    //   new route53.ARecord(this, 'DashboardAliasA', { zone, recordName, target:
    //     route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)) });
    const distribution = new cloudfront.Distribution(this, 'DashboardDistribution', {
      comment:           `${prefix} dashboard`,
      defaultRootObject: 'index.html',
      priceClass:        cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin:               origins.S3BucketOrigin.withOriginAccessControl(dashboardBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy:          cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(5) },
      ],
    });
    const dashboardUrl = `https://${distribution.distributionDomainName}`;
    const corsOrigins  = [dashboardUrl, 'http://localhost:4200'];

    // Secretos por integración (tokens OAuth/API de Jira, etc.) que crea la API en runtime.
    const integrationSecretsArn =
      `arn:${this.partition}:secretsmanager:${this.region}:${this.account}:secret:magicode/${env}/integrations/*`;

    // ── API (Hono) ──────────────────────────────────────────────────────────────
    // Fuera de VPC: necesita internet para MagiHub. Lee/escribe solo en Dynamo.
    const apiFn = makeFn('ApiFn', 'api', {
      description: 'MagiCode API (Hono)',
      entry:       path.join(repoRoot, 'apps/api/src/index.ts'),
      environment: {
        ...baseEnv,
        TABLE_NAME:       table.tableName,
        DASHBOARD_URL:    dashboardUrl,
        CORS_ORIGINS:     corsOrigins.join(','),
        MAGIHUB_BASE_URL: magihubBaseUrl,
        MAGIHUB_MODE:     magihubMode,
        ...(demoOpenAccess ? { DEMO_OPEN_ACCESS: 'true', DEMO_API_KEY: 'mh_demo_walter' } : {}),
        // Scoring XGBoost (SageMaker Serverless, MagicodeMlStack opcional). Siempre se
        // fijan: si el endpoint no existe, la API cae a la heurística local.
        SCORING_SURVIVAL_ENDPOINT: `${prefix}-survival`,
        SCORING_REWORK_ENDPOINT:   `${prefix}-rework`,
      },
    });
    table.grantReadWriteData(apiFn);
    apiFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['sagemaker:InvokeEndpoint'],
      resources: [`arn:${this.partition}:sagemaker:${this.region}:${this.account}:endpoint/${prefix}-*`],
    }));
    apiFn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'secretsmanager:CreateSecret',
        'secretsmanager:PutSecretValue',
        'secretsmanager:GetSecretValue',
        'secretsmanager:DescribeSecret',
        'secretsmanager:TagResource',
      ],
      resources: [integrationSecretsArn],
    }));

    // ── HTTP API (API Gateway v2, proxy total → Lambda) ─────────────────────────
    // Los webhooks (POST /api/v1/webhooks/{provider}/{integrationId}) entran por la misma
    // ruta /{proxy+}; el CORS no les aplica (server-to-server).
    const api = new HttpApi(this, 'ApiHttpApi', {
      apiName: `${prefix}-api`,
      corsPreflight: {
        allowOrigins: corsOrigins,
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.PUT, CorsHttpMethod.PATCH, CorsHttpMethod.DELETE, CorsHttpMethod.OPTIONS],
        allowHeaders: ['authorization', 'content-type'],
        maxAge:       cdk.Duration.hours(1),
      },
    });
    this.api = api;
    // Sin ciclo: el Api no depende de la Lambda (solo Integration/Route/Permission).
    apiFn.addEnvironment('PUBLIC_API_URL', api.apiEndpoint);
    const apiIntegration = new HttpLambdaIntegration('ApiIntegration', apiFn);
    api.addRoutes({ path: '/',          methods: [HttpMethod.ANY], integration: apiIntegration });
    api.addRoutes({ path: '/{proxy+}',  methods: [HttpMethod.ANY], integration: apiIntegration });

    // ── Access logs (JSON, 2 semanas) + throttling por defecto ──────────────────
    // HttpApi (L2) no expone accessLogSettings: se fija en el CfnStage (igual que coolfix).
    const apiAccessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName:  `/aws/apigateway/${prefix}-api-access`,
      retention:     logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const apiStage = api.defaultStage!.node.defaultChild as CfnStage;
    apiStage.accessLogSettings = {
      destinationArn: apiAccessLogs.logGroupArn,
      format: JSON.stringify({
        requestId:       '$context.requestId',
        requestTime:     '$context.requestTime',
        ip:              '$context.identity.sourceIp',
        httpMethod:      '$context.httpMethod',
        routeKey:        '$context.routeKey',
        path:            '$context.path',
        status:          '$context.status',
        responseLatency: '$context.responseLatency',
        integrationError: '$context.integrationErrorMessage',
      }),
    };
    apiStage.defaultRouteSettings = {
      throttlingBurstLimit: 50,
      throttlingRateLimit:  25,
    };

    // ── Proyector: stream Dynamo → RDS ──────────────────────────────────────────
    // Lotes de 100, bisección en error + reportBatchItemFailures (el handler devuelve
    // `batchItemFailures`), 3 reintentos y luego el registro va a la DLQ (SQS, 14 días).
    const projectorDlq = new sqs.Queue(this, 'ProjectorDlq', {
      queueName:       `${prefix}-projector-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      encryption:      sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL:      true,
    });
    const projectorFn = makeFn('ProjectorFn', 'projector', {
      ...vpcCommon,
      description: externalDb ? 'Proyector DynamoDB stream → PostgreSQL externo' : 'Proyector DynamoDB stream → RDS PostgreSQL',
      entry:       path.join(repoRoot, 'apps/api/src/projector.ts'),
      timeout:     cdk.Duration.seconds(60),
      environment: { ...baseEnv, DB_SECRET_ARN: dbSecret.secretArn },
    });
    dbSecret.grantRead(projectorFn);
    projectorFn.addEventSource(new DynamoEventSource(table, {
      startingPosition:        lambda.StartingPosition.TRIM_HORIZON,
      batchSize:               100,
      bisectBatchOnError:      true,
      retryAttempts:           3,
      reportBatchItemFailures: true,
      onFailure:               new SqsDlq(projectorDlq),
      // Filtro (gratis, en el poller): descarta el ruido operativo que no va a Postgres.
      // Los filtros se combinan con OR: INSERT/MODIFY por NewImage y REMOVE por OldImage
      // (sin el 2º, los deletes no llegarían: no traen NewImage).
      filters: [
        lambda.FilterCriteria.filter({
          dynamodb: { NewImage: { entity: { S: { 'anything-but': PROJECTOR_IGNORED } } } },
        }),
        lambda.FilterCriteria.filter({
          eventName: lambda.FilterRule.isEqual('REMOVE'),
          dynamodb:  { OldImage: { entity: { S: { 'anything-but': PROJECTOR_IGNORED } } } },
        }),
      ],
    }));

    // ── Task sync: outbox → Jira (write-back) ───────────────────────────────────
    // Fuera de VPC (Jira por internet). Solo recibe ítems OutboxAction pendientes (filtro
    // en el poller). LATEST: el outbox histórico no se reprocesa al crear el mapping.
    const taskSyncDlq = new sqs.Queue(this, 'TaskSyncDlq', {
      queueName:       `${prefix}-task-sync-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      encryption:      sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL:      true,
    });
    const taskSyncFn = makeFn('TaskSyncFn', 'task-sync', {
      description: 'Outbox → Jira (write-back de tareas)',
      entry:       path.join(repoRoot, 'apps/api/src/task-sync.ts'),
      timeout:     cdk.Duration.seconds(30),
      environment: {
        ...baseEnv,
        TABLE_NAME:    table.tableName,
        DASHBOARD_URL: dashboardUrl,
      },
    });
    table.grantReadWriteData(taskSyncFn);
    taskSyncFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['secretsmanager:GetSecretValue'],
      resources: [integrationSecretsArn],
    }));
    taskSyncFn.addEventSource(new DynamoEventSource(table, {
      startingPosition:        lambda.StartingPosition.LATEST,
      batchSize:               10,
      bisectBatchOnError:      true,
      retryAttempts:           5,
      reportBatchItemFailures: true,
      onFailure:               new SqsDlq(taskSyncDlq),
      filters: [
        lambda.FilterCriteria.filter({
          dynamodb: {
            NewImage: {
              entity: { S: lambda.FilterRule.isEqual('OutboxAction') },
              status: { S: lambda.FilterRule.isEqual('pending') },
            },
          },
        }),
      ],
    }));

    // ── Migrador: corre en cada deploy que cambie su código (triggers) ──────────
    // Se ejecuta DESPUÉS de la BD, su secreto (con host adjunto), la regla del SG y el
    // endpoint de Secrets Manager. Si falla, el deploy falla (RequestResponse).
    const migratorFn = makeFn('MigratorFn', 'migrator', {
      ...vpcCommon,
      description: 'Migraciones de esquema PostgreSQL (trigger de deploy)',
      entry:       path.join(repoRoot, 'apps/api/src/migrator.ts'),
      timeout:     cdk.Duration.minutes(2),
      environment: { ...baseEnv, DB_SECRET_ARN: dbSecret.secretArn },
    });
    dbSecret.grantRead(migratorFn);
    new triggers.Trigger(this, 'MigratorTrigger', {
      handler:                migratorFn,
      executeAfter:           externalDb ? [] : [db, rdsSecret, dbSg, secretsEndpoint],
      executeOnHandlerChange: true,
      timeout:                cdk.Duration.minutes(3),
    });

    // ── Contenido del dashboard + /config.json (runtime config) ─────────────────
    // config.json SIEMPRE se escribe; el build de Angular solo si existe al sintetizar.
    // Un único BucketDeployment (prune) para que las fuentes no se borren entre sí.
    const dashboardDist = props.dashboardDistDir
      ?? path.join(repoRoot, 'apps/dashboard/dist/dashboard/browser');
    const dashboardSources: s3deploy.ISource[] = [];
    if (fs.existsSync(dashboardDist)) {
      dashboardSources.push(s3deploy.Source.asset(dashboardDist));
    }
    dashboardSources.push(s3deploy.Source.jsonData('config.json', {
      apiUrl:      api.apiEndpoint,
      environment: env,
      demoMode:    demoOpenAccess, // el dashboard entra sin pedir API key
    }));
    new s3deploy.BucketDeployment(this, 'DashboardDeployment', {
      destinationBucket: dashboardBucket,
      sources:           dashboardSources,
      distribution,
      distributionPaths: ['/*'],
      memoryLimit:       512,
    });

    // ── Outputs ─────────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiUrl',          { value: api.apiEndpoint, description: 'Base URL de la API (HTTP API)' });
    new cdk.CfnOutput(this, 'WebhookBaseUrl',  {
      value: `${api.apiEndpoint}/api/v1/webhooks`,
      description: 'Base de webhooks: <WebhookBaseUrl>/{provider}/{integrationId}',
    });
    new cdk.CfnOutput(this, 'MagiHubMockUrl',  {
      value: mockApi ? mockApi.apiEndpoint : 'not-deployed',
      description: 'URL del MagiHub SIMULADO',
    });
    new cdk.CfnOutput(this, 'DashboardUrl',    { value: dashboardUrl, description: 'URL pública del dashboard' });
    new cdk.CfnOutput(this, 'DashboardBucket', { value: dashboardBucket.bucketName });
    new cdk.CfnOutput(this, 'DistributionId',  { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'TableName',       { value: table.tableName });
    new cdk.CfnOutput(this, 'TableStreamArn',  { value: table.tableStreamArn! });
    new cdk.CfnOutput(this, 'DbEndpoint',      { value: db.dbInstanceEndpointAddress, description: 'RDS de este stack' });
    new cdk.CfnOutput(this, 'DbSecretArn',     { value: dbSecret.secretArn, description: externalDb ? 'Postgres externo en uso' : 'RDS en uso' });
    new cdk.CfnOutput(this, 'VpcId',           { value: vpc.vpcId });
  }
}
