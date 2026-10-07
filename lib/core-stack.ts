import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { CfnIntegration, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { CfnPermission, Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { GradualRelease } from './gradual-release.ts';
import { ServiceDashboard } from './service-dashboard.ts';
import type { StageConfig } from './stages.ts';

const ITEMS_PATH = '/items';

// The latency alarm compares the p99 duration with a threshold far below this limit.
export const FUNCTION_TIMEOUT = Duration.seconds(3);

// The p99 duration of the function. The function does almost no work, so a normal call should take a few milliseconds.
// (The lab did not measure this in Lambda yet. Look at the graph "Duration of the alias live" and adjust.)
// The timeout of the function is 3 seconds. This value is a sixth of the timeout,
// so the alarm fires on a real fault, and not on one slow call.
export const LATENCY_P99_THRESHOLD_MS = 500;

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
      timeout: FUNCTION_TIMEOUT,
      // Lambda sends a segment to X-Ray for each call. The README explains why this is the tracing choice.
      tracing: Tracing.ACTIVE,
      environment: {
        // The version of the release is a part of the function, so each release publishes a new Lambda version.
        VERSION: props.version,
        ...(props.config.injectFault ? { INJECT_FAULT: 'true' } : {}),
      },
      logGroup: new LogGroup(this, 'ItemsFunctionLogs', {
        retention: props.config.logRetentionDays,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    // The alias `live` is what the API calls. CodeDeploy moves the traffic of the alias to each new version.
    const release = new GradualRelease(this, 'Release', {
      function: itemsFunction,
      release: props.config.release,
      latencyP99ThresholdMs: LATENCY_P99_THRESHOLD_MS,
    });
    // The lab has no notification target. To page an on-call, make an SNS topic here and add it to the two alarms:
    //   release.errorsAlarm.addAlarmAction(new SnsAction(topic));
    //   release.latencyAlarm.addAlarmAction(new SnsAction(topic));
    // The same alarms then page the on-call and stop a bad deployment. No other code changes.

    const api = new HttpApi(this, 'Api', { description: 'lab-svc-core: mock private API' });

    // IAM authorisation makes the API private in effect.
    // API Gateway refuses a request that has no valid AWS signature from a permitted IAM identity.
    // The integration calls the alias, not the function. The route and the API stay the same, so a consumer
    // service needs no change: its IAM permission names the API and the route, and not the function.
    api.addRoutes({
      path: ITEMS_PATH,
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('ItemsIntegration', release.alias),
      authorizer: new HttpIamAuthorizer(),
    });

    // The first release with an alias updates a running API. The integration moves from the function to the alias,
    // and the invoke permission moves too. The permission must exist before the integration calls the alias.
    // Without this line, CloudFormation may update the integration first, and the API fails for a few seconds.
    const permission = api.node.findAll().find((node): node is CfnPermission => node instanceof CfnPermission);
    const integration = api.node.findAll().find((node): node is CfnIntegration => node instanceof CfnIntegration);
    if (!permission || !integration) throw new Error('The API has no integration or no invoke permission.');
    integration.addResourceDependency(permission, 'The alias needs the invoke permission before the API calls it.');

    new ServiceDashboard(this, 'Dashboard', { service: 'core', release, api });

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
