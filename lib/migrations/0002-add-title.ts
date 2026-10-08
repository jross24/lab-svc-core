import type { Migration } from './types.ts';

// Step 1 of the rename of the attribute "name" to "title": EXPAND.
// This migration adds "title" next to "name". It removes nothing. So the previous version, which reads "name", still works,
// and a rollback to it is safe. The step that removes "name" is a later release (0003-drop-name), after the consumers read "title".
export const addTitle: Migration = {
  id: '0002-add-title',
  phase: 'expand',
  description: 'Give each item the attribute title, with the value of its name.',
  // Safe to repeat: the attribute is set only when the item does not have it yet.
  async up(data) {
    for (const item of await data.listItems()) {
      if (typeof item.name === 'string') await data.setAttributeIfAbsent(item.id, 'title', item.name);
    }
  },
};
