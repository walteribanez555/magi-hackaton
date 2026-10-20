import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';

export interface MagicodeMlStackProps extends cdk.StackProps {
  environment: string;
  /** tabla single-table de MagicodeStack (fuente del dataset REAL vía Scan) */
  table: dynamodb.ITable;
  /** habilita el cron semanal; default: contexto `mlRetrainSchedule` (default false) */
  retrainScheduleEnabled?: boolean;
}

/**
 * MagicodeMlStack — scoring XGBoost (OPCIONAL, `-c deployMl=true`). Replica la arquitectura
 * ML de walteribanez555/fraud-detector (infra/lib/base-stack.ts → "ML — Fraud Model Retraining"):
 *
 *   EventBridge Rule (semanal, DESHABILITADA por defecto: `-c mlRetrainSchedule=true`)
 *     → Lambda `magicode-<env>-ml-retrain-trigger`  (infra/lambda/ml-retrain-trigger.ts)
 *         → SageMaker Processing Job (ml.t3.medium, contenedor sklearn 1.2-1)
 *             → ml/train.py --deploy:
 *                 1. dataset REAL desde DynamoDB (Scan por `entity`) o SINTÉTICO si hay pocas filas
 *                 2. XGBoost survival + rework (instala xgboost 1.7.6 en el contenedor)
 *                 3. si AUC ≥ MIN_AUC y mejora al endpoint actual (metadata.json en S3)
 *                    → model.tar.gz a S3 + endpoint Serverless magicode-<env>-{survival,rework}
 *                 4. actualiza SCORING_TRAINED_ON / SCORING_MODEL_VERSION de la Lambda de la API
 *
 * Igual que fraud-detector, los ENDPOINTS NO se crean en CDK: los crea/actualiza train.py
 * (create_model → create_endpoint_config → create/update_endpoint). Motivo: el artefacto no
 * existe hasta el primer entrenamiento y el deploy es condicional al AUC. Consecuencia: un
 * `cdk destroy` NO borra los endpoints/modelos (ver ml/README.md → limpieza).
 *
 * La API siempre recibe SCORING_{SURVIVAL,REWORK}_ENDPOINT (MagicodeStack) y cae a la
 * heurística si el endpoint aún no existe.
 *
 * Costos: Serverless Inference sin tráfico = US$0 (se paga por ms de inferencia + datos);
 * el Processing Job ml.t3.medium ≈ US$0.05/h (unos minutos por corrida); S3 ≈ centavos.
 */
