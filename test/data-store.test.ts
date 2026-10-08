import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CoreStack } from '../lib/core-stack.ts';
import { DEV_STAGE, STAGES } from '../lib/stages.ts';
import type { StageConfig } from '../lib/stages.ts';

// The data store of the service: the table, the two custom resources of the migrations, and the order of the steps.
// The README section "Data" explains the design.

// The template tests do not read the bundled code, so esbuild does not need to run for each synth.
const NO_BUNDLING = { 'aws:cdk:bundling-stacks': [] };

const PIPELINE = JSON.parse(readFileSync(new URL('../pipeline.json', import.meta.url), 'utf8')) as { minRollbackVersion: string };

function synth(version = '1.2.3', config: StageConfig = STAGES.Test, namespace?: string) {
  const stack = new CoreStack(new App({ context: NO_BUNDLING }), 'Core', { version, config, ...(namespace === undefined ? {} : { namespace }) });
  return Template.fromStack(stack);
}

function onlyKey(resources: Record<string, unknown>): string {
  const keys = Object.keys(resources);
  expect(keys).toHaveLength(1);
  return keys[0] ?? '';
}

// The logical id of the function that has this variable in its environment.
function functionWith(template: Template, variable: string): string {
  const found = Object.entries(template.findResources('AWS::Lambda::Function')).filter(
    ([, resource]) => (resource as { Properties: { Environment?: { Variables?: Record<string, unknown> } } }).Properties.Environment?.Variables?.[variable] !== undefined,
  );
  expect(found, `the function with ${variable}`).toHaveLength(1);
  return found[0]?.[0] ?? '';
}

describe('the table', () => {
  const template = synth();

  it('is one DynamoDB table with the key id (a string), on-demand billing and default encryption', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
      BillingMode: 'PAY_PER_REQUEST',
    });
    // Default encryption: no SSESpecification, so DynamoDB uses its own key.
    const [table] = Object.values(template.findResources('AWS::DynamoDB::Table')) as { Properties: Record<string, unknown> }[];
    expect(table?.Properties).not.toHaveProperty('SSESpecification');
  });

  it('has no fixed name, so a restore from a backup can make a new table next to it', () => {
    const [table] = Object.values(template.findResources('AWS::DynamoDB::Table')) as { Properties: Record<string, unknown> }[];
    expect(table?.Properties).not.toHaveProperty('TableName');
  });

  it('has point in time recovery', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } });
  });

  it.each(Object.entries(STAGES))('is protected in the stage %s: deletion protection and the removal policy Retain', (_name, config) => {
    const stage = synth('1.2.3', config);
    stage.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: { DeletionProtectionEnabled: true },
    });
  });

  it('is removed with the stack in the Dev stage, which is a laptop copy or a preview', () => {
    const dev = synth('1.2.3', DEV_STAGE);
    dev.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' });
    const [table] = Object.values(dev.findResources('AWS::DynamoDB::Table')) as { Properties: Record<string, unknown> }[];
    expect(table?.Properties.DeletionProtectionEnabled).not.toBe(true);
    // Point in time recovery stays on in Dev: the restore practice needs it.
    dev.hasResourceProperties('AWS::DynamoDB::Table', { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } });
  });
});

