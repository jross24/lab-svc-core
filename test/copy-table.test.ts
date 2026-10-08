import { describe, expect, it } from 'vitest';
import { copyTable } from '../scripts/copy-table.ts';

function fakeClient(pages: readonly Record<string, unknown>[]) {
  const sent: { type: string; input: Record<string, unknown> }[] = [];
  const queue = [...pages];
  return {
    sent,
    client: {
      send: (command: never): Promise<unknown> => {
        const { constructor, input } = command as { constructor: { name: string }; input: Record<string, unknown> };
        sent.push({ type: constructor.name, input });
        return Promise.resolve(constructor.name === 'ScanCommand' ? (queue.shift() ?? {}) : {});
      },
    },
  };
}

describe('copyTable', () => {
  it('puts every row of the source table into the target table, also the ledger rows', async () => {
    const { client, sent } = fakeClient([
      { Items: [{ id: 'item-1', name: 'A' }, { id: '#migration#0001-seed-items', status: 'done' }] },
    ]);
    await expect(copyTable(client, 'restored', 'live')).resolves.toBe(2);
    const puts = sent.filter((call) => call.type === 'PutCommand');
    expect(puts.map((call) => call.input)).toEqual([
      { TableName: 'live', Item: { id: 'item-1', name: 'A' } },
      { TableName: 'live', Item: { id: '#migration#0001-seed-items', status: 'done' } },
    ]);
  });

  it('follows the pages of the scan', async () => {
    const { client, sent } = fakeClient([
      { Items: [{ id: 'a' }], LastEvaluatedKey: { id: 'a' } },
      { Items: [{ id: 'b' }] },
    ]);
    await expect(copyTable(client, 'restored', 'live')).resolves.toBe(2);
    expect(sent.filter((call) => call.type === 'ScanCommand')[1]?.input).toMatchObject({ ExclusiveStartKey: { id: 'a' } });
  });

  it('refuses to copy a table into itself', async () => {
    await expect(copyTable(fakeClient([]).client, 'same', 'same')).rejects.toThrow(/same table/);
  });

  it('copies nothing from an empty table', async () => {
    await expect(copyTable(fakeClient([{}]).client, 'restored', 'live')).resolves.toBe(0);
  });
});
