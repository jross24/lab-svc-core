import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it, vi } from 'vitest';
import { CoreStack } from '../lib/core-stack.ts';
import { createItemsHandler } from '../lib/items-handler.ts';
import type { ItemRecord } from '../lib/migrations/types.ts';
import { STAGES } from '../lib/stages.ts';
import { readJsonFile, validate } from './support/contract-schema.ts';
import type { Contract, Schema } from './support/contract-schema.ts';

// The contract of this service is the file contract.json. Consumers read it (as a release asset), and the pull request
// check of the pipeline compares it with the contract that runs in Production. These tests keep the file true:
// the real handler answers as the file says, and the file lists the routes that the stack has.

const contract = readJsonFile<Contract>(new URL('../contract.json', import.meta.url));
const pipeline = readJsonFile<{ service: string }>(new URL('../pipeline.json', import.meta.url));

const EVENT = { routeKey: 'GET /items' } as APIGatewayProxyEventV2;
const CONTEXT = { awsRequestId: 'req-1' } as Context;

const ALLOWED_KEYS = ['type', 'properties', 'required', 'items', 'description'];

// The pipeline refuses any other keyword, so nobody thinks that it is checked.
function keywordProblems(schema: Schema, path: string): string[] {
  const problems = Object.keys(schema)
    .filter((key) => !ALLOWED_KEYS.includes(key))
    .map((key) => `${path}: unsupported keyword ${key}`);
  for (const [name, child] of Object.entries(schema.properties ?? {})) problems.push(...keywordProblems(child, `${path}.${name}`));
  if (schema.items) problems.push(...keywordProblems(schema.items, `${path}[]`));
  for (const name of schema.required ?? []) {
    if (!(name in (schema.properties ?? {}))) problems.push(`${path}: required name ${name} is not in properties`);
  }
  return problems;
}

async function answer(rows: readonly ItemRecord[]): Promise<unknown> {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const handler = createItemsHandler(() => Promise.resolve(rows));
  const response = await handler(EVENT, CONTEXT);
  vi.restoreAllMocks();
  return JSON.parse(response.body);
}

describe('contract.json', () => {
  it('names this service, the same name as pipeline.json', () => {
    expect(contract.service).toBe(pipeline.service);
  });

  it('lists the consumers that call this service', () => {
    expect(contract.consumers).toEqual(['catalogue', 'account']);
  });

  it('uses only the keywords that the pipeline understands', () => {
    for (const [endpoint, description] of Object.entries(contract.endpoints)) {
      for (const [status, schema] of Object.entries(description.responses)) {
        expect(keywordProblems(schema, `${endpoint} ${status}`)).toEqual([]);
      }
    }
  });

  it('lists exactly the routes that the stack has', { timeout: 30_000 }, () => {
    const stack = new CoreStack(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), 'Core', { version: '1.2.3', config: STAGES.Test });
    const routes = Object.values(Template.fromStack(stack).findResources('AWS::ApiGatewayV2::Route')).map(
      (route) => (route as { Properties: { RouteKey: string } }).Properties.RouteKey,
    );
    expect(Object.keys(contract.endpoints).sort()).toEqual(routes.sort());
  });
});

describe('the answer of GET /items', () => {
  const schema = contract.endpoints['GET /items']?.responses['200'] as Schema;

  it('has the shape of the contract for a table with items', async () => {
    const body = await answer([
      { id: 'item-1', name: 'First item' },
      { id: 'item-2', name: 'Second item' },
    ]);
    expect(validate(schema, body)).toEqual([]);
  });

  it('has the shape of the contract for an empty table', async () => {
    expect(validate(schema, await answer([]))).toEqual([]);
  });

  it('would not pass the check if the handler dropped a field of the contract (the test can fail)', () => {
    expect(validate(schema, { service: 'core', version: '1.2.3', items: [{ id: 'item-1' }] })).toEqual([
      '$.items[0].name: required property is missing',
    ]);
  });
});
