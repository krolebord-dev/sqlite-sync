import { relations, sql } from 'drizzle-orm';
import { integer, primaryKey, sqliteTable, uniqueIndex } from 'drizzle-orm/sqlite-core';

const now = sql`(current_timestamp)`;

const createdAt = () => integer({ mode: 'timestamp_ms' }).notNull().default(now);
const updatedAt = () =>
  integer({ mode: 'timestamp_ms' })
    .notNull()
    .default(now)
    .$onUpdate(() => new Date());

export const usersTable = sqliteTable('users', (x) => ({
  id: x.text().primaryKey(),
  name: x.text().notNull(),
  email: x.text().notNull(),

  createdAt: createdAt(),
  updatedAt: updatedAt(),
}));
export const usersRelations = relations(usersTable, ({ many }) => ({
  sessions: many(sessionsTable),
  usersToLists: many(usersToListsTable),
}));

export const sessionsTable = sqliteTable('sessions', (x) => ({
  id: x.text('id').primaryKey(),
  userId: x
    .text('user_id')
    .notNull()
    .references(() => usersTable.id, { onDelete: 'cascade' }),
  validUntil: x.integer({ mode: 'timestamp' }).notNull(),
  createdAt: createdAt(),
}));
export const sessionsRelations = relations(sessionsTable, ({ one }) => ({
  user: one(usersTable, {
    fields: [sessionsTable.userId],
    references: [usersTable.id],
  }),
}));

export const verificationsTable = sqliteTable('verifications', (x) => ({
  id: x.text('id').primaryKey(),

  targetType: x.text({ enum: ['email'] }).notNull(),
  target: x.text().notNull(),
  token: x.text().notNull().unique(),

  createdAt: createdAt(),
  expiredAt: x.integer({ mode: 'timestamp' }).notNull(),
  usedAt: x.integer({ mode: 'timestamp' }),
  isValid: x.integer({ mode: 'boolean' }).notNull().default(true),

  listId: x.text('list_id').references(() => listsTable.id, { onDelete: 'cascade' }),
}));

export const verificationsRelations = relations(verificationsTable, ({ one }) => ({
  list: one(listsTable, {
    fields: [verificationsTable.listId],
    references: [listsTable.id],
  }),
}));

export const listsTable = sqliteTable('lists', (x) => ({
  id: x.text('id').primaryKey(),
  name: x.text().notNull(),
  createdAt: createdAt(),
}));
export const listsRelations = relations(listsTable, ({ many }) => ({
  usersToLists: many(usersToListsTable),
}));

export const usersToListsTable = sqliteTable(
  'users_to_lists',
  (x) => ({
    userId: x
      .text('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    listId: x
      .text('list_id')
      .notNull()
      .references(() => listsTable.id, { onDelete: 'cascade' }),
  }),
  (f) => [primaryKey({ columns: [f.userId, f.listId] })],
);
export const usersToListsRelations = relations(usersToListsTable, ({ one }) => ({
  user: one(usersTable, {
    fields: [usersToListsTable.userId],
    references: [usersTable.id],
  }),
  list: one(listsTable, {
    fields: [usersToListsTable.listId],
    references: [listsTable.id],
  }),
}));

export const listItemsTable = sqliteTable('list_items', (x) => ({
  id: x.text().primaryKey(),
  type: x
    .text({ enum: ['movie', 'tv'] })
    .notNull()
    .default('movie'),
  tmdbId: x.integer(),

  listId: x
    .text('list_id')
    .notNull()
    .references(() => listsTable.id, { onDelete: 'cascade' }),
  order: x.integer().notNull().default(0),
  priority: x.integer().notNull().default(0),

  title: x.text().notNull(),
  posterUrl: x.text(),
  rating: x.integer(),
  overview: x.text(),
  releaseDate: x.integer({ mode: 'timestamp' }),
  duration: x.integer(),
  episodeCount: x.integer(),

  watchedAt: x.integer({ mode: 'timestamp' }),

  createdAt: createdAt(),
  updatedAt: updatedAt(),
}));

export const listItemsRelations = relations(listItemsTable, ({ many }) => ({
  tags: many(listTagsToItemsTable),
}));

export const listTagsTable = sqliteTable(
  'list_tags',
  (x) => ({
    id: x.text().primaryKey(),
    name: x.text().notNull(),
    listId: x
      .text('list_id')
      .notNull()
      .references(() => listsTable.id, { onDelete: 'cascade' }),
  }),
  (f) => [uniqueIndex('unique_list_tag').on(f.listId, f.name)],
);

export const listTagsRelations = relations(listTagsTable, ({ one, many }) => ({
  list: one(listsTable, {
    fields: [listTagsTable.listId],
    references: [listsTable.id],
  }),
  items: many(listTagsToItemsTable),
}));

export const listTagsToItemsTable = sqliteTable(
  'list_tags_to_items',
  (x) => ({
    listTagId: x
      .text('list_tag_id')
      .notNull()
      .references(() => listTagsTable.id, { onDelete: 'cascade' }),
    listItemId: x
      .text('list_item_id')
      .notNull()
      .references(() => listItemsTable.id, { onDelete: 'cascade' }),
  }),
  (f) => [primaryKey({ columns: [f.listTagId, f.listItemId] })],
);

export const listTagsToItemsRelations = relations(listTagsToItemsTable, ({ one }) => ({
  listTag: one(listTagsTable, {
    fields: [listTagsToItemsTable.listTagId],
    references: [listTagsTable.id],
  }),
  listItem: one(listItemsTable, {
    fields: [listTagsToItemsTable.listItemId],
    references: [listItemsTable.id],
  }),
}));
