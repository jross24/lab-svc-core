import { Aws, RemovalPolicy, Stack } from 'aws-cdk-lib';
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
// endpoint. The platform stack (lab-platform) is the right owner, and the setting is moving there (lab-platform#27).
// Core owned it until now, because core deploys first.
//
// Both resources have a fixed identity in the account, so two stacks cannot own them at the same time.
// The move has two core releases. This release keeps both resources when they leave the stack (Retain).
// The next release removes them from the stack. The real policy and the real setting stay in the account.
// Then the platform stack imports them. Without Retain, the removal would delete the setting and switch tracing
// off for all four services.
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
    policy.applyRemovalPolicy(RemovalPolicy.RETAIN);

    // 100 percent of the spans become traces that the X-Ray API can find. The lab has little traffic.
    // A real team lowers this value: AWS indexes 1 percent for free and charges for the rest.
    const config = new CfnTransactionSearchConfig(this, 'Config', { indexingPercentage: 100 });
    config.applyRemovalPolicy(RemovalPolicy.RETAIN);
    config.addDependency(policy);
  }
}
