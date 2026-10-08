import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { FUNCTION_MEMORY_MB } from '../lib/function-defaults.ts';
import { CoreStack, FUNCTION_TIMEOUT, LATENCY_P99_THRESHOLD_MS } from '../lib/core-stack.ts';
import type { StageConfig } from '../lib/stages.ts';

// The template tests do not read the bundled code, so esbuild does not need to run for each synth.
const NO_BUNDLING = { 'aws:cdk:bundling-stacks': [] };
const ALL_AT_ONCE: StageConfig['release'] = { kind: 'allAtOnce' };
const CANARY: StageConfig['release'] = { kind: 'canary', percent: 10, minutes: 5 };

function synth(version = '1.2.3', config: Partial<StageConfig> = {}) {
  const stack = new CoreStack(new App({ context: NO_BUNDLING }), 'Core', {
    version,
    config: { logRetentionDays: RetentionDays.ONE_WEEK, release: ALL_AT_ONCE, injectFault: false, retainData: true, ...config },
  });
  return { stack, template: Template.fromStack(stack) };
}

// The logical id of the function that serves GET /items. It is the function with the variable VERSION.
// The stack has two more functions: the migration function and the framework function of the custom resources.
function itemsFunctionId(template: Template): string {
  const found = Object.entries(template.findResources('AWS::Lambda::Function')).filter(
    ([, resource]) =>
      (resource as { Properties: { Environment?: { Variables?: Record<string, unknown> } } }).Properties.Environment?.Variables?.VERSION !== undefined,
  );
  expect(found).toHaveLength(1);
  return found[0]?.[0] ?? '';
}

function onlyKey(resources: Record<string, unknown>): string {
  const keys = Object.keys(resources);
  expect(keys).toHaveLength(1);
  return keys[0] ?? '';
}

describe('CoreStack', () => {
  const { stack, template } = synth();

  it('has a fixed stack name and no fixed account or region', () => {
    expect(stack.stackName).toBe('lab-svc-core');
    expect(stack.resolve(stack.account)).toEqual({ Ref: 'AWS::AccountId' });
    expect(stack.resolve(stack.region)).toEqual({ Ref: 'AWS::Region' });
  });

  it('has one Node.js 22 function that serves the items and gets the version from the environment', () => {
    // Two more functions belong to the migration step. test/data-store.test.ts covers them.
    template.resourceCountIs('AWS::Lambda::Function', 3);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Environment: { Variables: { VERSION: '1.2.3' } },
    });
    expect(itemsFunctionId(template)).toBeTruthy();
  });

  it('keeps the logs for the number of days in the stage config', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
    synth('1.2.3', { logRetentionDays: RetentionDays.ONE_MONTH }).template.hasResourceProperties(
      'AWS::Logs::LogGroup',
      { RetentionInDays: 30 },
    );
  });

  it('has one route, GET /items, with IAM authorisation', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', { ProtocolType: 'HTTP' });
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 1);
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /items',
      AuthorizationType: 'AWS_IAM',
    });
  });

  it('writes the API URL to the SSM parameter /lab/core/url', () => {
    const apiId = Object.keys(template.findResources('AWS::ApiGatewayV2::Api'))[0];
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/lab/core/url',
      Type: 'String',
      // CloudFormation returns the endpoint as https://<api-id>.execute-api.<region>.amazonaws.com
      Value: { 'Fn::GetAtt': [apiId, 'ApiEndpoint'] },
    });
  });

  it('writes the execute-api ARN of GET /items to the SSM parameter /lab/core/api-arn', () => {
    const apiId = Object.keys(template.findResources('AWS::ApiGatewayV2::Api'))[0];
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/lab/core/api-arn',
      Type: 'String',
      Value: {
        'Fn::Join': [
          '',
          [
            'arn:',
            { Ref: 'AWS::Partition' },
            ':execute-api:',
            { Ref: 'AWS::Region' },
            ':',
            { Ref: 'AWS::AccountId' },
            ':',
            { Ref: apiId },
            '/*/GET/items',
          ],
        ],
      },
    });
    template.resourceCountIs('AWS::SSM::Parameter', 3);
  });

  it('writes the version to the SSM parameter /lab/core/version', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/lab/core/version',
      Type: 'String',
      Value: '1.2.3',
    });
  });

  it('waits for the alias before it writes the version, so the parameter shows the version of a complete release', () => {
    // CloudFormation waits for the CodeDeploy deployment of the alias. Then it updates the parameter.
    const aliasId = onlyKey(template.findResources('AWS::Lambda::Alias'));
    template.hasResource('AWS::SSM::Parameter', {
      Properties: { Name: '/lab/core/version' },
      DependsOn: Match.arrayWith([aliasId]),
    });
  });

  it('writes a new version to the SSM parameter /lab/core/version when the version changes', () => {
    synth('1.2.4').template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/lab/core/version',
      Value: '1.2.4',
    });
  });

  it('reports the version and the API URL as stack outputs', () => {
    template.hasOutput('Version', { Value: '1.2.3' });
    template.hasOutput('ApiUrl', { Value: Match.anyValue() });
  });

  it('has no output that contains the account ID', () => {
    // The deploy job prints the outputs to a public log.
    expect(JSON.stringify(template.findOutputs('*'))).not.toContain('AWS::AccountId');
  });
});

