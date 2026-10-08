import { describe, expect, it } from 'vitest';
import { MigrationError, runMigrations, validateMigrations } from '../lib/migrations/runner.ts';
import type { DataPort, Migration, Phase } from '../lib/migrations/types.ts';
import { MemoryStore } from './support/memory-store.ts';

// Builds a migration that records its own run in `store.calls`, so a test can see when it ran.
function migration(
  store: MemoryStore,
  id: string,
  phase: Phase,
  options: { contracts?: string; fail?: boolean; up?: (data: DataPort) => Promise<void> } = {},
): Migration {
  return {
    id,
    phase,
    description: `test migration ${id}`,
    ...(options.contracts === undefined ? {} : { contracts: options.contracts }),
    up: async (data) => {
      store.calls.push(`up ${id}`);
      if (options.fail) throw new Error('boom');
      await options.up?.(data);
    },
  };
}

const NOW = new Date('2026-10-08T12:00:00.000Z');

function run(
  store: MemoryStore,
  migrations: readonly Migration[],
  options: { phase?: Phase; version?: string; declaredFloor?: string } = {},
) {
  return runMigrations(
    {
      phase: options.phase ?? 'expand',
      version: options.version ?? '0.8.0',
      declaredFloor: options.declaredFloor ?? '0.1.0',
      migrations,
    },
    { data: store, ledger: store, floor: store, now: () => NOW, log: () => undefined },
  );
}

describe('the order of the migrations', () => {
  it('runs the pending migrations of the phase in the order of their ids', async () => {
    const store = new MemoryStore();
    await run(store, [migration(store, '0001-a', 'expand'), migration(store, '0002-b', 'expand'), migration(store, '0010-c', 'expand')]);
    expect(store.calls.filter((call) => call.startsWith('up '))).toEqual(['up 0001-a', 'up 0002-b', 'up 0010-c']);
  });

  it('records each migration as done with the phase, the version and the times', async () => {
    const store = new MemoryStore();
    const result = await run(store, [migration(store, '0001-a', 'expand')], { version: '0.8.0' });
    expect(result.ran).toEqual(['0001-a']);
    expect(store.ledger.get('0001-a')).toEqual({
      id: '0001-a',
      status: 'done',
      phase: 'expand',
      version: '0.8.0',
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
    });
  });

  it('marks a migration as started before it runs and as done after it ran', async () => {
    const store = new MemoryStore();
    await run(store, [migration(store, '0001-a', 'expand')]);
    const calls = store.calls.filter((call) => call.endsWith('0001-a'));
    expect(calls).toEqual(['started 0001-a', 'up 0001-a', 'done 0001-a']);
  });

  it('runs only the migrations of the phase that it is asked for', async () => {
    const store = new MemoryStore();
    const list = [
      migration(store, '0001-a', 'expand'),
      migration(store, '0002-b', 'contract', { contracts: '0001-a' }),
    ];
    await run(store, list, { phase: 'expand' });
    expect([...store.ledger.keys()]).toEqual(['0001-a']);
    await run(store, list, { phase: 'contract', declaredFloor: '0.8.0' });
    expect([...store.ledger.keys()]).toEqual(['0001-a', '0002-b']);
  });
});

describe('exactly once, and safe to repeat', () => {
  it('runs nothing the second time', async () => {
    const store = new MemoryStore();
    const list = [migration(store, '0001-a', 'expand'), migration(store, '0002-b', 'expand')];
    await run(store, list);
    store.calls.length = 0;
    const second = await run(store, list);
    expect(second.ran).toEqual([]);
    expect(second.alreadyDone).toEqual(['0001-a', '0002-b']);
    expect(store.calls.filter((call) => call.startsWith('up '))).toEqual([]);
  });

  it('runs only the new migration when the list has grown', async () => {
    const store = new MemoryStore();
    await run(store, [migration(store, '0001-a', 'expand')]);
    store.calls.length = 0;
    const result = await run(store, [migration(store, '0001-a', 'expand'), migration(store, '0002-b', 'expand')]);
    expect(result.ran).toEqual(['0002-b']);
    expect(store.calls.filter((call) => call.startsWith('up '))).toEqual(['up 0002-b']);
  });
});

