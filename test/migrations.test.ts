import { describe, expect, it } from 'vitest';
import { SEED_ITEMS } from '../lib/migrations/0001-seed-items.ts';
import { addTitle } from '../lib/migrations/0002-add-title.ts';
import { dropName } from '../lib/migrations/0003-drop-name.ts';
import { MIGRATIONS } from '../lib/migrations/list.ts';
import { runMigrations, validateMigrations } from '../lib/migrations/runner.ts';
import type { Migration } from '../lib/migrations/types.ts';
import { MemoryStore } from './support/memory-store.ts';

// Runs a list of migrations against an in-memory table, as one deployment does: first the expand phase, then the contract phase.
// The default is the whole list of this release. A test of an older step gives the part of the list that existed then.
async function deploy(
  store: MemoryStore,
  version: string,
  declaredFloor: string,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<void> {
  for (const phase of ['expand', 'contract'] as const) {
    await runMigrations(
      { phase, version, declaredFloor, migrations },
      { data: store, ledger: store, floor: store, log: () => undefined },
    );
  }
}

const SEED_ONLY = MIGRATIONS.slice(0, 1);
const UP_TO_ADD_TITLE = MIGRATIONS.slice(0, 2);

describe('the list of migrations', () => {
  it('is valid', () => {
    expect(() => validateMigrations(MIGRATIONS)).not.toThrow();
  });

  it('has two expand migrations and then one contract migration', () => {
    expect(MIGRATIONS.map((migration) => migration.phase)).toEqual(['expand', 'expand', 'contract']);
  });
});

describe('0001-seed-items', () => {
  it('creates the three starting items, each with a name', async () => {
    const store = new MemoryStore();
    await deploy(store, '0.8.0', '0.1.0', SEED_ONLY);
    expect((await store.listItems()).map((item) => item.id)).toEqual(['item-1', 'item-2', 'item-3']);
    expect(store.items.get('item-1')).toEqual({ id: 'item-1', name: 'First item' });
  });

  it('is safe to repeat: a second deployment changes nothing', async () => {
    const store = new MemoryStore();
    await deploy(store, '0.8.0', '0.1.0', SEED_ONLY);
    const before = JSON.stringify([...store.items.entries()]);
    await deploy(store, '0.8.1', '0.1.0', SEED_ONLY);
    expect(JSON.stringify([...store.items.entries()])).toBe(before);
  });

  it('does not overwrite an item that exists, so a change by a person stays', async () => {
    const store = new MemoryStore([{ id: 'item-2', name: 'Changed by a person' }]);
    await deploy(store, '0.8.0', '0.1.0', SEED_ONLY);
    expect(store.items.get('item-2')).toEqual({ id: 'item-2', name: 'Changed by a person' });
    expect(store.items.size).toBe(SEED_ITEMS.length);
  });
});

describe('0002-add-title (expand)', () => {
  it('gives each item a title that equals its name, and keeps the name', async () => {
    const store = new MemoryStore([
      { id: 'item-1', name: 'First item' },
      { id: 'item-2', name: 'Second item' },
    ]);
    await addTitle.up(store);
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
    await deploy(store, '0.9.0', '0.1.0', UP_TO_ADD_TITLE);
    for (const item of await store.listItems()) expect(item).toHaveProperty('title', item.name);
  });

  it('keeps the rollback floor where it was, because the previous version still reads the data', async () => {
    const store = new MemoryStore();
    await deploy(store, '0.9.0', '0.1.0', UP_TO_ADD_TITLE);
    expect(store.floor).toBe('0.1.0');
  });
});

describe('0003-drop-name (contract)', () => {
  const both = () =>
    new MemoryStore([
      { id: 'item-1', name: 'First item', title: 'First item' },
      { id: 'item-2', name: 'Second item', title: 'Second item' },
    ]);

  it('removes the name and keeps the title', async () => {
    const store = both();
    await dropName.up(store);
    expect(store.items.get('item-1')).toEqual({ id: 'item-1', title: 'First item' });
    expect(store.items.get('item-2')).toEqual({ id: 'item-2', title: 'Second item' });
  });

  it('is a contract migration that follows the expand migration 0002-add-title', () => {
    expect(dropName.phase).toBe('contract');
    expect(dropName.contracts).toBe(addTitle.id);
  });

  it('refuses to run when an item has no title, names the item, and removes nothing', async () => {
    const store = new MemoryStore([
      { id: 'item-1', name: 'First item', title: 'First item' },
      { id: 'item-2', name: 'Second item' },
    ]);
    await expect(dropName.up(store)).rejects.toThrow(/item-2 have no title/);
    expect(store.items.get('item-1')).toHaveProperty('name');
    expect(store.items.get('item-2')).toHaveProperty('name');
    expect(store.calls.filter((call) => call.startsWith('remove'))).toEqual([]);
  });

  it('is safe to repeat', async () => {
    const store = both();
    await dropName.up(store);
    const once = JSON.stringify([...store.items.entries()]);
    await dropName.up(store);
    expect(JSON.stringify([...store.items.entries()])).toBe(once);
  });
});

describe('the whole rename in order (expand, then contract) on a table from before the rename', () => {
  it('ends with title only, and the floor at the release of the expand step', async () => {
    const store = new MemoryStore();
    // Release 0.8.0 had only the seed.
    await deploy(store, '0.8.0', '0.1.0', SEED_ONLY);
    expect(store.items.get('item-1')).toEqual({ id: 'item-1', name: 'First item' });
    // The expand release 0.9.0 adds the title and keeps the floor.
    await deploy(store, '0.9.0', '0.1.0', UP_TO_ADD_TITLE);
    expect(store.items.get('item-1')).toMatchObject({ name: 'First item', title: 'First item' });
    expect(store.floor).toBe('0.1.0');
    // The contract release 1.0.0 removes the name and raises the floor to the expand release.
    await deploy(store, '1.0.0', '0.9.0');
    expect(store.items.get('item-1')).toEqual({ id: 'item-1', title: 'First item' });
    expect(store.floor).toBe('0.9.0');
    expect(store.ledger.get('0003-drop-name')).toMatchObject({ status: 'done', version: '1.0.0', minRollbackVersion: '0.9.0' });
  });

  it('refuses the contract release when pipeline.json still declares the old floor, and removes nothing', async () => {
    const store = new MemoryStore();
    await deploy(store, '0.9.0', '0.1.0', UP_TO_ADD_TITLE);
    await expect(deploy(store, '1.0.0', '0.1.0')).rejects.toThrow(/minRollbackVersion 0\.1\.0 .* 0\.9\.0/);
    expect(store.items.get('item-1')).toHaveProperty('name');
  });

  it('keeps the floor high when the expand release is deployed again after the contract (the redeploy case)', async () => {
    const store = new MemoryStore();
    await deploy(store, '0.9.0', '0.1.0', UP_TO_ADD_TITLE);
    await deploy(store, '1.0.0', '0.9.0');
    // The old release 0.9.0 does not know 0003-drop-name. It runs its own list and its own, lower, declared floor.
    await deploy(store, '0.9.0', '0.1.0', UP_TO_ADD_TITLE);
    expect(store.floor).toBe('0.9.0');
  });
});
