import type { Migration } from './types.ts';

// The three starting items. They were constant data in the handler before the service had a table.
// The shape of the data at this point: every item has the attribute "name".
export const SEED_ITEMS = [
  { id: 'item-1', name: 'First item' },
  { id: 'item-2', name: 'Second item' },
  { id: 'item-3', name: 'Third item' },
] as const;

export const seedItems: Migration = {
  id: '0001-seed-items',
  phase: 'expand',
  description: 'Create the three starting items, if they do not exist.',
  // Safe to repeat: an item that exists is not touched. A person's change to an item stays.
  async up(data) {
    for (const item of SEED_ITEMS) await data.putItemIfAbsent({ ...item });
  },
};