describe('a migration that fails', () => {
  it('stops the run, fails with a message that names the migration, and runs no later migration', async () => {
    const store = new MemoryStore();
    const list = [migration(store, '0001-a', 'expand', { fail: true }), migration(store, '0002-b', 'expand')];
    const failure = run(store, list);
    await expect(failure).rejects.toBeInstanceOf(MigrationError);
    await expect(failure).rejects.toThrow(/0001-a failed: boom/);
    expect(store.calls).not.toContain('up 0002-b');
  });

  it('leaves the record as started, so the next run runs the migration again', async () => {
    const store = new MemoryStore();
    await expect(run(store, [migration(store, '0001-a', 'expand', { fail: true })])).rejects.toThrow();
    expect(store.ledger.get('0001-a')?.status).toBe('started');

    store.calls.length = 0;
    const result = await run(store, [migration(store, '0001-a', 'expand')]);
    expect(result.ran).toEqual(['0001-a']);
    expect(store.ledger.get('0001-a')?.status).toBe('done');
  });

  it('does not write the floor after a failed expand run', async () => {
    const store = new MemoryStore();
    await expect(run(store, [migration(store, '0001-a', 'expand', { fail: true })])).rejects.toThrow();
    expect(store.floor).toBeUndefined();
  });
});

describe('a contract migration', () => {
  const expand = (store: MemoryStore) => migration(store, '0001-a', 'expand');
  const contract = (store: MemoryStore, options: { fail?: boolean } = {}) =>
    migration(store, '0002-b', 'contract', { contracts: '0001-a', ...options });

  async function afterExpand(version = '0.8.0'): Promise<MemoryStore> {
    const store = new MemoryStore();
    await run(store, [expand(store), contract(store)], { phase: 'expand', version, declaredFloor: '0.1.0' });
    store.calls.length = 0;
    return store;
  }

  it('writes the new floor and the started record BEFORE its first change of data', async () => {
    const store = await afterExpand('0.8.0');
    await run(store, [expand(store), contract(store)], { phase: 'contract', version: '0.9.0', declaredFloor: '0.8.0' });
    expect(store.calls).toEqual(['started 0002-b', 'floor 0.8.0', 'up 0002-b', 'done 0002-b', 'floor 0.8.0']);
  });

  it('stores the floor in the ledger record', async () => {
    const store = await afterExpand('0.8.0');
    await run(store, [expand(store), contract(store)], { phase: 'contract', version: '0.9.0', declaredFloor: '0.8.0' });
    expect(store.ledger.get('0002-b')).toMatchObject({ status: 'done', phase: 'contract', version: '0.9.0', minRollbackVersion: '0.8.0' });
    expect(store.floor).toBe('0.8.0');
  });

  it('refuses to run when the expand migration that it follows is not done', async () => {
    const store = new MemoryStore();
    const failure = run(store, [expand(store), contract(store)], { phase: 'contract', declaredFloor: '0.8.0' });
    await expect(failure).rejects.toThrow(/0002-b follows 0001-a, but 0001-a is not done/);
    expect(store.calls).toEqual([]);
  });

  it('refuses to run when the declared floor is older than the release that ran the expand migration', async () => {
    const store = await afterExpand('0.8.0');
    const failure = run(store, [expand(store), contract(store)], { phase: 'contract', version: '0.9.0', declaredFloor: '0.7.0' });
    await expect(failure).rejects.toThrow(/minRollbackVersion 0\.7\.0 .* 0\.8\.0/);
    // It changed nothing: no started record, no floor, no data change.
    expect(store.calls).toEqual([]);
    expect(store.ledger.has('0002-b')).toBe(false);
  });

  it('accepts a declared floor equal to the release that ran the expand migration, or newer', async () => {
    const equal = await afterExpand('0.8.0');
    await run(equal, [expand(equal), contract(equal)], { phase: 'contract', version: '0.9.0', declaredFloor: '0.8.0' });
    expect(equal.floor).toBe('0.8.0');
    const newer = await afterExpand('0.8.0');
    await run(newer, [expand(newer), contract(newer)], { phase: 'contract', version: '0.9.0', declaredFloor: '0.8.5' });
    expect(newer.floor).toBe('0.8.5');
  });

  it('keeps the raised floor when the migration fails, and runs again on the next release', async () => {
    const store = await afterExpand('0.8.0');
    const failure = run(store, [expand(store), contract(store, { fail: true })], {
      phase: 'contract',
      version: '0.9.0',
      declaredFloor: '0.8.0',
    });
    await expect(failure).rejects.toThrow(/0002-b failed/);
    expect(store.floor).toBe('0.8.0');
    expect(store.ledger.get('0002-b')).toMatchObject({ status: 'started', minRollbackVersion: '0.8.0' });

    store.calls.length = 0;
    const retry = await run(store, [expand(store), contract(store)], { phase: 'contract', version: '0.9.1', declaredFloor: '0.8.0' });
    expect(retry.ran).toEqual(['0002-b']);
    expect(store.ledger.get('0002-b')?.status).toBe('done');
  });
});

