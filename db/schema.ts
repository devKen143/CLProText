import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const vaults = sqliteTable('vaults', { owner: text('owner').primaryKey(), payload: text('payload').notNull(), version: integer('version').notNull() });
