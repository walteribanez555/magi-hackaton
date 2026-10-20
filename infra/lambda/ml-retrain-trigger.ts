/**
 * EventBridge (semanal, deshabilitado por defecto) → inicia el Processing Job de SageMaker que
 * reentrena el scoring MagiCode. Mismo patrón que fraud-detector (fraud-retrain-trigger.handler):
 *
 *   EventBridge Rule (cron) ─┐
 *   aws lambda invoke ───────┴→ esta Lambda → SageMaker Processing Job (contenedor sklearn)
 *                                               → ml/train.py --deploy:
 *                                                  dataset (DynamoDB real | sintético) → XGBoost →
 *                                                  si el AUC mejora → endpoints Serverless
 *                                                  magicode-<env>-{survival,rework} → env de la API
 *
 * Invocación manual con overrides (todos opcionales):
 *   aws lambda invoke --function-name magicode-<env>-ml-retrain-trigger \
 *     --cli-binary-format raw-in-base64-out --payload '{"forceDeploy":true,"datasetSource":"synthetic"}' /dev/stdout
 */

/** Tipado mínimo local: @aws-sdk/client-sagemaker no es dependencia de infra (viene en el runtime). */
interface SageMakerModule {
  SageMakerClient: new (cfg: Record<string, unknown>) => { send(command: unknown): Promise<{ ProcessingJobArn?: string }> };
  CreateProcessingJobCommand: new (input: Record<string, unknown>) => unknown;
}

interface RetrainEvent {
  forceDeploy?: boolean;
  datasetSource?: 'auto' | 'dynamodb' | 's3' | 'synthetic';
  minAuc?: string;
}

const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
const ENVIRONMENT = process.env.ENVIRONMENT ?? 'dev';
const ML_BUCKET = process.env.ML_BUCKET ?? '';
const SM_EXECUTION_ROLE = process.env.SM_EXECUTION_ROLE_ARN ?? '';
const TABLE_NAME = process.env.TABLE_NAME ?? '';
const LAMBDA_FUNCTION_NAME = process.env.LAMBDA_FUNCTION_NAME ?? '';
const MIN_AUC = process.env.MIN_AUC ?? '0.65';
const MIN_REAL_ROWS = process.env.MIN_REAL_ROWS ?? '1000';
const INSTANCE_TYPE = process.env.PROCESSING_INSTANCE_TYPE ?? 'ml.t3.medium';
const SKLEARN_IMAGE_URI =
  process.env.SKLEARN_IMAGE_URI ?? `683313688378.dkr.ecr.${REGION}.amazonaws.com/sagemaker-scikit-learn:1.2-1-cpu-py3`;

const log = (msg: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', context: 'MlRetrainTrigger', msg, ...data }));

// `require` (no `import()`): en CJS respeta NODE_PATH, que en Lambda incluye
// /var/runtime/node_modules (SDK v3 del runtime). NodejsFunction externaliza @aws-sdk/*.
let sdk: SageMakerModule | undefined;
const loadSdk = (): SageMakerModule => (sdk ??= require('@aws-sdk/client-sagemaker') as SageMakerModule);

export const handler = async (event: RetrainEvent = {}): Promise<{ jobName: string; jobArn?: string }> => {
  if (!ML_BUCKET || !SM_EXECUTION_ROLE) throw new Error('ML_BUCKET y SM_EXECUTION_ROLE_ARN son obligatorios');

  // ≤ 63 caracteres: magicode-<env>-retrain-<epoch ms>
  const jobName = `magicode-${ENVIRONMENT}-retrain-${Date.now()}`.slice(0, 63);
  const { SageMakerClient, CreateProcessingJobCommand } = loadSdk();
  const sm = new SageMakerClient({ region: REGION });

  log('Iniciando reentrenamiento', { jobName, datasetSource: event.datasetSource ?? 'auto', forceDeploy: !!event.forceDeploy });

  const res = await sm.send(
    new CreateProcessingJobCommand({
      ProcessingJobName: jobName,
      // ml.t3.medium: 2 vCPU / 4 GB — sobra para ~20k filas × 21 features (igual que fraud-detector)
      ProcessingResources: {
        ClusterConfig: { InstanceType: INSTANCE_TYPE, InstanceCount: 1, VolumeSizeInGB: 20 },
      },
      AppSpecification: {
        ImageUri: SKLEARN_IMAGE_URI,
        ContainerEntrypoint: ['python3'],
        ContainerArguments: [
          '/opt/ml/processing/input/code/train.py',
          '--deploy',
          '--out-dir',
          '/opt/ml/processing/model',
          '--no-api-export',
        ],
      },
      // Código de entrenamiento (ml/ sin .venv/model/data/tests) que sube el BucketDeployment del stack
      ProcessingInputs: [
        {
          InputName: 'code',
          AppManaged: false,
          S3Input: {
            S3Uri: `s3://${ML_BUCKET}/scoring/source/`,
            LocalPath: '/opt/ml/processing/input/code/',
            S3DataType: 'S3Prefix',
            S3InputMode: 'File',
            S3DataDistributionType: 'FullyReplicated',
            S3CompressionType: 'None',
          },
        },
      ],
      // Configuración de train.py por variables de entorno (ver docstring de ml/train.py)
      Environment: {
        IS_SAGEMAKER_JOB: 'true',
        AWS_DEFAULT_REGION: REGION,
        ENVIRONMENT,
        ML_BUCKET,
        SAGEMAKER_EXECUTION_ROLE_ARN: SM_EXECUTION_ROLE,
        TABLE_NAME,
        DATASET_SOURCE: event.datasetSource ?? 'auto',
        MIN_AUC: event.minAuc ?? MIN_AUC,
        MIN_REAL_ROWS,
        FORCE_DEPLOY: event.forceDeploy ? 'true' : 'false',
        LAMBDA_FUNCTION_NAME,
      },
      RoleArn: SM_EXECUTION_ROLE,
      StoppingCondition: { MaxRuntimeInSeconds: 3_600 }, // 1 h de tope (+ espera del endpoint)
    }),
  );

  log('Processing Job enviado', { jobName, jobArn: res.ProcessingJobArn });
  return { jobName, jobArn: res.ProcessingJobArn };
};
