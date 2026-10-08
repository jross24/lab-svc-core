import { DeleteParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DataPort, FloorPort, ItemRecord, LedgerPort, LedgerRecord } from './migrations/types.ts';

// The real store of the service: one DynamoDB table for the items and for the ledger of the migrations.
// The AWS SDK v3 is a part of the Node.js 22 runtime of Lambda, so the bundle does not include it.
// The packages are dev dependencies for the types and for the tests only.
//
// The ledger lives in the same table as the items. The id of a ledger record starts with this prefix. No item has it.
// So a restore of the table (point in time) restores the items and the ledger together, and they always agree.
export const LEDGER_PREFIX = '#migration#';

// The two clients (DynamoDBDocumentClient and SSMClient) have a method send(command). The tests give a fake one.
export interface Sender {
  send(command: never): Promise<unknown>;
}

function isError(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

export class DynamoStore implements DataPort, LedgerPort {
  private readonly client: Sender;
  private readonly tableName: string;

  constructor(options: { readonly client: Sender; readonly tableName: string }) {
    this.client = options.client;
    this.tableName = options.tableName;
  }

  private send(command: PutCommand | ScanCommand | UpdateCommand): Promise<unknown> {
    return this.client.send(command as never);
  }

  // A scan reads at most 1 MB. The loop follows the pages. The table of the lab is tiny.
  // A consistent read, so that a migration that finished is visible to the next read at once.
  private async scan(filter: string): Promise<Record<string, unknown>[]> {
    const found: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = (await this.send(
        new ScanCommand({
          TableName: this.tableName,
          ConsistentRead: true,
          FilterExpression: filter,
          ExpressionAttributeValues: { ':ledger': LEDGER_PREFIX },
          ...(start === undefined ? {} : { ExclusiveStartKey: start }),
        }),
      )) as { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> };
      found.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start !== undefined);
    return found;
  }

  async listItems(): Promise<readonly ItemRecord[]> {
    const items = await this.scan('NOT begins_with(id, :ledger)');
    return (items as ItemRecord[]).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async putItemIfAbsent(item: ItemRecord): Promise<boolean> {
    try {
      await this.send(
        new PutCommand({ TableName: this.tableName, Item: { ...item }, ConditionExpression: 'attribute_not_exists(id)' }),
      );
      return true;
    } catch (error) {
      if (isError(error, 'ConditionalCheckFailedException')) return false;
      throw error;
    }
  }

  async setAttributeIfAbsent(id: string, attribute: string, value: unknown): Promise<boolean> {
    try {
      await this.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { id },
          UpdateExpression: 'SET #a = :v',
          ConditionExpression: 'attribute_exists(id) AND attribute_not_exists(#a)',
          ExpressionAttributeNames: { '#a': attribute },
          ExpressionAttributeValues: { ':v': value },
        }),
      );
      return true;
    } catch (error) {
      if (isError(error, 'ConditionalCheckFailedException')) return false;
      throw error;
    }
  }

  async removeAttribute(id: string, attribute: string): Promise<void> {
    try {
      await this.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { id },
          UpdateExpression: 'REMOVE #a',
          // The condition keeps an update from creating an item that does not exist.
          ConditionExpression: 'attribute_exists(id)',
          ExpressionAttributeNames: { '#a': attribute },
        }),
      );
    } catch (error) {
      if (isError(error, 'ConditionalCheckFailedException')) return;
      throw error;
    }
  }

  async readAll(): Promise<readonly LedgerRecord[]> {
    const rows = await this.scan('begins_with(id, :ledger)');
    return rows.map((row) => ({ ...row, id: String(row.id).slice(LEDGER_PREFIX.length) }) as unknown as LedgerRecord);
  }

  async markStarted(record: LedgerRecord): Promise<void> {
    await this.send(new PutCommand({ TableName: this.tableName, Item: { ...record, id: `${LEDGER_PREFIX}${record.id}` } }));
  }

  async markDone(id: string, finishedAt: string): Promise<void> {
    await this.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { id: `${LEDGER_PREFIX}${id}` },
        UpdateExpression: 'SET #s = :done, finishedAt = :t',
        ConditionExpression: 'attribute_exists(id)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':done': 'done', ':t': finishedAt },
      }),
    );
  }
}

// The rollback floor of the environment: one SSM parameter. The pipeline reads it (the role github-deploy can read /lab/*).
// CloudFormation does not own this parameter. A rollback of the stack must not lower it.
export class SsmFloor implements FloorPort {
  private readonly client: Sender;
  private readonly parameterName: string;

  constructor(options: { readonly client: Sender; readonly parameterName: string }) {
    this.client = options.client;
    this.parameterName = options.parameterName;
  }

  async write(version: string): Promise<void> {
    await this.client.send(
      new PutParameterCommand({
        Name: this.parameterName,
        Value: version,
        Type: 'String',
        Overwrite: true,
        Description:
          'The oldest version of core that can still run against the data in this account. Written by the migration step of the stack.',
      }) as never,
    );
  }

  async remove(): Promise<void> {
    try {
      await this.client.send(new DeleteParameterCommand({ Name: this.parameterName }) as never);
    } catch (error) {
      if (isError(error, 'ParameterNotFound')) return;
      throw error;
    }
  }
}
