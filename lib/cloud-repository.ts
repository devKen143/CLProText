import { drizzle } from 'drizzle-orm/d1';
import { and, eq } from 'drizzle-orm';
import { vaults } from '../db/schema';
import type { VaultRepository, VaultRow } from './vault-api';
export function cloudRepository(binding: D1Database): VaultRepository {
 const db = drizzle(binding);
 const predicate = (previous: VaultRow) => and(eq(vaults.username,previous.username),eq(vaults.version,previous.version),eq(vaults.blobKey,previous.blobKey),eq(vaults.writeTokenHash,previous.writeTokenHash));
 return {
  get: username => db.select().from(vaults).where(eq(vaults.username,username)).get(),
  create: async row => !!await db.insert(vaults).values(row).onConflictDoNothing().returning().get(),
  update: async (previous,next) => !!await db.update(vaults).set(next).where(predicate(previous)).returning().get(),
  remove: async previous => !!await db.delete(vaults).where(predicate(previous)).returning().get(),
 };
}
