import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { CloudAssembly, CloudFormationStackArtifact } from 'aws-cdk-lib/cx-api';
import { createApp } from '../lib/app.ts';
import { CoreStack } from '../lib/core-stack.ts';
import { NAMESPACE_TAG, namesFor, parseNamespace } from '../lib/namespace.ts';

// Twelve digits that are not a part of a longer number or of a hex hash.
const ACCOUNT_ID = /(?<![0-9a-f])[0-9]{12}(?![0-9a-f])/i;

const VERSION_OF_A_PREVIEW = '0.0.0-pr12.abc1234';

interface TemplateShape {
  readonly Resources: Record<string, { readonly Type: string; readonly Properties?: Record<string, unknown> }>;
  readonly Outputs: Record<string, { readonly Value: unknown; readonly Export?: unknown }>;
}

function stackOf(assembly: CloudAssembly): CloudFormationStackArtifact {
  expect(assembly.stacksRecursively).toHaveLength(1);
  return assembly.stacksRecursively[0] as CloudFormationStackArtifact;
}

function templateOf(stack: CloudFormationStackArtifact): TemplateShape {
  return stack.template as TemplateShape;
}

function synthDev(context: Record<string, unknown>): CloudFormationStackArtifact {
  return stackOf(createApp({ dev: 'true', ...context }).synth());
}

// The names of the SSM parameters that the stack writes, in alphabetical order.
function ssmNames(stack: CloudFormationStackArtifact): string[] {
  return Object.values(templateOf(stack).Resources)
    .filter((resource) => resource.Type === 'AWS::SSM::Parameter')
    .map((resource) => resource.Properties?.Name as string)
    .sort();
}

// The value of a property for each resource of a type, in the order of the template.
function eachProperty(stack: CloudFormationStackArtifact, type: string, property: string): unknown[] {
  return Object.values(templateOf(stack).Resources)
    .filter((resource) => resource.Type === type)
    .map((resource) => resource.Properties?.[property]);
}

function onlyProperty(stack: CloudFormationStackArtifact, type: string, property: string): unknown {
  const found = Object.values(templateOf(stack).Resources).filter((resource) => resource.Type === type);
  expect(found, type).toHaveLength(1);
  return found[0]?.Properties?.[property];
}

// A Name-like property that holds a plain string, with the resource type and the path in the resource.
interface NameEntry {
  readonly logicalId: string;
  readonly type: string;
  readonly path: string;
  readonly value: string;
}

function nameEntries(stack: CloudFormationStackArtifact): NameEntry[] {
  const entries: NameEntry[] = [];
  const walk = (node: unknown, logicalId: string, type: string, path: string): void => {
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      const here = path === '' ? key : `${path}.${key}`;
      if (/Name$/.test(key) && typeof value === 'string') entries.push({ logicalId, type, path: here, value });
      walk(value, logicalId, type, here);
    }
  };
  for (const [logicalId, resource] of Object.entries(templateOf(stack).Resources)) {
    walk(resource.Properties, logicalId, resource.Type, '');
  }
  return entries;
}

// Name-like properties that two copies in one account may share, because the name is only unique inside a parent
// (the function, the API, the role) or because it is not the name of a resource of the stack.
// All other Name-like properties are names of the account or of the region. They must differ between two copies.
const SCOPED_NAMES: readonly { readonly type: string; readonly path: RegExp; readonly why: string }[] = [
  { type: 'AWS::Lambda::Alias', path: /^Name$/, why: 'the alias live belongs to one function' },
  { type: 'AWS::CloudWatch::Alarm', path: /^MetricName$/, why: 'the name of a metric, not of a resource' },
  { type: 'AWS::CloudWatch::Alarm', path: /^Dimensions\.[0-9]+\.Name$/, why: 'the name of a metric dimension' },
  { type: 'AWS::CodeDeploy::DeploymentGroup', path: /^DeploymentConfigName$/, why: 'a configuration that AWS provides' },
  { type: 'AWS::ApiGatewayV2::Api', path: /^Name$/, why: 'API Gateway does not need a unique API name' },
  { type: 'AWS::ApiGatewayV2::Stage', path: /^StageName$/, why: 'the stage of one API' },
  { type: 'AWS::IAM::Policy', path: /^PolicyName$/, why: 'an inline policy belongs to one role' },
  { type: 'AWS::DynamoDB::Table', path: /AttributeName$/, why: 'the name of a key attribute, not of a resource' },
];

function isScoped(entry: NameEntry): boolean {
  return SCOPED_NAMES.some((scoped) => scoped.type === entry.type && scoped.path.test(entry.path));
}