describe('the alias live', () => {
  const { template } = synth();
  const versionId = onlyKey(template.findResources('AWS::Lambda::Version'));
  const aliasId = onlyKey(template.findResources('AWS::Lambda::Alias'));

  it('points at one published version of the function', () => {
    const functionId = itemsFunctionId(template);
    template.resourceCountIs('AWS::Lambda::Version', 1);
    template.hasResourceProperties('AWS::Lambda::Version', { FunctionName: { Ref: functionId } });
    template.hasResourceProperties('AWS::Lambda::Alias', {
      Name: 'live',
      FunctionName: { Ref: functionId },
      FunctionVersion: { 'Fn::GetAtt': [versionId, 'Version'] },
    });
  });

  it('is the target of the API integration, so the API calls the alias and not the function', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
      IntegrationType: 'AWS_PROXY',
      IntegrationUri: { Ref: aliasId },
    });
  });

  it('is the only target of the invoke permission of the API', () => {
    const permissions = Object.values(template.findResources('AWS::Lambda::Permission'));
    expect(permissions).toHaveLength(1);
    expect(permissions[0]).toMatchObject({
      Properties: { Action: 'lambda:InvokeFunction', FunctionName: { Ref: aliasId }, Principal: 'apigateway.amazonaws.com' },
    });
  });

  it('is the target of the invoke permission before the integration calls it', () => {
    // The update of a running stack must not leave a moment where the API calls the alias without a permission.
    const permissionId = onlyKey(template.findResources('AWS::Lambda::Permission'));
    template.hasResource('AWS::ApiGatewayV2::Integration', { DependsOn: Match.arrayWith([permissionId]) });
  });

  it('gets a new published version for each release', () => {
    const versionOf = (version: string): string[] =>
      Object.keys(synth(version).template.findResources('AWS::Lambda::Version'));
    expect(versionOf('1.2.4')).not.toEqual(versionOf('1.2.3'));
    expect(versionOf('1.2.3')).toEqual(versionOf('1.2.3'));
  });

  it('keeps the same published version when nothing changes', () => {
    expect(Object.keys(synth('1.2.3').template.findResources('AWS::Lambda::Version'))).toEqual([versionId]);
  });
});