export class MagicodeMlStack extends cdk.Stack {
  public readonly mlBucket: s3.Bucket;
  public readonly smExecutionRole: iam.Role;
  public readonly retrainTriggerFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: MagicodeMlStackProps) {
    super(scope, id, props);

    const env = props.environment;
    const isProd = env === 'prod';
    const prefix = `magicode-${env}`;
    const repoRoot = path.join(__dirname, '..', '..');
    const apiFunctionName = `${prefix}-api`; // Lambda de la API (MagicodeStack → makeFn('ApiFn', 'api'))
    const scheduleCtx = this.node.tryGetContext('mlRetrainSchedule');
    const scheduleEnabled = props.retrainScheduleEnabled ?? String(scheduleCtx ?? 'false') === 'true';
    const arn = (resource: string) => `arn:${this.partition}:sagemaker:${this.region}:${this.account}:${resource}`;

    cdk.Tags.of(this).add('project', 'magicode');
    cdk.Tags.of(this).add('environment', env);
    cdk.Tags.of(this).add('component', 'ml-scoring');

    // ── S3 — datasets, código de entrenamiento, modelos y metadata ─────────────────────
    //   scoring/source/                     ← ml/ (BucketDeployment en cada deploy)
    //   scoring/<env>/dataset/              ← export_dataset.py (opcional, DATASET_SOURCE=s3)
    //   scoring/<env>/<model>/<version>/    ← model.tar.gz + metrics.json + model_card.md
    //   scoring/<env>/<model>/metadata.json ← lo que sirve HOY el endpoint (AUC de comparación)
    //   scoring/<env>/runs/<version>/       ← feature-importance.json por corrida (expira 90 d)
    this.mlBucket = new s3.Bucket(this, 'MlBucket', {
      bucketName: `${prefix}-ml-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
      lifecycleRules: [
        { id: 'expire-run-reports', prefix: `scoring/${env}/runs/`, expiration: cdk.Duration.days(90), enabled: true },
      ],
    });

    // Código de entrenamiento → S3 (el Processing Job lo monta en /opt/ml/processing/input/code/)
    new s3deploy.BucketDeployment(this, 'MlTrainingSource', {
      sources: [
        s3deploy.Source.asset(path.join(repoRoot, 'ml'), {
          exclude: ['.venv', '.venv/**', 'model', 'model/**', 'data', 'data/**', 'tests', 'tests/**',
            '**/__pycache__', '**/__pycache__/**', '.pytest_cache', '.pytest_cache/**', '*.ipynb', '*.tar.gz'],
        }),
      ],
      destinationBucket: this.mlBucket,
      destinationKeyPrefix: 'scoring/source/',
      prune: true,
    });

    // ── Rol de ejecución SageMaker (Processing Job + servir el modelo) ─────────────────
    // Como fraud-detector: AmazonSageMakerFullAccess cubre ECR pull, CloudWatch Logs y el
    // ciclo de vida del contenedor. Simplificación heredada → endurecer en prod.
    this.smExecutionRole = new iam.Role(this, 'SmExecutionRole', {
      roleName: `${prefix}-sm-execution-role`,
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSageMakerFullAccess')],
    });
    this.mlBucket.grantReadWrite(this.smExecutionRole);
    // Dataset REAL: export_dataset.py hace Scan filtrado por `entity`
    props.table.grantReadData(this.smExecutionRole);

    // train.py crea/actualiza los endpoints desde el Processing Job
    this.smExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowInferenceEndpointManagement',
      actions: [
        'sagemaker:CreateModel',
        'sagemaker:CreateEndpointConfig',
        'sagemaker:CreateEndpoint',
        'sagemaker:UpdateEndpoint',
        'sagemaker:DescribeEndpoint',
      ],
      resources: [
        arn(`model/${prefix}-*`),
        arn(`endpoint-config/${prefix}-*`),
        arn(`endpoint/${prefix}-survival`),
        arn(`endpoint/${prefix}-rework`),
      ],
    }));

    // train.py actualiza SCORING_TRAINED_ON / SCORING_MODEL_VERSION en la Lambda de la API
    this.smExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowUpdateApiScoringEnv',
      actions: ['lambda:GetFunctionConfiguration', 'lambda:UpdateFunctionConfiguration'],
      resources: [`arn:${this.partition}:lambda:${this.region}:${this.account}:function:${apiFunctionName}`],
    }));

    // create_model exige PassRole hacia el propio rol
    this.smExecutionRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowPassRoleToSelf',
      actions: ['iam:PassRole'],
      resources: [this.smExecutionRole.roleArn],
    }));

    // ── Lambda: trigger de reentrenamiento ──────────────────────────────────────────
    const triggerRole = new iam.Role(this, 'MlRetrainTriggerRole', {
      roleName: `${prefix}-ml-retrain-trigger-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    triggerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowCreateProcessingJob',
      actions: ['sagemaker:CreateProcessingJob'],
      resources: [arn(`processing-job/${prefix}-retrain-*`)],
    }));
    triggerRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AllowPassSmRole',
      actions: ['iam:PassRole'],
      resources: [this.smExecutionRole.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'sagemaker.amazonaws.com' } },
    }));

    const triggerName = `${prefix}-ml-retrain-trigger`;
    const triggerLogs = new logs.LogGroup(this, 'MlRetrainTriggerLogs', {
      logGroupName: `/aws/lambda/${triggerName}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.retrainTriggerFn = new NodejsFunction(this, 'MlRetrainTriggerFn', {
      functionName: triggerName,
      description: 'Inicia el SageMaker Processing Job que reentrena el scoring XGBoost (ml/train.py --deploy)',
      entry: path.join(__dirname, '..', 'lambda', 'ml-retrain-trigger.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      role: triggerRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logGroup: triggerLogs,
      environment: {
        ENVIRONMENT: env,
        ML_BUCKET: this.mlBucket.bucketName,
        SM_EXECUTION_ROLE_ARN: this.smExecutionRole.roleArn,
        TABLE_NAME: props.table.tableName,
        LAMBDA_FUNCTION_NAME: apiFunctionName,
        MIN_AUC: '0.65',
        MIN_REAL_ROWS: '1000',
        PROCESSING_INSTANCE_TYPE: 'ml.t3.medium',
        // 683313688378 = cuenta de imágenes SageMaker en us-east-1 (otras regiones: otra cuenta)
        SKLEARN_IMAGE_URI: `683313688378.dkr.ecr.${this.region}.amazonaws.com/sagemaker-scikit-learn:1.2-1-cpu-py3`,
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'node22',
        format: OutputFormat.CJS,
        externalModules: ['@aws-sdk/*'], // SDK v3 del runtime
      },
    });

    // ── EventBridge — semanal (lunes 06:00 UTC), deshabilitado por defecto ─────────────
    // Sin datos reales suficientes cada corrida reentrena con sintéticos y no despliega si el
    // AUC no mejora: no vale la pena pagarla cada semana hasta que haya historia real.
    new events.Rule(this, 'MlRetrainWeeklyRule', {
      ruleName: `${prefix}-ml-retrain-weekly`,
      description: 'Reentrenamiento semanal del scoring XGBoost (lunes 06:00 UTC)',
      schedule: events.Schedule.cron({ minute: '0', hour: '6', weekDay: 'MON' }),
      enabled: scheduleEnabled,
      targets: [new eventsTargets.LambdaFunction(this.retrainTriggerFn, { retryAttempts: 2 })],
    });

    // ── Outputs ───────────────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'MlBucketName', {
      value: this.mlBucket.bucketName,
      description: 'Bucket ML (código, datasets, modelos y metadata del endpoint)',
      exportName: `${prefix}-ml-bucket`,
    });
    new cdk.CfnOutput(this, 'SmExecutionRoleArn', {
      value: this.smExecutionRole.roleArn,
      description: 'Rol que asume SageMaker (Processing Job + endpoints)',
    });
    new cdk.CfnOutput(this, 'ScoringEndpoints', {
      value: `${prefix}-survival,${prefix}-rework`,
      description: 'Endpoints Serverless que crea train.py --deploy (NO los crea CDK)',
    });
    new cdk.CfnOutput(this, 'RetrainScheduleEnabled', {
      value: String(scheduleEnabled),
      description: 'Cron semanal activo (habilitar con -c mlRetrainSchedule=true)',
    });
    new cdk.CfnOutput(this, 'ManualRetrainCommand', {
      value: `aws lambda invoke --function-name ${triggerName} /dev/stdout`,
      description: 'Reentrenamiento manual (payload opcional: {"forceDeploy":true,"datasetSource":"synthetic"})',
    });
    new cdk.CfnOutput(this, 'ExportDatasetCommand', {
      value: `TABLE_NAME=${props.table.tableName} python ml/export_dataset.py --s3-uri s3://${this.mlBucket.bucketName}/scoring/${env}/dataset/real.csv`,
      description: 'Exportar el dataset real a S3 (opcional; train.py también lo lee directo de DynamoDB)',
    });
  }
}
