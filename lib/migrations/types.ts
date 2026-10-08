// The parts of the migration runner. The runner (runner.ts) knows only these types. It does not know DynamoDB or SSM.
// So a unit test can run it with an in-memory store, and the real store (dynamo-store.ts) is small.

// expand: an additive step. It runs BEFORE the new code takes traffic. Old code can still read the data afterwards.
// contract: a destructive step. It runs AFTER the canary has finished. Old code can not read the data afterwards.
export type Phase = 'expand' | 'contract';

// One item of the table, as a plain object. Every item has the attribute id.
export type ItemRecord = { readonly id: string } & Readonly<Record<string, unknown>>;

// What a migration script may do with the items. Every operation is safe to repeat.
export interface DataPort {
  // All items of the service. The records of the ledger are not in the list.
  listItems(): Promise<readonly ItemRecord[]>;
  // Creates the item if no item has this id. Returns true if it created the item.
  putItemIfAbsent(item: ItemRecord): Promise<boolean>;
  // Sets the attribute if the item exists and does not have the attribute yet. Returns true if it set the attribute.
  setAttributeIfAbsent(id: string, attribute: string, value: unknown): Promise<boolean>;
  // Removes the attribute. Nothing happens if the item does not have it.
  removeAttribute(id: string, attribute: string): Promise<void>;
}

export interface Migration {
  // Four digits, a hyphen and a short name, for example 0002-add-title. The runner runs the migrations in the order of the ids.
  readonly id: string;
  readonly phase: Phase;
  readonly description: string;
  // Only a contract migration. The id of the expand migration that it follows. The runner refuses to run the
  // contract migration if that expand migration has not finished.
  readonly contracts?: string;
  up(data: DataPort): Promise<void>;
}

// The record of one migration. It lives in the same table as the items, so it follows the data (a restore of the
// table restores the ledger too).
export interface LedgerRecord {
  readonly id: string;
  // started: the migration began and did not finish. done: it finished. A started record is not done, so the next run runs it again.
  readonly status: 'started' | 'done';
  readonly phase: Phase;
  // The release that ran the migration.
  readonly version: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  // Only a contract migration. The oldest version that can still run against the data after this migration.
  readonly minRollbackVersion?: string;
}

export interface LedgerPort {
  readAll(): Promise<readonly LedgerRecord[]>;
  // Writes the record, also when a record exists (a started record of an earlier failed run).
  markStarted(record: LedgerRecord): Promise<void>;
  markDone(id: string, finishedAt: string): Promise<void>;
}

// The rollback floor of the environment. It is the SSM parameter /lab/core/min-rollback-version.
export interface FloorPort {
  write(version: string): Promise<void>;
  remove(): Promise<void>;
}