describe('the deployment group', () => {
  const { template } = synth();

  it('is one CodeDeploy application and one deployment group on the Lambda platform', () => {
    template.resourceCountIs('AWS::CodeDeploy::Application', 1);
    template.hasResourceProperties('AWS::CodeDeploy::Application', { ComputePlatform: 'Lambda' });
    template.resourceCountIs('AWS::CodeDeploy::DeploymentGroup', 1);
    template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      DeploymentStyle: { DeploymentOption: 'WITH_TRAFFIC_CONTROL', DeploymentType: 'BLUE_GREEN' },
    });
  });

  it('is the update policy of the alias, so each new version of the alias starts a deployment', () => {
    const groupId = onlyKey(template.findResources('AWS::CodeDeploy::DeploymentGroup'));
    const applicationId = onlyKey(template.findResources('AWS::CodeDeploy::Application'));
    template.hasResource('AWS::Lambda::Alias', {
      UpdatePolicy: {
        CodeDeployLambdaAliasUpdate: {
          ApplicationName: { Ref: applicationId },
          DeploymentGroupName: { Ref: groupId },
        },
      },
    });
  });

  it('uses the all-at-once configuration for the release all at once', () => {
    template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      DeploymentConfigName: 'CodeDeployDefault.LambdaAllAtOnce',
    });
  });

  it('uses the canary configuration for the release canary 10 percent, 5 minutes', () => {
    synth('1.2.3', { release: CANARY }).template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      DeploymentConfigName: 'CodeDeployDefault.LambdaCanary10Percent5Minutes',
    });
  });

  it('creates no extra deployment configuration', () => {
    synth('1.2.3', { release: CANARY }).template.resourceCountIs('AWS::CodeDeploy::DeploymentConfig', 0);
  });

  it('rolls back when the deployment fails and when an alarm fires', () => {
    template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      AutoRollbackConfiguration: {
        Enabled: true,
        Events: Match.arrayWith(['DEPLOYMENT_FAILURE', 'DEPLOYMENT_STOP_ON_ALARM']),
      },
    });
  });

  it('watches both alarms and stops when it cannot read an alarm', () => {
    const errorsId = Object.keys(template.findResources('AWS::CloudWatch::Alarm', { Properties: { MetricName: 'Errors' } }));
    const latencyId = Object.keys(template.findResources('AWS::CloudWatch::Alarm', { Properties: { MetricName: 'Duration' } }));
    expect(errorsId).toHaveLength(1);
    expect(latencyId).toHaveLength(1);
    template.hasResourceProperties('AWS::CodeDeploy::DeploymentGroup', {
      AlarmConfiguration: {
        Enabled: true,
        // The default is false: CodeDeploy stops the deployment when it cannot read an alarm.
        IgnorePollAlarmFailure: Match.absent(),
        Alarms: Match.arrayEquals([{ Name: { Ref: errorsId[0] } }, { Name: { Ref: latencyId[0] } }]),
      },
    });
  });
});

describe('the alarms', () => {
  const { template } = synth();

  it('has exactly two alarms, errors and latency', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
  });

  it('fires on any error in a period of one minute, and a quiet service does not fire it', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/Lambda',
      MetricName: 'Errors',
      Statistic: 'Sum',
      Period: 60,
      EvaluationPeriods: 1,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });
  });

  it('fires when the p99 duration is over the threshold in two periods in a row', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/Lambda',
      MetricName: 'Duration',
      ExtendedStatistic: 'p99',
      Period: 60,
      EvaluationPeriods: 2,
      DatapointsToAlarm: 2,
      Threshold: LATENCY_P99_THRESHOLD_MS,
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'notBreaching',
    });
  });

  it('keeps the latency threshold well below the timeout of the function and well above a normal call', () => {
    synth().template.hasResourceProperties('AWS::Lambda::Function', { Timeout: FUNCTION_TIMEOUT.toSeconds() });
    expect(LATENCY_P99_THRESHOLD_MS).toBeGreaterThanOrEqual(250);
    expect(LATENCY_P99_THRESHOLD_MS).toBeLessThanOrEqual(FUNCTION_TIMEOUT.toMilliseconds() / 3);
  });

  it('watches the alias live, so the alarms see live traffic and not the other versions', () => {
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')) as {
      Properties: { Dimensions: { Name: string; Value: unknown }[] };
    }[];
    expect(alarms).toHaveLength(2);
    for (const alarm of alarms) {
      const names = alarm.Properties.Dimensions.map((dimension) => dimension.Name).sort();
      expect(names).toEqual(['FunctionName', 'Resource']);
      const resource = alarm.Properties.Dimensions.find((dimension) => dimension.Name === 'Resource');
      expect(JSON.stringify(resource?.Value)).toContain(':live');
    }
  });

  it('has no notification target in the lab', () => {
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')) as {
      Properties: { AlarmActions?: unknown; OKActions?: unknown; InsufficientDataActions?: unknown };
    }[];
    for (const alarm of alarms) {
      expect(alarm.Properties.AlarmActions).toBeUndefined();
      expect(alarm.Properties.OKActions).toBeUndefined();
      expect(alarm.Properties.InsufficientDataActions).toBeUndefined();
    }
    template.resourceCountIs('AWS::SNS::Topic', 0);
  });
});

describe('the function settings', () => {
  const { template } = synth();

  it('has 512 MB of memory, so the first request does not wait for the trace export for long', () => {
    template.hasResourceProperties('AWS::Lambda::Function', { MemorySize: FUNCTION_MEMORY_MB });
    expect(FUNCTION_MEMORY_MB).toBe(512);
  });

  it('uses the handler index.handler of an ES module', () => {
    template.hasResourceProperties('AWS::Lambda::Function', { Handler: 'index.handler' });
  });
});

