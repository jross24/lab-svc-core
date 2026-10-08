import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoStore, SsmFloor } from './dynamo-store.ts';
import { MIGRATIONS } from './migrations/list.ts';
import { runMigrations } from './migrations/runner.ts';
import type { DataPort, FloorPort, LedgerPort, Migration, Phase } from './migrations/types.ts';
import { isVersion } from './migrations/version.ts';

// The Lambda function behind the two custom resources MigrationsExpand and MigrationsContract (lib/migrations-resource.ts).
// The framework of CDK (Provider) calls this function with the CloudFormation event, waits for the answer, and
// tells CloudFormation. An error that this function throws fails the resource, so it fails the stack update and the release.
//
// CloudFormation calls the function on Create and on Update. The properties change in each release (the version),
// so every release calls it. The runner is safe to repeat, so a call with nothing to do changes nothing.

interface Event {
  readonly RequestType: string;
  readonly PhysicalResourceId?: string;
  readonly ResourceProperties: Record<string, unknown>;
}

export interface MigrateAnswer {
  readonly PhysicalResourceId: string;
  readonly Data: Record<string, string>;
}

export interface Ports {
  readonly data: DataPort;
  readonly ledger: LedgerPort;
  readonly floor: FloorPort;
}

export interface MigrateDependencies {
  readonly ports: () => Ports;
  readonly migrations: readonly Migration[];
  readonly log?: (event: Record<string, unknown>) => void;
}

function property(properties: Record<string, unknown>, name: string): string {
  const value = properties[name];
  if (typeof value !== 'string' || value === '') throw new Error(`The custom resource property ${name} is missing.`);
  return value;
}

function phaseOf(properties: Record<string, unknown>): Phase {
  const phase = property(properties, 'Phase');
  if (phase !== 'expand' && phase !== 'contract') {
    throw new Error(`The custom resource property Phase must be expand or contract, but it is "${phase}".`);
  }
  return phase;
}

export function createMigrateHandler(dependencies: MigrateDependencies): (event: never) => Promise<MigrateAnswer> {
  const log = dependencies.log ?? ((entry: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify(entry)}\n`));

  return async (raw: never): Promise<MigrateAnswer> => {
    const event = raw as Event;
    const properties = event.ResourceProperties;
    const phase = phaseOf(properties);
    const physicalId = `migrations-${phase}`;

    if (event.RequestType === 'Delete') {
      // A copy for a laptop or a preview (Retain is false) removes its floor parameter with the stack.
      // A stack with retained data keeps the parameter, because the data stays too. Only the expand resource does this.
      if (phase === 'expand' && properties.Retain === 'false') await dependencies.ports().floor.remove();
      return { PhysicalResourceId: event.PhysicalResourceId ?? physicalId, Data: {} };
    }
    if (event.RequestType !== 'Create' && event.RequestType !== 'Update') {
      throw new Error(`Unknown request type "${event.RequestType}".`);
    }

    const version = property(properties, 'Version');
    const declaredFloor = property(properties, 'MinRollbackVersion');
    if (!isVersion(declaredFloor)) {
      throw new Error(`The custom resource property MinRollbackVersion must be a version like 1.2.3, but it is "${declaredFloor}".`);
    }
    if (!isVersion(version)) throw new Error(`The custom resource property Version must be a version like 1.2.3, but it is "${version}".`);

    const ports = dependencies.ports();
    const result = await runMigrations(
      { phase, version, declaredFloor, migrations: dependencies.migrations },
      { ...ports, log },
    );
    return { PhysicalResourceId: physicalId, Data: { Ran: result.ran.join(','), Floor: result.floor } };
  };
}

function realPorts(): Ports {
  const tableName = process.env.TABLE_NAME;
  const parameterName = process.env.FLOOR_PARAMETER;
  if (!tableName || !parameterName) throw new Error('The function needs the environment variables TABLE_NAME and FLOOR_PARAMETER.');
  const store = new DynamoStore({ client: DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName });
  return { data: store, ledger: store, floor: new SsmFloor({ client: new SSMClient({}), parameterName }) };
}

export const handler = createMigrateHandler({ ports: realPorts, migrations: MIGRATIONS });
