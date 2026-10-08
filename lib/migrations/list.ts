import { seedItems } from './0001-seed-items.ts';
import { addTitle } from './0002-add-title.ts';
import type { Migration } from './types.ts';

// All the migrations of this release, in the order of their ids. Add a new migration at the end.
// Never edit or remove a migration that a release has run: the ledger of an environment may already hold it.
export const MIGRATIONS: readonly Migration[] = [seedItems, addTitle];
