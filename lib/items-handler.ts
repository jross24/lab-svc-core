import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda';
import { DynamoStore } from './dynamo-store.ts';
import { instrument } from './instrument.ts';
import type { ItemRecord } from './migrations/types.ts';

type JsonResponse = APIGatewayProxyStructuredResultV2 & { readonly statusCode: number; readonly body: string };

const SERVICE = 'core';

// Reads all the items of the table. The default reads DynamoDB. A test gives its own.
export type ReadItems = () => Promise<readonly ItemRecord[]>;

// The one place where the service fails on purpose. The stage config sets INJECT_FAULT for a stage.
// It is a device for the release drill, not a practice for production. See "The Production drill" in the README.
function failOnPurpose(): void {
  if (process.env.INJECT_FAULT === 'true') {
    throw new Error('injected fault: the stage config of this release sets injectFault');
  }
}

// The shape of an item in the answer. The README section "Data" explains how this changes in two releases.
// An item without a name is a fault in the data. The handler throws, so Lambda counts an error and the alarms see it.
function toItem(row: ItemRecord): { readonly id: string; readonly name: string } {
  if (typeof row.name !== 'string') throw new Error(`The item ${row.id} has no attribute name.`);
  return { id: row.id, name: row.name };
}

export function createItemsHandler(readItems: ReadItems): (event: APIGatewayProxyEventV2, context: Context) => Promise<JsonResponse> {
  async function itemsHandler(): Promise<JsonResponse> {
    failOnPurpose();
    const rows = await readItems();
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        service: SERVICE,
        // The stack sets VERSION at synth time, so the response shows which release runs.
        version: process.env.VERSION ?? 'unknown',
        items: rows.map(toItem),
      }),
    };
  }
  return instrument({ service: SERVICE }, itemsHandler);
}

// The client is made when the module loads, so the work counts as the init of the function and not as the duration of a call.
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function readFromTable(): Promise<readonly ItemRecord[]> {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error('The function needs the environment variable TABLE_NAME.');
  return new DynamoStore({ client, tableName }).listItems();
}

export const handler = createItemsHandler(readFromTable);
