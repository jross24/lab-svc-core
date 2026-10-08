import { describe, expect, it } from 'vitest';
import { createMigrateHandler } from '../lib/migrate-handler.ts';
import type { Migration } from '../lib/migrations/types.ts';
import { MemoryStore } from './support/memory-store.ts';

const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001-seed',
    phase: 'expand',
    description: 'seed',
    up: async (data) => {
      await data.putItemIfAbsent({ id: 'item-1', name: 'One' });
    },
  },
];

function handlerFor(store: MemoryStore, migrations: readonly Migration[] = MIGRATIONS) {
  return createMigrateHandler({ ports: () => ({ data: store, ledger: store, floor: store }), migrations, log: () => undefined });
}

function event(requestType: string, properties: Record<string, unknown> = {}, physicalResourceId?: string) {
  return {
    RequestType: requestType,
    ResourceProperties: { ServiceToken: 'arn:token', Phase: 'expand', Version: '0.8.0', MinRollbackVersion: '0.1.0', Retain: 'true', ...properties },
    ...(physicalResourceId === undefined ? {} : { PhysicalResourceId: physicalResourceId }),
  } as never;
}

describe('the migration handler (a custom resource of CloudFormation)', () => {
  it('runs the migrations on Create and answers with a fixed physical id for the phase', async () => {
    const store = new MemoryStore();
    const answer = await handlerFor(store)(event('Create'));
    expect(answer).toMatchObject({ PhysicalResourceId: 'migrations-expand', Data: { Ran: '0001-seed', Floor: '0.1.0' } });
    expect(store.items.get('item-1')).toEqual({ id: 'item-1', name: 'One' });
    expect(store.floor).toBe('0.1.0');
  });

  it('runs the migrations on Update, and runs nothing new the second time', async () => {
    const store = new MemoryStore();
    const handler = handlerFor(store);
    await handler(event('Create'));
    const second = await handler(event('Update', { Version: '0.8.1' }, 'migrations-expand'));
    expect(second).toMatchObject({ PhysicalResourceId: 'migrations-expand', Data: { Ran: '' } });
  });

  it('fails the deployment when a migration fails: the handler throws, and the framework tells CloudFormation', async () => {
    const store = new MemoryStore();
    const failing: Migration = { id: '0001-seed', phase: 'expand', description: 'x', up: () => Promise.reject(new Error('disk on fire')) };
    await expect(handlerFor(store, [failing])(event('Create'))).rejects.toThrow(/0001-seed failed: disk on fire/);
  });

  it('runs the contract phase only when the property Phase says so', async () => {
    const store = new MemoryStore();
    const migrations: readonly Migration[] = [
      ...MIGRATIONS,
      {
        id: '0002-drop',
        phase: 'contract',
        contracts: '0001-seed',
        description: 'drop',
        up: async (data) => {
          await data.removeAttribute('item-1', 'name');
        },
      },
    ];
    const handler = handlerFor(store, migrations);
    await handler(event('Create', { Phase: 'expand', Version: '0.8.0' }));
    expect(store.items.get('item-1')).toHaveProperty('name');
    await handler(event('Create', { Phase: 'contract', Version: '0.9.0', MinRollbackVersion: '0.8.0' }));
    expect(store.items.get('item-1')).not.toHaveProperty('name');
    expect(store.floor).toBe('0.8.0');
  });

  it('removes the floor on Delete of the expand resource when the data is not retained (a Dev copy)', async () => {
    const store = new MemoryStore();
    store.floor = '0.1.0';
    const answer = await handlerFor(store)(event('Delete', { Retain: 'false' }, 'migrations-expand'));
    expect(answer).toMatchObject({ PhysicalResourceId: 'migrations-expand' });
    expect(store.floor).toBeUndefined();
  });

  it('keeps the floor on Delete when the data is retained (Test, Staging, Production)', async () => {
    const store = new MemoryStore();
    store.floor = '0.9.0';
    await handlerFor(store)(event('Delete', { Retain: 'true' }, 'migrations-expand'));
    expect(store.floor).toBe('0.9.0');
  });

  it('does not remove the floor on Delete of the contract resource', async () => {
    const store = new MemoryStore();
    store.floor = '0.1.0';
    await handlerFor(store)(event('Delete', { Retain: 'false', Phase: 'contract' }, 'migrations-contract'));
    expect(store.floor).toBe('0.1.0');
  });

  it.each([
    ['an unknown phase', { Phase: 'sideways' }],
    ['no version', { Version: '' }],
    ['a floor that is not a version', { MinRollbackVersion: 'abc' }],
  ])('refuses %s', async (_label, properties) => {
    await expect(handlerFor(new MemoryStore())(event('Create', properties))).rejects.toThrow(/property/i);
  });

  it('refuses an unknown request type', async () => {
    await expect(handlerFor(new MemoryStore())(event('Explode'))).rejects.toThrow(/request type/i);
  });
});
