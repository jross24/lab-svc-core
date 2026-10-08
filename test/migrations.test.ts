import { describe, expect, it } from 'vitest';
import { SEED_ITEMS } from '../lib/migrations/0001-seed-items.ts';
import { addTitle } from '../lib/migrations/0002-add-title.ts';
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

  it('has only expand migrations in this release', () => {
    expect(MIGRATIONS.map((migration) => migration.phase)).toEqual(['expand', 'expand']);
  });
});

describe('0001-seed-items', () => {
  it('creates the three starting items, each with a name', async () => {
    const store = new MemoryStore();
    await deploy(store, '0.8.0', '0.1.0');
    expect((await store.listItems()).map((item) => item.id)).toEqual(['item-1', 'item-2', 'item-3']);
    expect(store.items.get('item-1')).toMatchObject({ id: 'item-1', name: 'First item' });
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
    expect(store.items.get('item-2')).toMatchObject({ id: 'item-2', name: 'Changed by a person' });
    expect(store.items.size).toBe(SEED_ITEMS.length);
  });
});

describe('0002-add-title (expand)', () => {
  it('gives each item a title that equals its name, and keeps the name', async () => {
    const store = new MemoryStore([
      { id: 'item-1', name: 'First item' },
      { id: 'item-2', name: 'Second item' },
    ]);
    await runMigrations(
      { phase: 'expand', version: '0.9.0', declaredFloor: '0.1.0', migrations: [addTitle] },
      { data: store, ledger: store, floor: store, log: () => undefined },
    );
    expect(store.items.get('item-1')).toEqual({ id: 'item-1', name: 'First item', title: 'First item' });
    expect(store.items.get('item-2')).toEqual({ id: 'item-2', name: 'Second item', title: 'Second item' });
  });

  it('is an expand migration: it removes nothing, so the previous version still reads the data', () => {
    expect(addTitle.phase).toBe('expand');
    expect(addTitle.contracts).toBeUndefined();
  });

  it('does not overwrite a title that exists, so a change by a person stays', async () => {
    const store = new MemoryStore([{ id: 'item-1', name: 'Old', title: 'Chosen by a person' }]);
    await addTitle.up(store);
    expect(store.items.get('item-1')).toEqual({ id: 'item-1', name: 'Old', title: 'Chosen by a person' });
  });

  it('leaves an item without a name alone', async () => {
    const store = new MemoryStore([{ id: 'item-1' }]);
    await addTitle.up(store);
    expect(store.items.get('item-1')).toEqual({ id: 'item-1' });
  });

  it('is safe to repeat', async () => {
    const store = new MemoryStore([{ id: 'item-1', name: 'A' }]);
    await addTitle.up(store);
    const once = JSON.stringify([...store.items.entries()]);
    await addTitle.up(store);
    expect(JSON.stringify([...store.items.entries()])).toBe(once);
  });

  it('runs after the seed in one deployment, so the seed items get a title too', async () => {
    const store = new MemoryStore();
    await deploy(store, '0.9.0', '0.1.0');
    for (const item of await store.listItems()) expect(item).toHaveProperty('title', item.name);
  });

  it('keeps the rollback floor where it was, because the previous version still reads the data', async () => {
    const store = new MemoryStore();
    await deploy(store, '0.9.0', '0.1.0');
    expect(store.floor).toBe('0.1.0');
  });
});