describe('parseNamespace', () => {
  it.each(['a', 'laptop-test', 'pr-12', 'pr-123456789', 'a--b', 'a1', 'abcdefghijklmnopqrst'])('accepts %j', (value) => {
    expect(parseNamespace(value)).toBe(value);
  });

  it.each([
    '',
    'A',
    'Pr-12',
    '1abc',
    '12',
    '-abc',
    'abc-',
    'pr-',
    'a_b',
    'a.b',
    'a b',
    'a/b',
    ' abc',
    'abc\n',
    'abcdefghijklmnopqrstu',
    'ä',
    12,
    true,
    null,
    ['abc'],
  ])('rejects %j with a clear message', (value) => {
    expect(() => parseNamespace(value)).toThrow(/namespace must be 1 to 20 characters/);
    expect(() => parseNamespace(value)).toThrow(/Example: -c namespace=my-test/);
  });
});

describe('namesFor', () => {
  it('gives the names of the baseline copy when there is no namespace', () => {
    expect(namesFor()).toEqual({
      stackName: 'lab-svc-core',
      urlParameterName: '/lab/core/url',
      apiArnParameterName: '/lab/core/api-arn',
      floorParameterName: '/lab/core/min-rollback-version',
      versionParameterName: '/lab/core/version',
      dashboardName: 'lab-svc-core',
    });
  });

  it('gives each name its own namespace', () => {
    expect(namesFor('pr-12')).toEqual({
      stackName: 'lab-svc-core-pr-12',
      urlParameterName: '/lab/ns/pr-12/core/url',
      apiArnParameterName: '/lab/ns/pr-12/core/api-arn',
      floorParameterName: '/lab/ns/pr-12/core/min-rollback-version',
      versionParameterName: '/lab/ns/pr-12/core/version',
      dashboardName: 'lab-svc-core-pr-12',
    });
  });

  it('refuses a namespace that parseNamespace refuses', () => {
    expect(() => namesFor('PR-12')).toThrow(/namespace must be 1 to 20 characters/);
  });

  it('keeps the longest names inside the limits of CloudFormation and SSM', () => {
    const names = namesFor('abcdefghijklmnopqrst');
    expect(names.stackName.length).toBeLessThanOrEqual(128);
    expect(names.dashboardName.length).toBeLessThanOrEqual(255);
    expect(names.urlParameterName.length).toBeLessThanOrEqual(1011);
    expect(names.apiArnParameterName.length).toBeLessThanOrEqual(1011);
    expect(names.floorParameterName.length).toBeLessThanOrEqual(1011);
    expect(names.versionParameterName.length).toBeLessThanOrEqual(1011);
  });
});

describe('the app with dev=true and a namespace', () => {
  const assembly = createApp({ dev: 'true', namespace: 'pr-12', version: VERSION_OF_A_PREVIEW }).synth();
  const stack = stackOf(assembly);
  const template = templateOf(stack);

  it('has only the stage Dev and one stack, so the pipeline command "Dev/*" does not change', () => {
    expect(assembly.nestedAssemblies.map((nested) => nested.displayName)).toEqual(['Dev']);
    expect(stack.hierarchicalId).toBe('Dev/Core');
  });

  it('names the stack lab-svc-core-<namespace>', () => {
    expect(stack.stackName).toBe('lab-svc-core-pr-12');
  });

  it('writes its URL, its API ARN and its version to /lab/ns/<namespace>/core/ and to no other parameter', () => {
    expect(ssmNames(stack)).toEqual([
      '/lab/ns/pr-12/core/api-arn',
      '/lab/ns/pr-12/core/url',
      '/lab/ns/pr-12/core/version',
    ]);
    expect(JSON.stringify(template)).not.toContain('/lab/core/url');
    expect(JSON.stringify(template)).not.toContain('/lab/core/api-arn');
    expect(JSON.stringify(template)).not.toContain('/lab/core/version');
  });

  it('writes the version of the copy to its own version parameter', () => {
    Template.fromJSON(template as unknown as Record<string, unknown>).hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/lab/ns/pr-12/core/version',
      Type: 'String',
      Value: VERSION_OF_A_PREVIEW,
    });
  });

  it('names the dashboard lab-svc-core-<namespace>', () => {
    expect(onlyProperty(stack, 'AWS::CloudWatch::Dashboard', 'DashboardName')).toBe('lab-svc-core-pr-12');
  });

  it('tags the stack and its resources with lab-namespace=<namespace>', () => {
    expect(NAMESPACE_TAG).toBe('lab-namespace');
    expect(stack.tags).toEqual({ 'lab-namespace': 'pr-12' });
    // The service function, the migration function and the framework function of the custom resources all have the tag.
    const tags = eachProperty(stack, 'AWS::Lambda::Function', 'Tags');
    expect(tags).toHaveLength(3);
    for (const functionTags of tags) expect(functionTags).toContainEqual({ Key: 'lab-namespace', Value: 'pr-12' });
    expect(eachProperty(stack, 'AWS::DynamoDB::Table', 'Tags')[0]).toContainEqual({ Key: 'lab-namespace', Value: 'pr-12' });
  });

  it('does not create CloudWatch Transaction Search, which is a setting of the whole account', () => {
    // The baseline copy owns the setting. A copy with a namespace would collide with its fixed policy name,
    // and cdk destroy of the copy would switch tracing off for the account.
    const types = Object.values(template.Resources).map((resource) => resource.Type);
    expect(types).not.toContain('AWS::XRay::TransactionSearchConfig');
    expect(types).not.toContain('AWS::Logs::ResourcePolicy');
    expect(JSON.stringify(template)).not.toContain('lab-xray-can-write-spans');
  });

  it('accepts the version of a pull request and uses it for the function and the output', () => {
    expect(template.Outputs.Version?.Value).toBe(VERSION_OF_A_PREVIEW);
    Template.fromJSON(template as unknown as Record<string, unknown>).hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: { VERSION: VERSION_OF_A_PREVIEW } },
    });
  });

  it('exports no output, because an export name is unique in the account', () => {
    for (const [name, output] of Object.entries(template.Outputs)) {
      expect(output.Export, name).toBeUndefined();
    }
  });

  it('has no account, no region and no account ID', () => {
    expect(stack.environment.name).toBe('aws://unknown-account/unknown-region');
    expect(JSON.stringify(template)).not.toMatch(ACCOUNT_ID);
  });

  it('needs no lookup in an AWS account at synth', () => {
    expect(assembly.manifest.missing ?? []).toEqual([]);
  });
});

