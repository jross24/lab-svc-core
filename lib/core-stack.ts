import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, Tags } from 'aws-cdk-lib';
import { CfnIntegration, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { CfnDashboard } from 'aws-cdk-lib/aws-cloudwatch';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { CfnPermission, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { FUNCTION_BUNDLING, FUNCTION_MEMORY_MB } from './function-defaults.ts';
import { GradualRelease } from './gradual-release.ts';
import { ItemsTable } from './items-table.ts';
import { Migrations } from './migrations-resource.ts';
import { NAMESPACE_TAG, namesFor } from './namespace.ts';
import { readDeclaredFloor } from './pipeline-file.ts';
import { ServiceDashboard } from './service-dashboard.ts';
import { TransactionSearch } from './transaction-search.ts';
import type { StageConfig } from './stages.ts';

const ITEMS_PATH = '/items';

// The latency alarm compares the p99 duration with a threshold far below this limit.
export const FUNCTION_TIMEOUT = Duration.seconds(3);

// The p99 duration of the function, in milliseconds. The lab measured it (see "The latency threshold" in the README):
// a warm call takes about 45 ms with tracing, and the first call of a new environment takes about 450 ms.
// The alarm must not fire on that first call, so the value is twice the cold call. It is also a third of the
// timeout of 3 seconds, which is the highest value that the unit test allows.
export const LATENCY_P99_THRESHOLD_MS = 1000;

export interface CoreStackProps {
  readonly version: string;
  readonly config: StageConfig;
  // Only the Dev stage sets it (the context value `namespace`). It gives the stack, the three SSM parameters and the
  // dashboard names of their own, so that several copies of the service can live in one account.
  // With no namespace the stack has the names of the baseline copy. See "Namespaces" in the README.
  readonly namespace?: string;
}

export class CoreStack extends Stack {
  constructor(scope: Construct, id: string, props: CoreStackProps) {
    const names = namesFor(props.namespace);
    // No env here: the stack takes the account and the region of the credentials that deploy it.
    super(scope, id, { stackName: names.stackName });

    // The tag goes to the stack and to every resource that can have a tag. A copy with no namespace has no tag.
    if (props.namespace !== undefined) Tags.of(this).add(NAMESPACE_TAG, props.namespace);

    // The data: the table, and the migration step that fills it and changes its shape. The README section "Data" explains both.
    const { table } = new ItemsTable(this, 'Items', { retain: props.config.retainData });

    const itemsFunction = new NodejsFunction(this, 'ItemsFunction', {
      entry: fileURLToPath(new URL('./items-handler.ts', import.meta.url)),
      runtime: Runtime.NODEJS_22_X,
      timeout: FUNCTION_TIMEOUT,
      memorySize: FUNCTION_MEMORY_MB,
      bundling: FUNCTION_BUNDLING,
      // No active tracing of Lambda: OpenTelemetry makes the traces (lib/tracing.ts). The README explains why.
      environment: {
        // The version of the release is a part of the function, so each release publishes a new Lambda version.
        VERSION: props.version,
        TABLE_NAME: table.tableName,
        ...(props.config.injectFault ? { INJECT_FAULT: 'true' } : {}),
      },
      logGroup: new LogGroup(this, 'ItemsFunctionLogs', {
        retention: props.config.logRetentionDays,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    // The function reads the items. It never writes them: only the migration step writes.
    table.grantReadData(itemsFunction);

    // The function sends its spans to the OTLP endpoint of X-Ray. The endpoint checks this permission.
    // X-Ray actions do not support a resource, so the resource is *.
    itemsFunction.addToRolePolicy(new PolicyStatement({ actions: ['xray:PutTraceSegments'], resources: ['*'] }));
    // The endpoint works only with Transaction Search, which is a setting of the whole account.
    // Only the baseline copy owns it. A copy with a namespace would collide with the fixed name of the policy,
    // and `cdk destroy` of that copy would switch tracing off for the whole account.
    if (props.namespace === undefined) new TransactionSearch(this, 'TransactionSearch');

    // The alias `live` is what the API calls. CodeDeploy moves the traffic of the alias to each new version.
    const release = new GradualRelease(this, 'Release', {
      function: itemsFunction,
      release: props.config.release,
      latencyP99ThresholdMs: LATENCY_P99_THRESHOLD_MS,
    });
    // The order of the data steps in one deployment (the README section "Data" explains it):
    //   1. expand migrations   (additive, old code still works),
    //   2. the alias moves to the new code, and CodeDeploy runs the canary (CloudFormation waits for it),
    //   3. contract migrations (destructive, old code stops working),
    //   4. the version parameter says that the release is complete.
    // An alarm in step 2 rolls the alias back and fails the update. Then step 3 never runs, and the data is not destroyed.
    const migrations = new Migrations(this, 'Migrations', {
      table,
      version: props.version,
      declaredFloor: readDeclaredFloor(),
      floorParameterName: names.floorParameterName,
      retain: props.config.retainData,
      logRetentionDays: props.config.logRetentionDays,
    });
    release.alias.node.addDependency(migrations.expand);
    migrations.contract.node.addDependency(release.alias);

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

    const dashboard = new ServiceDashboard(this, 'Dashboard', { service: 'core', release, api });
    if (props.namespace !== undefined) {
      // The shared dashboard code (lib/service-dashboard.ts) always names the dashboard lab-svc-core.
      // That file is the same in all four repositories, and it stays unchanged. So a copy with a namespace sets the
      // name in the template. The property dashboardName of the construct keeps the old name, and nothing here reads it.
      (dashboard.dashboard.node.defaultChild as CfnDashboard).addPropertyOverride('DashboardName', names.dashboardName);
    }

    // A consumer service reads these two parameters to find the API and to write its IAM policy.
    new StringParameter(this, 'UrlParameter', {
      parameterName: names.urlParameterName,
      description: 'Base URL of the core API',
      stringValue: api.apiEndpoint,
    });
    new StringParameter(this, 'ApiArnParameter', {
      parameterName: names.apiArnParameterName,
      description: 'Resource ARN for execute-api:Invoke on GET /items of the core API',
      stringValue: api.arnForExecuteApi(HttpMethod.GET, ITEMS_PATH),
    });

    // The pipeline of the other services reads this parameter. It checks the deployment order and the set of tested versions.
    const versionParameter = new StringParameter(this, 'VersionParameter', {
      parameterName: names.versionParameterName,
      description: 'Version of core that this stack runs',
      stringValue: props.version,
    });
    // CloudFormation updates the alias, then waits for the CodeDeploy deployment (canary in Production), and only then
    // updates this parameter. So the parameter shows the new version when the release is complete.
    // A rollback of the traffic leaves the old version in the parameter.
    versionParameter.node.addDependency(release.alias);
    // The release is complete only after the contract step. If that step fails, the parameter keeps the old version.
    versionParameter.node.addDependency(migrations.contract);

    // The pipeline reads Version after a deployment. Do not add an output that contains the account ID:
    // the deploy job prints the outputs to a public log.
    new CfnOutput(this, 'Version', { value: props.version });
    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
  }
}
