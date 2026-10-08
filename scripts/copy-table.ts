import { pathToFileURL } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

// Copies every row of one table into another table: the items and the ledger of the migrations.
// Use it after a restore: the restore makes a NEW table, and this script puts its rows back into the table that the
// stack owns. The README section "Restore" explains when to use it and what it does not do.
//
//   node scripts/copy-table.ts <from-table> <to-table>
//
// A row in the target that has the same id is overwritten. A row that exists only in the target stays.
// The tool works with the credentials of the shell (AWS_PROFILE, AWS_REGION). It is for a person, not for the pipeline.

interface Sender {
  send(command: never): Promise<unknown>;
}

export async function copyTable(client: Sender, from: string, to: string): Promise<number> {
  if (from === to) throw new Error('The source table and the target table are the same table.');
  let copied = 0;
  let start: Record<string, unknown> | undefined;
  do {
    const page = (await client.send(
      new ScanCommand({ TableName: from, ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }) }) as never,
    )) as { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      await client.send(new PutCommand({ TableName: to, Item: item }) as never);
      copied += 1;
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return copied;
}

async function main(argv: readonly string[]): Promise<number> {
  const [from, to] = argv;
  if (!from || !to || argv.length !== 2) {
    console.error('Usage: node scripts/copy-table.ts <from-table> <to-table>');
    return 2;
  }
  const copied = await copyTable(DynamoDBDocumentClient.from(new DynamoDBClient({})), from, to);
  console.log(`Copied ${copied} rows from ${from} to ${to}.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
