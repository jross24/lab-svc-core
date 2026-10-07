import { afterEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../lib/items-handler.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('items handler', () => {
  it('returns JSON with status 200', async () => {
    const response = await handler();
    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('returns the service name and a fixed list of items', async () => {
    const body: unknown = JSON.parse((await handler()).body);
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
    const body: unknown = JSON.parse((await handler()).body);
    expect(body).toMatchObject({ version: '1.2.3' });
  });

  it('returns the version "unknown" when the environment has no version', async () => {
    vi.stubEnv('VERSION', undefined);
    const body: unknown = JSON.parse((await handler()).body);
    expect(body).toMatchObject({ version: 'unknown' });
  });
});
