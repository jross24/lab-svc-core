import { Aws, Stack } from 'aws-cdk-lib';
import { CfnResourcePolicy } from 'aws-cdk-lib/aws-logs';
import { CfnTransactionSearchConfig } from 'aws-cdk-lib/aws-xray';
import { Construct } from 'constructs';

// Turns on CloudWatch Transaction Search in the account and the region of the stack.
//
// The OTLP endpoint of X-Ray accepts spans only when Transaction Search is on. Then X-Ray writes each span
// as a log event into the log group aws/spans, and it indexes a part of the spans as traces that
// `aws xray batch-get-traces` and the X-Ray console can find.
//
// This setting belongs to the whole account and not to one service. All four services send spans to the same
// endpoint, so one of them must own the setting. Core owns it, because core deploys first.
// The platform stack (lab-platform) would be the better owner, but it has no pipeline yet (lab-platform#23).
//
// The first deployment waits until the setting is active. In the lab-dev account this took 6 minutes.
export class TransactionSearch extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    // X-Ray needs the permission to write into the log group. A resource policy of CloudWatch Logs gives it.
    // The policy names this account and this region only, so another account cannot make X-Ray write here.
    const policy = new CfnResourcePolicy(this, 'XRayCanWriteSpans', {
      policyName: 'lab-xray-can-write-spans',
      policyDocument: Stack.of(this).toJsonString({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'TransactionSearchXRayAccess',
            Effect: 'Allow',
            Principal: { Service: 'xray.amazonaws.com' },
            Action: 'logs:PutLogEvents',
            Resource: [
              `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:aws/spans:*`,
              `arn:${Aws.PARTITION}:logs:${Aws.REGION}:${Aws.ACCOUNT_ID}:log-group:/aws/application-signals/data:*`,
            ],
            Condition: {
              ArnLike: { 'aws:SourceArn': `arn:${Aws.PARTITION}:xray:${Aws.REGION}:${Aws.ACCOUNT_ID}:*` },
              StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID },
            },
          },
        ],
      }),
    });

    // 100 percent of the spans become traces that the X-Ray API can find. The lab has little traffic.
    // A real team lowers this value: AWS indexes 1 percent for free and charges for the rest.
    const config = new CfnTransactionSearchConfig(this, 'Config', { indexingPercentage: 100 });
    config.addDependency(policy);
  }
}
