import type { Migration } from './types.ts';

// Step 3 of the rename of the attribute "name" to "title": CONTRACT.
// This migration removes "name". It is destructive: the code from before the EXPAND release (0002-add-title) can not read
// the data after it. The runner runs it only after the canary has finished, and it records the rollback floor first.
//
// The migration refuses to run when an item has no title. Then the EXPAND step did not finish for that item, and removing
// the name would lose the only copy of the text. The error names the items, and nothing is removed.
export const dropName: Migration = {
  id: '0003-drop-name',
  phase: 'contract',
  contracts: '0002-add-title',
  description: 'Remove the attribute name from each item. The attribute title holds the same text.',
  // Safe to repeat: removing an attribute that is gone does nothing.
  async up(data) {
    const items = await data.listItems();
    const withoutTitle = items.filter((item) => typeof item.title !== 'string').map((item) => item.id);
    if (withoutTitle.length > 0) {
      throw new Error(
        `The items ${withoutTitle.join(', ')} have no title. Removing the name would lose their text. Nothing was removed.`,
      );
    }
    for (const item of items) {
      if ('name' in item) await data.removeAttribute(item.id, 'name');
    }
  },
};