describe('two namespaces in one account', () => {
  const first = synthDev({ namespace: 'pr-1' });
  const second = synthDev({ namespace: 'laptop-test' });

  it('use different stack names, parameter names and dashboard names', () => {
    expect(first.stackName).not.toBe(second.stackName);
    expect(ssmNames(first).filter((name) => ssmNames(second).includes(name))).toEqual([]);
    expect(onlyProperty(first, 'AWS::CloudWatch::Dashboard', 'DashboardName')).not.toBe(
      onlyProperty(second, 'AWS::CloudWatch::Dashboard', 'DashboardName'),
    );
  });

  it('share no Name-like property, except the names that only one parent holds', () => {
    const firstEntries = nameEntries(first);
    const secondEntries = nameEntries(second);
    // The test must see the names that matter. A change of the walk that finds nothing must fail here.
    expect(firstEntries.map((entry) => entry.type)).toEqual(
      expect.arrayContaining(['AWS::SSM::Parameter', 'AWS::CloudWatch::Dashboard', 'AWS::Lambda::Alias']),
    );
    expect(secondEntries.map((entry) => `${entry.logicalId}.${entry.path}`)).toEqual(
      firstEntries.map((entry) => `${entry.logicalId}.${entry.path}`),
    );
    for (const entry of firstEntries.filter((candidate) => !isScoped(candidate))) {
      const other = secondEntries.find((candidate) => candidate.logicalId === entry.logicalId && candidate.path === entry.path);
      expect(other?.value, `${entry.type} ${entry.path} must differ between two namespaces`).not.toBe(entry.value);
    }
  });

  it('give no resource a fixed physical name, except the three parameters and the dashboard (the floor parameter is not a resource)', () => {
    // A resource with no name property gets a name from CloudFormation that holds the stack name, so it is unique.
    const named = nameEntries(first)
      .filter((entry) => !isScoped(entry))
      .map((entry) => entry.type)
      .sort();
    expect(named).toEqual(['AWS::CloudWatch::Dashboard', 'AWS::SSM::Parameter', 'AWS::SSM::Parameter', 'AWS::SSM::Parameter']);
  });

  it('write the same version and the same Lambda code, so they can share one asset', () => {
    const code = (stack: CloudFormationStackArtifact): unknown => eachProperty(stack, 'AWS::Lambda::Function', 'Code');
    expect(code(first)).toEqual(code(second));
  });
});

describe('a laptop copy and a preview in one account', () => {
  const baseline = synthDev({});
  const preview = synthDev({ namespace: 'pr-12', version: VERSION_OF_A_PREVIEW });

  it('do not share the stack name, the parameters or the dashboard name', () => {
    expect(baseline.stackName).not.toBe(preview.stackName);
    expect(ssmNames(baseline).filter((name) => ssmNames(preview).includes(name))).toEqual([]);
    expect(onlyProperty(baseline, 'AWS::CloudWatch::Dashboard', 'DashboardName')).not.toBe(
      onlyProperty(preview, 'AWS::CloudWatch::Dashboard', 'DashboardName'),
    );
  });
});