describe('the function that serves GET /items', () => {
  const template = synth();
  const itemsFunction = functionWith(template, 'VERSION');

  it('knows the table by the environment variable TABLE_NAME', () => {
    const tableId = onlyKey(template.findResources('AWS::DynamoDB::Table'));
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: { TABLE_NAME: { Ref: tableId }, VERSION: '1.2.3' } },
    });
  });

  it('may read the table and may not write it', () => {
    const policies = Object.values(template.findResources('AWS::IAM::Policy')) as {
      Properties: { PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown }[] } };
    }[];
    const dynamoActions = policies
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
      .filter((statement) => [statement.Action].flat().some((action) => action.startsWith('dynamodb:')))
      .flatMap((statement) => [statement.Action].flat());
    // Two roles hold DynamoDB actions: the role of the items function (read) and the role of the migration function (read and write).
    expect(dynamoActions).toContain('dynamodb:Scan');
    expect(itemsFunction).toBeTruthy();
    const itemsRole = (template.findResources('AWS::Lambda::Function')[itemsFunction] as { Properties: { Role: { 'Fn::GetAtt': string[] } } }).Properties.Role['Fn::GetAtt'][0];
    const itemsPolicy = policies.filter((policy) => JSON.stringify(policy).includes(`"Ref":"${itemsRole}"`));
    const itemsActions = itemsPolicy
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
      .flatMap((statement) => [statement.Action].flat())
      .filter((action) => action.startsWith('dynamodb:'));
    expect(itemsActions).toContain('dynamodb:Scan');
    expect(itemsActions).not.toContain('dynamodb:PutItem');
    expect(itemsActions).not.toContain('dynamodb:UpdateItem');
    expect(itemsActions).not.toContain('dynamodb:DeleteItem');
    expect(itemsActions).not.toContain('dynamodb:BatchWriteItem');
  });
});

describe('the migration function', () => {
  const template = synth();
  const migrationFunction = functionWith(template, 'FLOOR_PARAMETER');

  it('knows the table and the name of the floor parameter', () => {
    const tableId = onlyKey(template.findResources('AWS::DynamoDB::Table'));
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: { TABLE_NAME: { Ref: tableId }, FLOOR_PARAMETER: '/lab/core/min-rollback-version' } },
    });
  });

  it('has a time limit of its own, long enough for a small migration and far below the 15 minutes of Lambda', () => {
    const properties = (template.findResources('AWS::Lambda::Function')[migrationFunction] as { Properties: { Timeout: number } }).Properties;
    expect(properties.Timeout).toBeGreaterThanOrEqual(60);
    expect(properties.Timeout).toBeLessThan(900);
  });

  it('may write and delete the floor parameter, and only that parameter', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['ssm:PutParameter', 'ssm:DeleteParameter'],
            Effect: 'Allow',
            Resource: Match.objectLike({
              'Fn::Join': Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp(':parameter/lab/core/min-rollback-version$')])]),
            }),
          }),
        ]),
      },
    });
  });

  it('has a log group with the retention of the stage', () => {
    template.resourceCountIs('AWS::Logs::LogGroup', 3);
    for (const group of Object.values(template.findResources('AWS::Logs::LogGroup')) as { Properties: { RetentionInDays: number } }[]) {
      expect(group.Properties.RetentionInDays).toBe(7);
    }
  });
});

describe('the floor parameter', () => {
  it('is not a resource of CloudFormation, because a rollback of the stack would lower it', () => {
    const template = synth();
    const names = Object.values(template.findResources('AWS::SSM::Parameter')).map(
      (resource) => (resource as { Properties: { Name: string } }).Properties.Name,
    );
    expect(names.sort()).toEqual(['/lab/core/api-arn', '/lab/core/url', '/lab/core/version']);
  });

  it('has the name of the namespace in a copy with a namespace', () => {
    const template = synth('0.0.0-x', DEV_STAGE, 'my-test');
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: { FLOOR_PARAMETER: '/lab/ns/my-test/core/min-rollback-version' } },
    });
  });
});

