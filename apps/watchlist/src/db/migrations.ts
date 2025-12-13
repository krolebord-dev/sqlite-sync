import type { Migration } from 'kysely';

// Migration to create the list items schema
export const listItemsMigration: Migration = {
  async up(db) {
    // Create the base list_items table (CRDT-enabled with _ prefix)
    await db.schema
      .createTable('_list_items')
      .addColumn('id', 'text', (col) => col.primaryKey().notNull())
      .addColumn('type', 'text', (col) => col.notNull().defaultTo('movie'))
      .addColumn('tmdb_id', 'integer')
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('poster_url', 'text')
      .addColumn('overview', 'text')
      .addColumn('duration', 'integer')
      .addColumn('episode_count', 'integer')
      .addColumn('rating', 'integer')
      .addColumn('release_date', 'integer')
      .addColumn('watched_at', 'integer')
      .addColumn('priority', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('created_at', 'integer', (col) => col.notNull())
      .addColumn('tombstone', 'boolean', (col) => col.notNull().defaultTo(false))
      .execute();

    // Create the base tags table
    await db.schema
      .createTable('_list_tags')
      .addColumn('id', 'text', (col) => col.primaryKey().notNull())
      .addColumn('name', 'text', (col) => col.notNull())
      .addColumn('tombstone', 'boolean', (col) => col.notNull().defaultTo(false))
      .execute();

    // Create the base tags_to_items junction table
    await db.schema
      .createTable('_list_tags_to_items')
      .addColumn('tag_id', 'text', (col) => col.notNull())
      .addColumn('item_id', 'text', (col) => col.notNull())
      .addColumn('tombstone', 'boolean', (col) => col.notNull().defaultTo(false))
      .execute();

    // Create index for tags_to_items lookups
    await db.schema
      .createIndex('idx_tags_to_items_item_id')
      .on('_list_tags_to_items')
      .column('item_id')
      .execute();

    await db.schema
      .createIndex('idx_tags_to_items_tag_id')
      .on('_list_tags_to_items')
      .column('tag_id')
      .execute();
  },
};

