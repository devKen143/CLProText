import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
export const legacyVaults = sqliteTable('legacy_vaults', { owner: text('owner').primaryKey(), payload: text('payload').notNull(), version: integer('version').notNull() });
export const vaults = sqliteTable('vaults', {
 username: text('username').primaryKey(), writeTokenHash: text('write_token_hash').notNull(),
 version: integer('version').notNull(), blobKey: text('blob_key').notNull(), sizeBytes: integer('size_bytes').notNull(),
 createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
}, table => [uniqueIndex('vaults_canonical_username').on(sql`lower(trim(${table.username}))`)]);