describe('the rollback floor never goes down', () => {
  const expand = (store: MemoryStore) => migration(store, '0001-a', 'expand');
  const contract = (store: MemoryStore) => migration(store, '0002-b', 'contract', { contracts: '0001-a' });

  it('writes the declared floor on an expand run with no contract migration', async () => {
    const store = new MemoryStore();
    await run(store, [expand(store)], { declaredFloor: '0.3.0' });
    expect(store.floor).toBe('0.3.0');
  });

  it('keeps the floor of the ledger when an OLDER release is deployed again (the redeploy case)', async () => {
    const store = new MemoryStore();
    await run(store, [expand(store), contract(store)], { phase: 'expand', version: '0.8.0', declaredFloor: '0.1.0' });
    await run(store, [expand(store), contract(store)], { phase: 'contract', version: '0.9.0', declaredFloor: '0.8.0' });
    expect(store.floor).toBe('0.8.0');

    // The old release knows only 0001-a and declares the old floor. A redeploy runs its migration step.
    const result = await run(store, [expand(store)], { phase: 'expand', version: '0.8.0', declaredFloor: '0.1.0' });
    expect(result.unknownInLedger).toEqual(['0002-b']);
    expect(result.floor).toBe('0.8.0');
    expect(store.floor).toBe('0.8.0');
  });

  it('counts a started record too, so a failed contract migration keeps the floor high', async () => {
    const store = new MemoryStore();
    store.ledger.set('0002-b', {
      id: '0002-b',
      status: 'started',
      phase: 'contract',
      version: '0.9.0',
      startedAt: NOW.toISOString(),
      minRollbackVersion: '0.8.0',
    });
    await run(store, [], { declaredFloor: '0.1.0' });
    expect(store.floor).toBe('0.8.0');
  });

  it('raises the floor when the declared floor is newer than every record', async () => {
    const store = new MemoryStore();
    await run(store, [expand(store)], { declaredFloor: '0.1.0' });
    await run(store, [expand(store)], { declaredFloor: '0.5.0', version: '0.8.1' });
    expect(store.floor).toBe('0.5.0');
  });

  it('refuses a declared floor that is not a version', async () => {
    const store = new MemoryStore();
    await expect(run(store, [expand(store)], { declaredFloor: 'abc' })).rejects.toThrow(/minRollbackVersion/);
  });
});

describe('validateMigrations', () => {
  const store = new MemoryStore();
  const ok = (id: string, phase: Phase = 'expand', contracts?: string) => migration(store, id, phase, contracts ? { contracts } : {});

  it('accepts an empty list and a good list', () => {
    expect(() => validateMigrations([])).not.toThrow();
    expect(() => validateMigrations([ok('0001-a'), ok('0002-b', 'contract', '0001-a')])).not.toThrow();
  });

  it.each(['1-a', '0001', '0001_a', '0001-A', 'a-0001', '0001-', '00001-a'])('refuses the id %j', (id) => {
    expect(() => validateMigrations([ok(id)])).toThrow(/id .* four digits/);
  });

  it('refuses a duplicate id', () => {
    expect(() => validateMigrations([ok('0001-a'), ok('0001-a')])).toThrow(/ascending order|twice/);
  });

  it('refuses a list that is not in ascending order of the ids', () => {
    expect(() => validateMigrations([ok('0002-b'), ok('0001-a')])).toThrow(/ascending order/);
  });

  it('refuses a contract migration with no "contracts"', () => {
    expect(() => validateMigrations([ok('0001-a'), ok('0002-b', 'contract')])).toThrow(/contract migration .* needs "contracts"/);
  });

  it('refuses an expand migration with "contracts"', () => {
    expect(() => validateMigrations([ok('0001-a'), ok('0002-b', 'expand', '0001-a')])).toThrow(/only a contract migration/);
  });

  it('refuses "contracts" that names no earlier expand migration', () => {
    expect(() => validateMigrations([ok('0001-a', 'contract', '0000-x')])).toThrow(/earlier expand migration/);
    expect(() => validateMigrations([ok('0001-a'), ok('0002-b', 'contract', '0003-c'), ok('0003-c')])).toThrow(/earlier expand migration/);
    expect(() => validateMigrations([ok('0001-a'), ok('0002-b', 'contract', '0001-a'), ok('0003-c', 'contract', '0002-b')])).toThrow(
      /earlier expand migration/,
    );
  });
});
