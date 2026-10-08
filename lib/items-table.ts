import { RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface ItemsTableProps {
  // true: Test, Staging and Production. false: the Dev stage (see StageConfig.retainData).
  readonly retain: boolean;
}

// The table of the service. It holds the items and the ledger of the migrations.
//
// - On-demand billing: the lab has no steady load, so it pays for the requests and not for capacity.
// - Point in time recovery is ON in every stage. It is the only way back from a bad migration (see "Restore" in the README).
// - Encryption: the default. DynamoDB encrypts every table with a key that AWS owns. The lab needs no key of its own.
// - No table name. CloudFormation makes one. A fixed name would stop a restore from making a new table next to it,
//   and it would stop two copies in one account.
// - Test, Staging and Production: deletion protection ON and the removal policy RETAIN. A deleted stack leaves the table.
//   A replacement of the table (a change of the key) leaves the old table too. The stateful guard of the pull request
//   workflow stops a pull request that deletes or replaces the table, unless a person adds the label.
// - Dev: the table goes with `cdk destroy`. A laptop copy or a preview has no data that matters, and it must not
//   leave a table behind that nobody removes. This is the only reason for DESTROY.
export class ItemsTable extends Construct {
  readonly table: Table;

  constructor(scope: Construct, id: string, props: ItemsTableProps) {
    super(scope, id);
    this.table = new Table(this, 'Table', {
      partitionKey: { name: 'id', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: props.retain,
      removalPolicy: props.retain ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
  }
}
