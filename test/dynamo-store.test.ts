import { describe, expect, it } from 'vitest';
import { DeleteParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoStore, LEDGER_PREFIX, SsmFloor } from '../lib/dynamo-store.ts';

interface Sent {
  readonly type: string;
  readonly input: Record<string, unknown>;
}

// A client that records the commands and answers from a queue. An answer that is an Error is thrown.
function fakeClient(answers: readonly unknown[] = []) {
  const sent: Sent[] = [];
  const queue = [...answers];
  return {
    sent,
    client: {
      send: (command: never): Promise<unknown> => {
        const { constructor, input } = command as { constructor: { name: string }; input: Record<string, unknown> };
        sent.push({ type: constructor.name, input });
        const answer = queue.shift() ?? {};
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    },
  };
}

function conditionFailed(): Error {
  const error = new Error('The conditional request failed');
  error.name = 'ConditionalCheckFailedException';
  return error;
}

const TABLE = 'items-table';

describe('DynamoStore: the items', () => {
  it('lists the items with a strongly consistent scan that leaves out the ledger', async () => {
    const { client, sent } = fakeClient([{ Items: [{ id: 'item-1', name: 'A' }] }]);
    const store = new DynamoStore({ client, tableName: TABLE });
    await expect(store.listItems()).resolves.toEqual([{ id: 'item-1', name: 'A' }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe(ScanCommand.name);
    expect(sent[0]?.input).toMatchObject({
      TableName: TABLE,
      ConsistentRead: true,
      FilterExpression: 'NOT begins_with(id, :ledger)',
      ExpressionAttributeValues: { ':ledger': LEDGER_PREFIX },
    });
  });

  it('follows the pages of the scan, and sorts the items by id', async () => {
    const { client, sent } = fakeClient([
      { Items: [{ id: 'item-2' }], LastEvaluatedKey: { id: 'item-2' } },
      { Items: [{ id: 'item-1' }] },
    ]);
    const items = await new DynamoStore({ client, tableName: TABLE }).listItems();
    expect(items.map((item) => item.id)).toEqual(['item-1', 'item-2']);
    expect(sent[1]?.input).toMatchObject({ ExclusiveStartKey: { id: 'item-2' } });
  });

  it('creates an item only if no item has the id, and tells if it created it', async () => {
    const { client, sent } = fakeClient([{}, conditionFailed()]);
    const store = new DynamoStore({ client, tableName: TABLE });
    await expect(store.putItemIfAbsent({ id: 'item-1', name: 'A' })).resolves.toBe(true);
    await expect(store.putItemIfAbsent({ id: 'item-1', name: 'B' })).resolves.toBe(false);
    expect(sent[0]?.type).toBe(PutCommand.name);
    expect(sent[0]?.input).toMatchObject({
      TableName: TABLE,
      ConditionExpression: 'attribute_not_exists(id)',
      Item: { id: 'item-1', name: 'A' },
    });
  });

  it('sets an attribute only on an existing item that does not have it', async () => {
    const { client, sent } = fakeClient([{}, conditionFailed()]);
    const store = new DynamoStore({ client, tableName: TABLE });
    await expect(store.setAttributeIfAbsent('item-1', 'title', 'A')).resolves.toBe(true);
    await expect(store.setAttributeIfAbsent('item-1', 'title', 'B')).resolves.toBe(false);
    expect(sent[0]?.type).toBe(UpdateCommand.name);
    expect(sent[0]?.input).toMatchObject({
      Key: { id: 'item-1' },
      UpdateExpression: 'SET #a = :v',
      ConditionExpression: 'attribute_exists(id) AND attribute_not_exists(#a)',
      ExpressionAttributeNames: { '#a': 'title' },
      ExpressionAttributeValues: { ':v': 'A' },
    });
  });

  it('removes an attribute, and does not fail if the item is gone', async () => {
    const { client, sent } = fakeClient([{}, conditionFailed()]);
    const store = new DynamoStore({ client, tableName: TABLE });
    await store.removeAttribute('item-1', 'name');
    await expect(store.removeAttribute('item-9', 'name')).resolves.toBeUndefined();
    expect(sent[0]?.input).toMatchObject({
      Key: { id: 'item-1' },
      UpdateExpression: 'REMOVE #a',
      ConditionExpression: 'attribute_exists(id)',
      ExpressionAttributeNames: { '#a': 'name' },
    });
  });

  it('passes on any other error', async () => {
    const { client } = fakeClient([new Error('throttled')]);
    await expect(new DynamoStore({ client, tableName: TABLE }).putItemIfAbsent({ id: 'x' })).rejects.toThrow('throttled');
  });
});

describe('DynamoStore: the ledger', () => {
  it('keeps a record in the same table, under an id with the prefix', async () => {
    const { client, sent } = fakeClient();
    const store = new DynamoStore({ client, tableName: TABLE });
    await store.markStarted({
      id: '0003-drop-name',
      status: 'started',
      phase: 'contract',
      version: '1.0.0',
      startedAt: '2026-10-08T12:00:00.000Z',
      minRollbackVersion: '0.9.0',
    });
    expect(sent[0]?.type).toBe(PutCommand.name);
    expect(sent[0]?.input).toMatchObject({
      TableName: TABLE,
      Item: {
        id: `${LEDGER_PREFIX}0003-drop-name`,
        status: 'started',
        phase: 'contract',
        version: '1.0.0',
        startedAt: '2026-10-08T12:00:00.000Z',
        minRollbackVersion: '0.9.0',
      },
    });
    expect(sent[0]?.input).not.toHaveProperty('ConditionExpression');
  });

  it('marks a record as done', async () => {
    const { client, sent } = fakeClient();
    await new DynamoStore({ client, tableName: TABLE }).markDone('0003-drop-name', '2026-10-08T12:01:00.000Z');
    expect(sent[0]?.input).toMatchObject({
      Key: { id: `${LEDGER_PREFIX}0003-drop-name` },
      ConditionExpression: 'attribute_exists(id)',
      ExpressionAttributeValues: { ':done': 'done', ':t': '2026-10-08T12:01:00.000Z' },
    });
  });

  it('reads the records with a scan on the prefix, and gives the ids without the prefix', async () => {
    const { client, sent } = fakeClient([
      {
        Items: [
          { id: `${LEDGER_PREFIX}0001-seed-items`, status: 'done', phase: 'expand', version: '0.8.0', startedAt: 'a', finishedAt: 'b' },
          {
            id: `${LEDGER_PREFIX}0003-drop-name`,
            status: 'started',
            phase: 'contract',
            version: '1.0.0',
            startedAt: 'c',
            minRollbackVersion: '0.9.0',
          },
        ],
      },
    ]);
    const records = await new DynamoStore({ client, tableName: TABLE }).readAll();
    expect(sent[0]?.input).toMatchObject({ FilterExpression: 'begins_with(id, :ledger)', ConsistentRead: true });
    expect(records).toEqual([
      { id: '0001-seed-items', status: 'done', phase: 'expand', version: '0.8.0', startedAt: 'a', finishedAt: 'b' },
      { id: '0003-drop-name', status: 'started', phase: 'contract', version: '1.0.0', startedAt: 'c', minRollbackVersion: '0.9.0' },
    ]);
  });
});

describe('SsmFloor', () => {
  it('writes the floor as a plain String parameter and overwrites the old value', async () => {
    const { client, sent } = fakeClient();
    await new SsmFloor({ client, parameterName: '/lab/core/min-rollback-version' }).write('0.9.0');
    expect(sent[0]?.type).toBe(PutParameterCommand.name);
    expect(sent[0]?.input).toMatchObject({
      Name: '/lab/core/min-rollback-version',
      Value: '0.9.0',
      Type: 'String',
      Overwrite: true,
    });
  });

  it('removes the parameter, and does not fail if it is gone', async () => {
    const missing = new Error('not found');
    missing.name = 'ParameterNotFound';
    const { client, sent } = fakeClient([{}, missing]);
    const floor = new SsmFloor({ client, parameterName: '/lab/core/min-rollback-version' });
    await floor.remove();
    await expect(floor.remove()).resolves.toBeUndefined();
    expect(sent[0]?.type).toBe(DeleteParameterCommand.name);
  });
});