describe('tracing', () => {
  const { template } = synth();

  it('does not turn on active tracing of Lambda, because OpenTelemetry makes the traces', () => {
    // Active tracing would make a second trace for each call, with another trace ID.
    const functions = Object.values(template.findResources('AWS::Lambda::Function')) as { Properties: { TracingConfig?: unknown } }[];
    expect(functions).toHaveLength(3);
    for (const fn of functions) expect(fn.Properties.TracingConfig).toBeUndefined();
  });

  it('lets the function role send spans to X-Ray, and nothing else of X-Ray', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({ Action: 'xray:PutTraceSegments', Effect: 'Allow', Resource: '*' })]),
      },
    });
    expect(JSON.stringify(template.toJSON())).not.toContain('xray:PutTelemetryRecords');
  });

  it('uses no Lambda layer, so no account ID of another publisher is in the template', () => {
    const functions = Object.values(template.findResources('AWS::Lambda::Function')) as {
      Properties: { Layers?: unknown };
    }[];
    expect(functions).toHaveLength(3);
    for (const fn of functions) expect(fn.Properties.Layers).toBeUndefined();
  });

  it('turns on CloudWatch Transaction Search, which the OTLP endpoint of X-Ray needs, and indexes every span', () => {
    template.resourceCountIs('AWS::XRay::TransactionSearchConfig', 1);
    template.hasResourceProperties('AWS::XRay::TransactionSearchConfig', { IndexingPercentage: 100 });
  });

  it('lets X-Ray write the spans into the log group aws/spans of this account and region only', () => {
    template.resourceCountIs('AWS::Logs::ResourcePolicy', 1);
    const [policy] = Object.values(template.findResources('AWS::Logs::ResourcePolicy')) as {
      Properties: { PolicyName: string; PolicyDocument: unknown };
    }[];
    const text = JSON.stringify(policy?.Properties.PolicyDocument);
    expect(text).toContain('xray.amazonaws.com');
    expect(text).toContain('logs:PutLogEvents');
    expect(text).toContain('log-group:aws/spans:*');
    expect(text).toContain('aws:SourceAccount');
    expect(text).toContain('AWS::AccountId');
    expect(text).not.toMatch(/[0-9]{12}/);
  });

  it('creates the log group policy before the Transaction Search configuration', () => {
    const policyId = Object.keys(template.findResources('AWS::Logs::ResourcePolicy'))[0];
    template.hasResource('AWS::XRay::TransactionSearchConfig', { DependsOn: [policyId] });
  });
});

describe('the fault switch', () => {
  it('sets no INJECT_FAULT variable when the stage config does not inject a fault', () => {
    const functions = Object.values(synth().template.findResources('AWS::Lambda::Function')) as {
      Properties: { Environment?: { Variables: Record<string, unknown> } };
    }[];
    for (const fn of functions) expect(fn.Properties.Environment?.Variables ?? {}).not.toHaveProperty('INJECT_FAULT');
  });

  it('sets INJECT_FAULT to true when the stage config injects a fault', () => {
    synth('1.2.3', { injectFault: true }).template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: { INJECT_FAULT: 'true', VERSION: '1.2.3' } },
    });
  });

  it('publishes a new version when the stage config turns the fault on', () => {
    const off = Object.keys(synth().template.findResources('AWS::Lambda::Version'));
    const on = Object.keys(synth('1.2.3', { injectFault: true }).template.findResources('AWS::Lambda::Version'));
    expect(on).not.toEqual(off);
  });
});

interface Widget {
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly properties: {
    readonly title?: string;
    readonly stacked?: boolean;
    readonly metrics?: readonly (readonly unknown[])[];
    readonly alarms?: readonly string[];
    readonly annotations?: { readonly horizontal?: readonly { readonly value: number }[] };
  };
}

// CloudFormation fills the tokens of the dashboard body (Ref and GetAtt) when it deploys. In the test, each
// token becomes a marker such as <Ref:Name> or <GetAtt:Name.Arn>. Then the body is a plain JSON text.
function dashboardWidgets(template: Template): Widget[] {
  const [dashboard] = Object.values(template.findResources('AWS::CloudWatch::Dashboard')) as {
    Properties: { DashboardBody: { 'Fn::Join': [string, unknown[]] } };
  }[];
  const parts = dashboard?.Properties.DashboardBody['Fn::Join'][1] ?? [];
  const text = parts
    .map((part) => {
      if (typeof part === 'string') return part;
      const token = part as { Ref?: string; 'Fn::GetAtt'?: string[] };
      return token.Ref ? `<Ref:${token.Ref}>` : `<GetAtt:${(token['Fn::GetAtt'] ?? []).join('.')}>`;
    })
    .join('');
  return (JSON.parse(text) as { widgets: Widget[] }).widgets;
}

