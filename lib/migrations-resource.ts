import { fileURLToPath } from 'node:url';
import { CustomResource, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import type { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { FUNCTION_BUNDLING } from './function-defaults.ts';

export interface MigrationsProps {
  readonly table: ITable;
  // The version of the release. It is a property of both resources, so each release is an update of the resources
  // and CloudFormation calls the function. The runner does nothing when nothing is pending.
  readonly version: string;
  // minRollbackVersion of pipeline.json.
  readonly declaredFloor: string;
  readonly floorParameterName: string;
  // false in the Dev stage: the floor parameter goes with the stack.
  readonly retain: boolean;
  readonly logRetentionDays: RetentionDays;
}

// The migration step of the release, as a part of the stack. The README section "Data" explains the choice.
//
// One Lambda function runs the numbered migration scripts (lib/migrations). The CDK framework "Provider" calls it for two
// custom resources, one for each phase. CloudFormation runs a custom resource at the position that its dependencies give.
// The stack (core-stack.ts) sets the two positions:
//   expand   after the table, BEFORE the alias moves the traffic to the new code,
//   contract AFTER the alias. CloudFormation waits for the whole CodeDeploy deployment of the alias (the canary) first.
// The function lives in the cloud assembly. So the migration code is the same bytes in every environment (build once),
// and the pipeline role needs no new permission: CloudFormation invokes the function.
export class Migrations extends Construct {
  readonly expand: CustomResource;
  readonly contract: CustomResource;

  constructor(scope: Construct, id: string, props: MigrationsProps) {
    super(scope, id);

    const migrationFunction = new NodejsFunction(this, 'Function', {
      entry: fileURLToPath(new URL('./migrate-handler.ts', import.meta.url)),
      runtime: Runtime.NODEJS_22_X,
      // A migration over a small table needs seconds. A migration that needs near 15 minutes is the wrong tool: use a batch job.
      timeout: Duration.minutes(2),
      memorySize: 256,
      bundling: FUNCTION_BUNDLING,
      environment: { TABLE_NAME: props.table.tableName, FLOOR_PARAMETER: props.floorParameterName },
      logGroup: new LogGroup(this, 'FunctionLogs', { retention: props.logRetentionDays, removalPolicy: RemovalPolicy.DESTROY }),
    });
    props.table.grantReadWriteData(migrationFunction);
    // The floor parameter belongs to the migration step and not to CloudFormation (see lib/dynamo-store.ts, SsmFloor).
    migrationFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ['ssm:PutParameter', 'ssm:DeleteParameter'],
        resources: [
          Stack.of(this).formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: props.floorParameterName.replace(/^\//, ''),
          }),
        ],
      }),
    );

    const provider = new Provider(this, 'Provider', {
      onEventHandler: migrationFunction,
      logGroup: new LogGroup(this, 'ProviderLogs', { retention: props.logRetentionDays, removalPolicy: RemovalPolicy.DESTROY }),
    });

    const resource = (resourceId: string, phase: 'expand' | 'contract'): CustomResource => {
      const custom = new CustomResource(this, resourceId, {
        serviceToken: provider.serviceToken,
        resourceType: 'Custom::CoreMigrations',
        properties: {
          Phase: phase,
          Version: props.version,
          MinRollbackVersion: props.declaredFloor,
          Retain: String(props.retain),
        },
      });
      // The table and the function (with its role and policy) must exist before CloudFormation calls the function.
      custom.node.addDependency(props.table, migrationFunction);
      return custom;
    };
    this.expand = resource('Expand', 'expand');
    this.contract = resource('Contract', 'contract');
  }
}
