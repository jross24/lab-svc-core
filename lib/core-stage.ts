import { Stage } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { CoreStack } from './core-stack.ts';
import type { CoreStackProps } from './core-stack.ts';

// One deployable copy of the service. `cdk deploy "<id>/*"` deploys all the stacks of one stage.
export class CoreStage extends Stage {
  constructor(scope: Construct, id: string, props: CoreStackProps) {
    super(scope, id);
    new CoreStack(this, 'Core', props);
  }
}
