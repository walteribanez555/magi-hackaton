import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { MagicodeStack, MagicodeStackProps } from '../lib/magicode-stack';

// `aws:cdk:bundling-stacks: []` → CDK no ejecuta esbuild (ni Docker) en los tests: los
// assets de Lambda quedan como placeholders. Es el mismo mecanismo que usa
// `cdk synth --exclusively`. Los entries (apps/api/src/*.ts, services/magihub-mock/src)
// sí deben existir: NodejsFunction valida la ruta.
const synth = (props: Partial<MagicodeStackProps> = {}) => {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new MagicodeStack(app, 'TestStack', {
    env: { account: '111111111111', region: 'us-east-1' },
    environment: 'test',
    dashboardDistDir: '/nonexistent',           // el build de Angular no es parte del test
    ...props,
  });
  return Template.fromStack(stack);
};

describe('MagicodeStack', () => {
  const template = synth();

  test('tabla DynamoDB: PK/SK, GSI1, stream, PITR, TTL', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'magicode-test-productivity',
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: 'GSI1',
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        }),
      ],
      StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      TimeToLiveSpecification: { AttributeName: 'expires_at', Enabled: true },
    });
    // non-prod → DESTROY
    template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
  });

  test('prod retiene la tabla y protege la BD', () => {
    const prod = synth({ environment: 'prod' });
    prod.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
    prod.hasResourceProperties('AWS::RDS::DBInstance', {
      DeletionProtection: true,
      BackupRetentionPeriod: 7,
    });
  });

  test('RDS PostgreSQL privada, cifrada, con TLS forzado', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      EngineVersion: Match.stringLikeRegexp('^16\\.'),
      DBInstanceClass: 'db.t4g.micro',
      AllocatedStorage: '20',
      StorageType: 'gp3',
      StorageEncrypted: true,
      PubliclyAccessible: false,
      MultiAZ: false,
      DBName: 'magicode',
      BackupRetentionPeriod: 1,
      DeletionProtection: false,
    });
    template.hasResource('AWS::RDS::DBInstance', { DeletionPolicy: 'Snapshot' });
    template.hasResourceProperties('AWS::RDS::DBParameterGroup', {
      Parameters: { 'rds.force_ssl': '1' },
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'magicode/test/db',
    });
  });

  test('BD solo accesible desde el SG de las Lambdas en 5432', () => {
    const ingress = template.findResources('AWS::EC2::SecurityGroupIngress');
    const rules = Object.values(ingress).map((r) => r.Properties);
    expect(rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432 }),
      ]),
    );
    for (const r of rules) {
      expect(r.CidrIp).toBeUndefined();               // nada abierto por CIDR
    }
  });

  test('VPC sin NAT, con endpoint gateway Dynamo y UN endpoint interface Secrets Manager', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Gateway',
      ServiceName: Match.objectLike({}),
    });
    const interfaces = template.findResources('AWS::EC2::VPCEndpoint', {
      Properties: { VpcEndpointType: 'Interface' },
    });
    const list = Object.values(interfaces);
    expect(list).toHaveLength(1);
    expect(list[0].Properties.SubnetIds).toHaveLength(1);
  });

  test('Lambdas: Node 22 ARM64 con nombres por entorno', () => {
    for (const name of ['api', 'projector', 'migrator', 'magihub-mock', 'task-sync']) {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: `magicode-test-${name}`,
        Runtime: 'nodejs22.x',
        Architectures: ['arm64'],
        Handler: 'index.handler',
      });
    }
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'magicode-test-api',
      Environment: {
        Variables: Match.objectLike({
          APP_ENV: 'test',
          MAGIHUB_MODE: 'bedrock',
          SCORING_SURVIVAL_ENDPOINT: 'magicode-test-survival',
          SCORING_REWORK_ENDPOINT: 'magicode-test-rework',
          NODE_OPTIONS: '--enable-source-maps',
        }),
      },
    });
  });

  test('proyector consume el stream con DLQ y batch item failures', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      StartingPosition: 'TRIM_HORIZON',
      BatchSize: 100,
      BisectBatchOnFunctionError: true,
      MaximumRetryAttempts: 3,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
    });
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'magicode-test-projector-dlq' });
  });

  test('proyector filtra el ruido operativo (outbox/idem/webhooks)', () => {
    const ignored = { 'anything-but': ['OutboxAction', 'ActionIdem', 'WebhookDelivery'] };
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      StartingPosition: 'TRIM_HORIZON',
      FilterCriteria: {
        Filters: [
          { Pattern: JSON.stringify({ dynamodb: { NewImage: { entity: { S: ignored } } } }) },
          { Pattern: JSON.stringify({ eventName: ['REMOVE'], dynamodb: { OldImage: { entity: { S: ignored } } } }) },
        ],
      },
    });
  });

  test('task-sync consume solo OutboxAction pendientes (LATEST, DLQ)', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      StartingPosition: 'LATEST',
      BatchSize: 10,
      MaximumRetryAttempts: 5,
      BisectBatchOnFunctionError: true,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
      FilterCriteria: {
        Filters: [{
          Pattern: JSON.stringify({
            dynamodb: { NewImage: { entity: { S: ['OutboxAction'] }, status: { S: ['pending'] } } },
          }),
        }],
      },
    });
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'magicode-test-task-sync-dlq' });
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'magicode-test-task-sync',
      Timeout: 30,
      VpcConfig: Match.absent(),
      Environment: { Variables: Match.objectLike({ TABLE_NAME: Match.anyValue(), DASHBOARD_URL: Match.anyValue() }) },
    });
  });

  test('IAM: secretos de integraciones (API + task-sync) y SageMaker (API)', () => {
    const integrationsArn = Match.objectLike({
      'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp(':secret:magicode/test/integrations/\\*$')])],
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sagemaker:InvokeEndpoint',
            Resource: Match.objectLike({
              'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp(':endpoint/magicode-test-\\*$')])],
            }),
          }),
          Match.objectLike({
            Action: [
              'secretsmanager:CreateSecret',
              'secretsmanager:PutSecretValue',
              'secretsmanager:GetSecretValue',
              'secretsmanager:DescribeSecret',
              'secretsmanager:TagResource',
            ],
            Resource: integrationsArn,
          }),
        ]),
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'secretsmanager:GetSecretValue', Resource: integrationsArn }),
        ]),
      },
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'magicode-test-api',
      Environment: {
        Variables: Match.objectLike({ PUBLIC_API_URL: Match.anyValue(), DASHBOARD_URL: Match.anyValue() }),
      },
    });
  });

  test('migrador corre como trigger tras la BD', () => {
    const triggers = template.findResources('Custom::Trigger');
    const list = Object.values(triggers);
    expect(list).toHaveLength(1);
    const deps: string[] = list[0].DependsOn ?? [];
    const dbId = Object.keys(template.findResources('AWS::RDS::DBInstance'))[0];
    expect(deps).toContain(dbId);
  });

  test('HTTP API con CORS restringido, throttling y access logs', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      Name: 'magicode-test-api',
      CorsConfiguration: Match.objectLike({
        AllowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        AllowHeaders: ['authorization', 'content-type'],
        AllowOrigins: Match.arrayWith(['http://localhost:4200']),
      }),
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'ANY /{proxy+}' });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'ANY /' });
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      AccessLogSettings: Match.objectLike({ DestinationArn: Match.anyValue() }),
      DefaultRouteSettings: { ThrottlingBurstLimit: 50, ThrottlingRateLimit: 25 },
    });
  });

  test('dashboard: bucket privado + CloudFront OAC con fallback SPA', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
      },
    });
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        CustomErrorResponses: [
          Match.objectLike({ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html' }),
          Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' }),
        ],
      }),
    });
    template.resourceCountIs('Custom::CDKBucketDeployment', 1);
  });

  test('outputs presentes', () => {
    const outputs = Object.keys(template.findOutputs('*'));
    for (const o of [
      'ApiUrl', 'WebhookBaseUrl', 'MagiHubUrl', 'MagiHubMockUrl', 'DashboardUrl', 'DashboardBucket', 'DistributionId',
      'TableName', 'TableStreamArn', 'DbEndpoint', 'DbSecretArn', 'VpcId',
    ]) {
      expect(outputs).toContain(o);
    }
  });

  test('MagiHub adapter (bedrock por defecto): Function URL 120 s, env de Smart Auto, sin tag simulated', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'magicode-test-magihub-mock',
      Timeout: 120,
      MemorySize: 1024,
      Environment: {
        Variables: Match.objectLike({
          MAGIHUB_PROVIDER: 'bedrock',
          SMART_AUTO_FAST_MODEL: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
          SMART_AUTO_STRONG_MODEL: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
          SMART_AUTO_MAX_TOKENS: '4096',
          MOCK_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
    const fns = template.findResources('AWS::Lambda::Function', { Properties: { FunctionName: 'magicode-test-magihub-mock' } });
    const tags: Array<{ Key: string }> = Object.values(fns)[0].Properties.Tags ?? [];
    expect(tags.map((t) => t.Key)).not.toContain('simulated');

    template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'NONE', InvokeMode: 'BUFFERED' });
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunctionUrl',
      Principal: '*',
      FunctionUrlAuthType: 'NONE',
    });

    // La API usa la Function URL (sin `/` final) como única base URL de MagiHub.
    const api = Object.values(template.findResources('AWS::Lambda::Function', { Properties: { FunctionName: 'magicode-test-api' } }))[0];
    const baseUrl = JSON.stringify(api.Properties.Environment.Variables.MAGIHUB_BASE_URL);
    expect(baseUrl).toContain('https://');
    expect(baseUrl).toContain('FunctionUrl');
    expect(baseUrl).toContain('Fn::Split');
  });

  test('IAM Bedrock: InvokeModel(+stream) en inference profiles y foundation models (todas las regiones)', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowBedrockSmartAuto',
            Effect: 'Allow',
            Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
            Resource: [
              { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':bedrock:us-east-1:111111111111:inference-profile/global.anthropic.claude-haiku-4-5-20251001-v1:0']] },
              { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':bedrock:us-east-1:111111111111:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0']] },
              { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0']] },
              { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0']] },
            ],
          }),
        ]),
      },
    });
  });

  test('magihubProvider=mock: SIMULADO, sin IAM de Bedrock, MAGIHUB_MODE=mock', () => {
    const mock = synth({ magihubProvider: 'mock' });
    mock.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'magicode-test-magihub-mock',
      Environment: { Variables: Match.objectLike({ MAGIHUB_PROVIDER: 'mock' }) },
      Tags: Match.arrayWith([{ Key: 'simulated', Value: 'true' }]),
    });
    mock.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'magicode-test-api',
      Environment: { Variables: Match.objectLike({ MAGIHUB_MODE: 'mock' }) },
    });
    const policies = JSON.stringify(mock.findResources('AWS::IAM::Policy'));
    expect(policies).not.toContain('bedrock:');
    mock.resourceCountIs('AWS::Lambda::Url', 1);
  });

  test('MagiHub real: sin mock y MAGIHUB_MODE=real', () => {
    const real = synth({ deployMock: false, magihubBaseUrl: 'https://magihub.example.com' });
    real.resourcePropertiesCountIs('AWS::Lambda::Function', { FunctionName: 'magicode-test-magihub-mock' }, 0);
    real.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'magicode-test-api',
      Environment: {
        Variables: Match.objectLike({
          MAGIHUB_BASE_URL: 'https://magihub.example.com',
          MAGIHUB_MODE: 'real',
        }),
      },
    });
    expect(() => synth({ deployMock: false })).toThrow(/magihubBaseUrl/);
  });
});
