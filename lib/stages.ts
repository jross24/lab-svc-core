import { RetentionDays } from 'aws-cdk-lib/aws-logs';

// How CodeDeploy moves the traffic of the alias "live" to a new version of the function.
// Every stage has the same CodeDeploy resources and the same alarms. Only this setting differs.
export type Release =
  // All the traffic goes to the new version at once. The alarms still stop a bad deployment.
  | { readonly kind: 'allAtOnce' }
  // The new version gets `percent` of the traffic. After `minutes` minutes it gets all the traffic.
  // CodeDeploy has a fixed list of canary configurations. The type allows only the one that the lab uses.
  | { readonly kind: 'canary'; readonly percent: 10; readonly minutes: 5 };

// The settings that can differ between stages. All other things are the same in each stage.
export interface StageConfig {
  readonly logRetentionDays: RetentionDays;
  readonly release: Release;
  // A device for the release drill. When it is true, the function throws on each call.
  // Do not use it as a production practice. See "The Production drill" in the README.
  readonly injectFault: boolean;
}

// The pipeline deploys these stages. Each stage goes to its own AWS account.
export const STAGES = {
  Test: { logRetentionDays: RetentionDays.ONE_WEEK, release: { kind: 'allAtOnce' }, injectFault: false },
  Staging: { logRetentionDays: RetentionDays.ONE_WEEK, release: { kind: 'allAtOnce' }, injectFault: false },
  Production: {
    logRetentionDays: RetentionDays.ONE_MONTH,
    release: { kind: 'canary', percent: 10, minutes: 5 },
    injectFault: false,
  },
} as const satisfies Record<string, StageConfig>;

// A developer deploys this stage from a laptop to a personal account. The pipeline does not use it.
export const DEV_STAGE: StageConfig = {
  logRetentionDays: RetentionDays.THREE_DAYS,
  release: { kind: 'allAtOnce' },
  injectFault: false,
};
