import type { DataPort, FloorPort, ItemRecord, LedgerPort, LedgerRecord } from '../../lib/migrations/types.ts';

// An in-memory table, ledger and floor for the tests of the runner and of the migration scripts.
// It records every call in `calls`, so a test can check the order of the steps.
export class MemoryStore implements DataPort, LedgerPort, FloorPort {
  readonly items = new Map<string, Record<string, unknown>>();
  readonly ledger = new Map<string, LedgerRecord>();
  floor: string | undefined;
  readonly calls: string[] = [];

  constructor(items: readonly Record<string, unknown>[] = []) {
    for (const item of items) this.items.set(String(item.id), { ...item });
  }

  // DataPort
  listItems(): Promise<readonly ItemRecord[]> {
    return Promise.resolve([...this.items.values()].map((item) => ({ ...item }) as ItemRecord));
  }

  putItemIfAbsent(item: ItemRecord): Promise<boolean> {
    this.calls.push(`put ${item.id}`);
    if (this.items.has(item.id)) return Promise.resolve(false);
    this.items.set(item.id, { ...item });
    return Promise.resolve(true);
  }

  setAttributeIfAbsent(id: string, attribute: string, value: unknown): Promise<boolean> {
    this.calls.push(`set ${id}.${attribute}`);
    const item = this.items.get(id);
    if (!item || attribute in item) return Promise.resolve(false);
    item[attribute] = value;
    return Promise.resolve(true);
  }

  removeAttribute(id: string, attribute: string): Promise<void> {
    this.calls.push(`remove ${id}.${attribute}`);
    const item = this.items.get(id);
    if (item) delete item[attribute];
    return Promise.resolve();
  }

  // LedgerPort
  readAll(): Promise<readonly LedgerRecord[]> {
    return Promise.resolve([...this.ledger.values()].map((record) => ({ ...record })));
  }

  markStarted(record: LedgerRecord): Promise<void> {
    this.calls.push(`started ${record.id}`);
    this.ledger.set(record.id, { ...record });
    return Promise.resolve();
  }

  markDone(id: string, finishedAt: string): Promise<void> {
    this.calls.push(`done ${id}`);
    const record = this.ledger.get(id);
    if (!record) return Promise.reject(new Error(`no ledger record ${id}`));
    this.ledger.set(id, { ...record, status: 'done', finishedAt });
    return Promise.resolve();
  }

  // FloorPort
  write(version: string): Promise<void> {
    this.calls.push(`floor ${version}`);
    this.floor = version;
    return Promise.resolve();
  }

  remove(): Promise<void> {
    this.calls.push('floor removed');
    this.floor = undefined;
    return Promise.resolve();
  }
}