describe('an invalid namespace', () => {
  it.each(['', 'A', 'Pr-12', '1abc', '-abc', 'abc-', 'pr-', 'a_b', 'abcdefghijklmnopqrstu', 12, true, null])(
    'stops the app when dev=true and the namespace is %j',
    (namespace) => {
      expect(() => createApp({ dev: 'true', namespace })).toThrow(/namespace must be 1 to 20 characters/);
    },
  );

  it('stops the stack too, when a caller skips the app', () => {
    expect(
      () =>
        new CoreStack(new App(), 'Core', {
          version: '1.2.3',
          config: { logRetentionDays: RetentionDays.ONE_WEEK, release: { kind: 'allAtOnce' }, injectFault: false, retainData: false, traceSampleRatio: 1 },
          namespace: 'Bad-Name',
        }),
    ).toThrow(/namespace must be 1 to 20 characters/);
  });
});

describe('a namespace without dev=true', () => {
  it.each([
    ['no dev value', {}],
    ['dev=false', { dev: 'false' }],
    ['dev as the boolean false', { dev: false }],
  ])('stops the app with %s', (_label, context) => {
    expect(() => createApp({ ...context, namespace: 'pr-12' })).toThrow(/namespace works only with dev=true/);
  });

  it('stops the app even when the namespace is empty', () => {
    expect(() => createApp({ namespace: '' })).toThrow(/namespace works only with dev=true/);
  });
});

describe('the copies without a namespace (the baseline)', () => {
  const pipeline = createApp().synth();
  const dev = createApp({ dev: 'true' }).synth();
  const stages = [
    ['Test', pipeline],
    ['Staging', pipeline],
    ['Production', pipeline],
    ['Dev', dev],
  ] as const;

  const stackOfStage = (assembly: CloudAssembly, stage: string): CloudFormationStackArtifact =>
    assembly.stacksRecursively.find((candidate) => candidate.hierarchicalId === `${stage}/Core`) as CloudFormationStackArtifact;

  it.each(stages)('keeps the fixed names in the stage %s', (stage, assembly) => {
    const stack = stackOfStage(assembly, stage);
    expect(stack.stackName).toBe('lab-svc-core');
    expect(ssmNames(stack)).toEqual(['/lab/core/api-arn', '/lab/core/url', '/lab/core/version']);
    expect(onlyProperty(stack, 'AWS::CloudWatch::Dashboard', 'DashboardName')).toBe('lab-svc-core');
  });

  it.each(stages)('keeps CloudWatch Transaction Search in the stage %s', (stage, assembly) => {
    const types = Object.values(templateOf(stackOfStage(assembly, stage)).Resources).map((resource) => resource.Type);
    expect(types).toContain('AWS::XRay::TransactionSearchConfig');
    expect(types).toContain('AWS::Logs::ResourcePolicy');
  });

  it.each(stages)('has no namespace tag and no namespace parameter in the stage %s', (stage, assembly) => {
    const stack = stackOfStage(assembly, stage);
    expect(stack.tags).toEqual({});
    const text = JSON.stringify(stack.template);
    expect(text).not.toContain('lab-namespace');
    expect(text).not.toContain('/lab/ns/');
    expect(text).not.toContain('"Tags"');
  });

  it('makes the Dev stage the same template as the Test stage, apart from the stage config', () => {
    // The Dev stage keeps the logs for 3 days and the Test stage keeps them for 7. The Dev stage does not keep the
    // table and the floor parameter when the stack goes (retainData). The description of the framework function holds
    // the path of the construct, and the path holds the name of the stage. Nothing else may differ.
    const normalised = (assembly: CloudAssembly, stage: string): string =>
      JSON.stringify(stackOfStage(assembly, stage).template)
        .replace(/"RetentionInDays":[0-9]+/g, '"RetentionInDays":0')
        .replace(/"(DeletionPolicy|UpdateReplacePolicy)":"(Retain|Delete)"/g, '"$1":"x"')
        .replace(/"DeletionProtectionEnabled":(true|false),?/g, '')
        .replace(/"Retain":"(true|false)"/g, '"Retain":"x"')
        .replace(/\((Test|Staging|Production|Dev)\/Core\/Migrations\/Provider\)/g, '(Stage/Core/Migrations/Provider)');
    expect(normalised(dev, 'Dev')).toBe(normalised(pipeline, 'Test'));
  });
});