describe('the dashboard', () => {
  const { template } = synth();
  const widgets = dashboardWidgets(template);
  const widget = (title: string): Widget => {
    const found = widgets.find((candidate) => candidate.properties.title === title);
    expect(found, title).toBeDefined();
    return found as Widget;
  };
  const functionId = itemsFunctionId(template);
  const apiId = onlyKey(template.findResources('AWS::ApiGatewayV2::Api'));

  it('is one dashboard with a fixed name', () => {
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    template.hasResourceProperties('AWS::CloudWatch::Dashboard', { DashboardName: 'lab-svc-core' });
  });

  it('has a text widget, four metric widgets and an alarm widget, all inside the 24 columns of the grid', () => {
    expect(widgets.map((candidate) => candidate.type).sort()).toEqual(['alarm', 'metric', 'metric', 'metric', 'metric', 'text']);
    for (const candidate of widgets) {
      expect(candidate.x).toBeGreaterThanOrEqual(0);
      expect(candidate.x + candidate.width).toBeLessThanOrEqual(24);
      expect(candidate.height).toBeGreaterThan(0);
    }
  });

  it('shows the requests by version from the embedded metrics, one line for each version', () => {
    const requests = widget('Requests by version');
    expect(requests.properties.stacked).toBe(true);
    expect(requests.properties.metrics).toEqual([
      [
        {
          expression: `SEARCH('{Lab/Service,service,version} service="core" MetricName="requests"', 'Sum', 60)`,
          period: 60,
        },
      ],
    ]);
  });

  it('shows the errors of the alias live, with the line of the alarm', () => {
    const errors = widget('Errors of the alias live');
    expect(errors.properties.metrics).toEqual([
      [
        'AWS/Lambda',
        'Errors',
        'FunctionName',
        `<Ref:${functionId}>`,
        'Resource',
        `<Ref:${functionId}>:live`,
        { label: 'Lambda errors', period: 60, stat: 'Sum' },
      ],
    ]);
    expect(errors.properties.annotations?.horizontal?.map((line) => line.value)).toEqual([1]);
  });

  it('shows the p50 and the p99 duration of the alias live, with the line of the alarm', () => {
    const duration = widget('Duration of the alias live');
    expect(duration.properties.metrics?.map((metric) => metric.slice(0, 6))).toEqual([
      ['AWS/Lambda', 'Duration', 'FunctionName', `<Ref:${functionId}>`, 'Resource', `<Ref:${functionId}>:live`],
      ['AWS/Lambda', 'Duration', 'FunctionName', `<Ref:${functionId}>`, 'Resource', `<Ref:${functionId}>:live`],
    ]);
    expect(duration.properties.metrics?.map((metric) => (metric[6] as { stat: string }).stat)).toEqual(['p50', 'p99']);
    expect(duration.properties.annotations?.horizontal?.map((line) => line.value)).toEqual([LATENCY_P99_THRESHOLD_MS]);
  });

  it('shows the 4xx and the 5xx of API Gateway for this API', () => {
    const gateway = widget('API Gateway 4xx and 5xx');
    expect(gateway.properties.metrics?.map((metric) => metric.slice(0, 4))).toEqual([
      ['AWS/ApiGateway', '4xx', 'ApiId', `<Ref:${apiId}>`],
      ['AWS/ApiGateway', '5xx', 'ApiId', `<Ref:${apiId}>`],
    ]);
  });

  it('shows the state of both alarms, the errors alarm and then the latency alarm', () => {
    const errorsAlarm = Object.keys(template.findResources('AWS::CloudWatch::Alarm', { Properties: { MetricName: 'Errors' } }));
    const latencyAlarm = Object.keys(template.findResources('AWS::CloudWatch::Alarm', { Properties: { MetricName: 'Duration' } }));
    const alarmWidget = widgets.find((candidate) => candidate.type === 'alarm');
    expect(alarmWidget?.properties.alarms).toEqual([`<GetAtt:${errorsAlarm[0]}.Arn>`, `<GetAtt:${latencyAlarm[0]}.Arn>`]);
  });
});