describe('the custom resources and the order of the steps', () => {
  const template = synth('1.2.3');
  const resources = template.findResources('Custom::CoreMigrations') as Record<string, { Properties: Record<string, unknown>; DependsOn?: string[] }>;
  const find = (phase: string) => {
    const found = Object.entries(resources).filter(([, resource]) => resource.Properties.Phase === phase);
    expect(found, `the custom resource of the phase ${phase}`).toHaveLength(1);
    return { id: found[0]?.[0] ?? '', ...(found[0]?.[1] as { Properties: Record<string, unknown>; DependsOn?: string[] }) };
  };
  const expand = find('expand');
  const contract = find('contract');
  const aliasId = onlyKey(template.findResources('AWS::Lambda::Alias'));
  const tableId = onlyKey(template.findResources('AWS::DynamoDB::Table'));
  const dependsOn = (id: string): string[] =>
    ((template.toJSON() as { Resources: Record<string, { DependsOn?: string | string[] }> }).Resources[id]?.DependsOn ?? []) as string[];

  it('has exactly two: expand and contract', () => {
    expect(Object.keys(resources)).toHaveLength(2);
  });

  it('passes the phase, the version of the release, the declared floor and the retention to the function', () => {
    expect(expand.Properties).toMatchObject({ Phase: 'expand', Version: '1.2.3', MinRollbackVersion: PIPELINE.minRollbackVersion, Retain: 'true' });
    expect(contract.Properties).toMatchObject({ Phase: 'contract', Version: '1.2.3', MinRollbackVersion: PIPELINE.minRollbackVersion, Retain: 'true' });
  });

  it('runs the migrations of each release: the version is a property, so a new version is an update of the resource', () => {
    const next = synth('1.2.4').findResources('Custom::CoreMigrations');
    for (const resource of Object.values(next) as { Properties: { Version: string } }[]) expect(resource.Properties.Version).toBe('1.2.4');
  });

  it('runs the expand step after the table exists and BEFORE the alias moves the traffic to the new version', () => {
    expect(dependsOn(expand.id)).toContain(tableId);
    expect(dependsOn(aliasId)).toContain(expand.id);
  });

  it('runs the contract step AFTER the alias, so after CodeDeploy has finished the canary', () => {
    expect(dependsOn(contract.id)).toContain(aliasId);
    // The contract step does not wait for the alias only by chance: nothing else orders it before the alias.
    expect(dependsOn(aliasId)).not.toContain(contract.id);
  });

  it('runs the contract step after the expand step', () => {
    // Through the alias: expand -> alias -> contract.
    expect(dependsOn(aliasId)).toContain(expand.id);
    expect(dependsOn(contract.id)).toContain(aliasId);
  });

  it('does not let the version parameter in front of the contract step', () => {
    // The parameter /lab/core/version says that the release is complete. The data must be complete first.
    const versionId = Object.entries(template.findResources('AWS::SSM::Parameter')).find(
      ([, resource]) => (resource as { Properties: { Name: string } }).Properties.Name === '/lab/core/version',
    )?.[0];
    expect(versionId).toBeTruthy();
    expect(dependsOn(versionId ?? '')).toContain(contract.id);
  });

  it('keeps the retention flag false in the Dev stage', () => {
    const dev = synth('1.2.3', DEV_STAGE).findResources('Custom::CoreMigrations') as Record<string, { Properties: { Retain: string } }>;
    for (const resource of Object.values(dev)) expect(resource.Properties.Retain).toBe('false');
  });
});

describe('the keep-the-same-shape rule for the pipeline stages', () => {
  it('makes the same templates for Test, Staging and Production apart from the stage config', () => {
    // The data store must not differ between the environments: the migrations run the same way everywhere.
    const strip = (template: Template): string =>
      JSON.stringify(template.toJSON()).replace(/"RetentionInDays":[0-9]+/g, '"RetentionInDays":0');
    const test = strip(synth('1.2.3', STAGES.Test));
    expect(strip(synth('1.2.3', STAGES.Staging))).toBe(test);
    // Production has a canary and a longer log retention. The data parts are the same.
    const production = synth('1.2.3', STAGES.Production);
    production.resourceCountIs('AWS::DynamoDB::Table', 1);
    production.resourceCountIs('Custom::CoreMigrations', 2);
    expect(RetentionDays.ONE_MONTH).toBe(30);
  });
});
