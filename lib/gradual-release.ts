import { Duration } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { LambdaDeploymentConfig, LambdaDeploymentGroup } from 'aws-cdk-lib/aws-codedeploy';
import type { ILambdaDeploymentConfig } from 'aws-cdk-lib/aws-codedeploy';
import { Alias } from 'aws-cdk-lib/aws-lambda';
import type { Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import type { Release } from './stages.ts';

export const ALIAS_NAME = 'live';

// The p99 duration of the function. A normal call takes a few milliseconds. The timeout of the function
// is 3 seconds (FUNCTION_TIMEOUT in core-stack.ts). This value is far above normal, and it is a sixth of the timeout,
// so the alarm fires on a real fault, and not on one slow call.
export const LATENCY_P99_THRESHOLD_MS = 500;

const PERIOD = Duration.minutes(1);

export function deploymentConfigOf(release: Release): ILambdaDeploymentConfig {
  switch (release.kind) {
    case 'allAtOnce':
      return LambdaDeploymentConfig.ALL_AT_ONCE;
    case 'canary':
      // The type of Release allows only 10 percent and 5 minutes.
      return LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES;
  }
}

export interface GradualReleaseProps {
  readonly function: LambdaFunction;
  readonly release: Release;
}

// The alias `live` of a function, the CodeDeploy deployment group that moves its traffic, and the two alarms
// that stop a bad deployment. The same alarms also serve the on-call: they watch the alias, which is the live traffic.
//
// CloudFormation starts a CodeDeploy deployment each time the version of the alias changes, and it waits for
// the end of the deployment. A firing alarm or a failed deployment rolls the traffic back, and the stack update fails.
// The first deployment of a stack creates the alias. A new alias has no earlier version, so it has no deployment.
export class GradualRelease extends Construct {
  readonly alias: Alias;
  readonly errorsAlarm: Alarm;
  readonly latencyAlarm: Alarm;
  readonly deploymentGroup: LambdaDeploymentGroup;

  constructor(scope: Construct, id: string, props: GradualReleaseProps) {
    super(scope, id);

    // `currentVersion` publishes a new Lambda version when the function changes. The version number of
    // the release is in the environment of the function, so each release publishes a new version.
    this.alias = new Alias(this, 'Alias', {
      aliasName: ALIAS_NAME,
      version: props.function.currentVersion,
      description: 'The version that gets the live traffic',
    });

    // A quiet service has no data. Missing data is not a breach: a deployment does not wait for traffic,
    // and an idle night does not page anyone.
    this.errorsAlarm = new Alarm(this, 'ErrorsAlarm', {
      alarmDescription: 'The alias live had an error in the last minute. This alarm also stops a deployment.',
      metric: this.alias.metricErrors({ statistic: 'Sum', period: PERIOD }),
      threshold: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    // Two periods in a row, so one slow call (for example the first call of a new version) does not stop a release.
    this.latencyAlarm = new Alarm(this, 'LatencyAlarm', {
      alarmDescription: `The p99 duration of the alias live was over ${LATENCY_P99_THRESHOLD_MS} ms for two minutes. This alarm also stops a deployment.`,
      metric: this.alias.metricDuration({ statistic: 'p99', period: PERIOD }),
      threshold: LATENCY_P99_THRESHOLD_MS,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    // The default rollback settings roll back when the deployment fails and when an alarm fires.
    this.deploymentGroup = new LambdaDeploymentGroup(this, 'DeploymentGroup', {
      alias: this.alias,
      deploymentConfig: deploymentConfigOf(props.release),
      alarms: [this.errorsAlarm, this.latencyAlarm],
    });
  }
}
