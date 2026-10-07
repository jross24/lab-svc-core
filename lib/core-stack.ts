import { fileURLToPath } from 'node:url';
import { CfnOutput, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import type { StageConfig } from './stages.ts';

const ITEMS_PATH = '/items';

export interface CoreStackProps {
  readonly version: string;
  readonly config: StageConfig;
}

export class CoreStack extends Stack {
  constructor(scope: Construct, id: string, props: CoreStackProps) {
    // No env here: the stack takes the account and the region of the credentials that deploy it.
    super(scope, id, { stackName: 'lab-svc-core' });

    const itemsFunction = new NodejsFunction(this, 'ItemsFunction', {
      entry: fileURLToPath(new URL('./items-handler.ts', import.meta.url)),
      runtime: Runtime.NODEJS_22_X,
      environment: { VERSION: props.version },
      logGroup: new LogGroup(this, 'ItemsFunctionLogs', {
        retention: props.config.logRetentionDays,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    const api = new HttpApi(this, 'Api', { description: 'lab-svc-core: mock private API' });

    // IAM authorisation makes the API private in effect.
    // API Gateway refuses a request that has no valid AWS signature from a permitted IAM identity.
    api.addRoutes({
      path: ITEMS_PATH,
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('ItemsIntegration', itemsFunction),
      authorizer: new HttpIamAuthorizer(),
    });

    // A consumer service reads these two parameters to find the API and to write its IAM policy.
    new StringParameter(this, 'UrlParameter', {
      parameterName: '/lab/core/url',
      description: 'Base URL of the core API',
      stringValue: api.apiEndpoint,
    });
    new StringParameter(this, 'ApiArnParameter', {
      parameterName: '/lab/core/api-arn',
      description: 'Resource ARN for execute-api:Invoke on GET /items of the core API',
      stringValue: api.arnForExecuteApi(HttpMethod.GET, ITEMS_PATH),
    });

    // The pipeline reads Version after a deployment. Do not add an output that contains the account ID:
    // the deploy job prints the outputs to a public log.
    new CfnOutput(this, 'Version', { value: props.version });
    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
  }
}
