import { describe, expect, it } from 'vitest';
import { SEED_ITEMS } from '../lib/migrations/0001-seed-items.ts';
import { MIGRATIONS } from '../lib/migrations/list.ts';
import { runMigrations, validateMigrations } from '../lib/migrations/runner.ts';
import { MemoryStore } from './support/memory-store.ts';

// Runs the whole list of this release against an in-memory table: first the expand phase, then the contract phase.
async function deploy(store: MemoryStore, version: string, declaredFloor: string): Promise<void> {
  for (const phase of ['expand', 'contract'] as const) {
    await runMigrations(
      { phase, version, declaredFloor, migrations: MIGRATIONS },
      { data: store, ledger: store, floor: store, log: () => undefined },
    );
  }
}

describe('the list of migrations', () => {
  it('is valid', () => {
    expect(() => validateMigrations(MIGRATIONS)).not.toThrow();
  });
});

describe('0001-seed-items', () => {
  it('creates the three starting items, each with a name', async () => {
    const store = new MemoryStore();
    await deploy(store, '0.8.0', '0.1.0');
    expect((await store.listItems()).map((item) => item.id)).toEqual(['item-1', 'item-2', 'item-3']);
    expect(store.items.get('item-1')).toEqual({ id: 'item-1', name: 'First item' });
  });

  it('is safe to repeat: a second deployment changes nothing', async () => {
    const store = new MemoryStore();
    await deploy(store, '0.8.0', '0.1.0');
    const before = JSON.stringify([...store.items.entries()]);
    await deploy(store, '0.8.1', '0.1.0');
    expect(JSON.stringify([...store.items.entries()])).toBe(before);
  });

  it('does not overwrite an item that exists, so a change by a person stays', async () => {
    const store = new MemoryStore([{ id: 'item-2', name: 'Changed by a person' }]);
    await deploy(store, '0.8.0', '0.1.0');
    expect(store.items.get('item-2')).toEqual({ id: 'item-2', name: 'Changed by a person' });
    expect(store.items.size).toBe(SEED_ITEMS.length);
  });
});
