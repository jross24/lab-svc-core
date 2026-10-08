import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createItemsHandler } from '../lib/items-handler.ts';
import type { ItemRecord } from '../lib/migrations/types.ts';

const EVENT = { routeKey: 'GET /items' } as APIGatewayProxyEventV2;
const CONTEXT = { awsRequestId: 'req-7' } as Context;

const ROWS: readonly ItemRecord[] = [
  { id: 'item-1', name: 'First item' },
  { id: 'item-2', name: 'Second item' },
  { id: 'item-3', name: 'Third item' },
];

let written: string[];
let rows: readonly ItemRecord[];
let failure: Error | undefined;

// The handler reads the items through a function. The test gives the rows, so it needs no AWS.
const handler = createItemsHandler(() => (failure ? Promise.reject(failure) : Promise.resolve(rows)));

beforeEach(() => {
  rows = ROWS;
  failure = undefined;
  // The handler writes its log line and its metric line to stdout. Collect them, and keep the test output clean.
  written = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('items handler', () => {
  it('returns JSON with status 200', async () => {
    const response = await handler(EVENT, CONTEXT);
    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('returns the service name and the items that the table holds', async () => {
    const body: unknown = JSON.parse((await handler(EVENT, CONTEXT)).body);
    expect(body).toMatchObject({
      service: 'core',
      items: [
        { id: 'item-1', name: 'First item' },
        { id: 'item-2', name: 'Second item' },
        { id: 'item-3', name: 'Third item' },
      ],
    });
  });

  it('returns the version from the environment', async () => {
    vi.stubEnv('VERSION', '1.2.3');
    const body: unknown = JSON.parse((await handler(EVENT, CONTEXT)).body);
    expect(body).toMatchObject({ version: '1.2.3' });
  });

  it('returns the version "unknown" when the environment has no version', async () => {
    vi.stubEnv('VERSION', undefined);
    const body: unknown = JSON.parse((await handler(EVENT, CONTEXT)).body);
    expect(body).toMatchObject({ version: 'unknown' });
  });
});

describe('items handler data', () => {
  it('returns the items in the order of the reader and keeps only id and name', async () => {
    rows = [{ id: 'item-9', name: 'Ninth', extra: 'ignored' }];
    const body: unknown = JSON.parse((await handler(EVENT, CONTEXT)).body);
    expect(body).toMatchObject({ items: [{ id: 'item-9', name: 'Ninth' }] });
    expect(JSON.stringify(body)).not.toContain('ignored');
  });

  it('returns an empty list for an empty table', async () => {
    rows = [];
    const body: unknown = JSON.parse((await handler(EVENT, CONTEXT)).body);
    expect(body).toMatchObject({ items: [] });
  });

  it('throws when an item has no name, so Lambda counts an error and the alarms see a fault in the data', async () => {
    rows = [{ id: 'item-1' }];
    await expect(handler(EVENT, CONTEXT)).rejects.toThrow(/item-1 has no attribute name/);
    expect(JSON.parse(written[0] ?? '')).toMatchObject({ level: 'ERROR', status: 500 });
  });

  it('throws when the table cannot be read', async () => {
    failure = new Error('throttled');
    await expect(handler(EVENT, CONTEXT)).rejects.toThrow('throttled');
  });
});

describe('items handler telemetry', () => {
  it('writes one log line and one metric line to stdout for a request', async () => {
    vi.stubEnv('VERSION', '1.2.3');
    await handler(EVENT, CONTEXT);
    expect(written).toHaveLength(2);
    expect(written.every((chunk) => chunk.endsWith('\n') && chunk.indexOf('\n') === chunk.length - 1)).toBe(true);
    expect(JSON.parse(written[0] ?? '')).toMatchObject({
      level: 'INFO',
      service: 'core',
      version: '1.2.3',
      requestId: 'req-7',
      route: 'GET /items',
      status: 200,
    });
    expect(JSON.parse(written[1] ?? '')).toMatchObject({ service: 'core', version: '1.2.3', requests: 1, errors: 0 });
  });
});

describe('items handler fault switch', () => {
  it('throws when INJECT_FAULT is "true", so that Lambda counts an error', async () => {
    vi.stubEnv('INJECT_FAULT', 'true');
    await expect(handler(EVENT, CONTEXT)).rejects.toThrow(/injected fault/);
    expect(JSON.parse(written[0] ?? '')).toMatchObject({ level: 'ERROR', status: 500 });
    expect(JSON.parse(written[1] ?? '')).toMatchObject({ errors: 1 });
  });

  it.each(['false', '', 'TRUE', '1'])('does not throw when INJECT_FAULT is %j', async (value) => {
    vi.stubEnv('INJECT_FAULT', value);
    await expect(handler(EVENT, CONTEXT)).resolves.toMatchObject({ statusCode: 200 });
  });

  it('does not throw when INJECT_FAULT is not set', async () => {
    vi.stubEnv('INJECT_FAULT', undefined);
    await expect(handler(EVENT, CONTEXT)).resolves.toMatchObject({ statusCode: 200 });
  });
});
