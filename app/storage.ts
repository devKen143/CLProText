'use client';
import { normalizeNotes, noteTimestamp, lastSyncedSnapshot, type SyncedSnapshot } from './merge-notebooks';
import { normalizeUsername, validUsername } from '../lib/sync-contract';

import {
  decodeBase64, decryptBytes, derive, encodeBase64, encryptBytes, salt, unseal, unlockDataKey, importDataKey, wrapDataKey, rewrapPassword, type Credential, type VaultAccess, type KeyEnvelope,
} from './crypto';

export const STORAGE_FORMAT_VERSION = 1;
export const DEFAULT_KDF_ITERATIONS = 600000;
const DB_PREFIX = 'clprotext-vault-';
const HEADER_KEY = 'header';
const enc = new TextEncoder();
const dec = new TextDecoder();

export type VaultHeader = {
  formatVersion: number; kdf: 'PBKDF2-SHA-256'; iterations: number; salt: string;
  createdAt: string; updatedAt: string; lastBackupAt: string | null; lastSyncedSnapshot?: { iv: string; data: string }; keys?: KeyEnvelope; keyCheck?: { iv: string; data: string }; legacyToken?: { iv: string; data: string }; recoveryPending?: boolean;
};
export type EncryptedRecord = { id: string; iv: string; data: string; compressed: boolean; updatedAt: string };
export type StoredNote = { id: string; title: string; text: string; payloadVersion?: 1 | 2 | 3 | 4 | 5; shares?: import('./crypto').NoteShare[]; pinned?: boolean; tags?: string[]; history?: import('./crypto').NoteVersion[]; purgedAt?: string; updatedAt?: string | number; deletedAt?: string; attachmentIds: string[] };
export type StoredAttachment = { id: string; name: string; type: string; size: number; data: Uint8Array };
export type VaultExport = { header: VaultHeader; notes: EncryptedRecord[]; attachments: EncryptedRecord[] };
export type DecryptedVaultExport = { notes: StoredNote[]; attachments: StoredAttachment[] };
type LegacyEnvelope = { payload: { format: number; iterations: number; salt: string; iv: string; data: string }; version?: number };
export function legacyLocalKey(username: string) {
  const prefix = 'clprotext:vault:';
  const matches = Object.keys(localStorage).filter(key => key.startsWith(prefix) && normalizeUsername(key.slice(prefix.length)) === normalizeUsername(username));
  if (matches.length > 1) throw new Error('Multiple legacy notebooks match this username. Export them before resolving the name collision.');
  return matches[0] || `${prefix}${normalizeUsername(username)}`;
}

function assertBrowser() {
  if (typeof window === 'undefined' || !window.indexedDB) throw new Error('IndexedDB is unavailable.');
}
function databaseName(username: string) {
  const value = normalizeUsername(username);
  if (!validUsername(value)) throw new Error('Invalid username.');
  return `${DB_PREFIX}${encodeBase64(enc.encode(value)).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c] || ''))}`;
}
function request<T>(r: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error || new Error('IndexedDB request failed.')); });
}
function tx(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, run: (t: IDBTransaction) => void) {
  return new Promise<void>((resolve, reject) => {
    const t = db.transaction(stores, mode); t.oncomplete = () => resolve(); t.onerror = () => reject(t.error || new Error('IndexedDB transaction failed.')); t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted.'));
    run(t);
  });
}
async function compress(value: Uint8Array): Promise<{ data: Uint8Array; compressed: boolean }> {
  if (typeof CompressionStream === 'undefined') return { data: value, compressed: false };
  const stream = new Blob([value as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return { data: new Uint8Array(await new Response(stream).arrayBuffer()), compressed: true };
}
async function decompress(value: Uint8Array, compressed: boolean) {
  if (!compressed) return value;
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decompress this vault record.');
  const stream = new Blob([value as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function sealRecord(value: Uint8Array, key: CryptoKey, id: string): Promise<EncryptedRecord> {
  const packed = await compress(value), encrypted = await encryptBytes(packed.data, key, `vault-record:${id}`);
  return { id, ...encrypted, compressed: packed.compressed, updatedAt: new Date().toISOString() };
}
async function openRecord(record: EncryptedRecord, key: CryptoKey) {
  return decompress(await decryptBytes(record, key, `vault-record:${record.id}`), record.compressed);
}
function now() { return new Date().toISOString(); }
export async function openDatabase(username: string): Promise<IDBDatabase> {
  assertBrowser();
  const name = await existingDatabaseName(username);
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, STORAGE_FORMAT_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('header')) db.createObjectStore('header');
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('attachments')) db.createObjectStore('attachments', { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error || new Error('Could not open vault.'));
  });
}
// Resolve legacy mixed-case names once per session, without renaming or deleting data.
const databaseAliases = new Map<string, Promise<string>>();
async function existingDatabaseName(username: string) {
  const canonical = databaseName(username);
  if (!databaseAliases.has(canonical)) databaseAliases.set(canonical, (async () => {
    if (!indexedDB.databases) return canonical;
    const matches = (await indexedDB.databases()).filter(entry => {
      if (!entry.name?.startsWith(DB_PREFIX)) return false;
      try { return databaseName(dec.decode(decodeBase64(entry.name.slice(DB_PREFIX.length).replace(/-/g,'+').replace(/_/g,'/')))) === canonical; } catch { return false; }
    });
    if (matches.length > 1) throw new Error('Multiple local notebooks match this username. Export them before resolving the name collision.');
    return matches[0]?.name || canonical;
  })());
  return databaseAliases.get(canonical)!;
}
export async function readHeader(username: string) {
  assertBrowser();
  const name = await existingDatabaseName(username);
  if (indexedDB.databases && !(await indexedDB.databases()).some(entry => entry.name === name)) return undefined;
  const db = await openDatabase(username);
  try { return await request<VaultHeader | undefined>(db.transaction('header').objectStore('header').get(HEADER_KEY)); } finally { db.close(); }
}
export async function createVault(username: string, password: string): Promise<VaultHeader> {
  const db = await openDatabase(username), old = await request<VaultHeader | undefined>(db.transaction('header').objectStore('header').get(HEADER_KEY));
  if (old) { db.close(); throw new Error('Vault already exists.'); }
  const timestamp = now(), header: VaultHeader = { formatVersion: STORAGE_FORMAT_VERSION, kdf: 'PBKDF2-SHA-256', iterations: DEFAULT_KDF_ITERATIONS, salt: salt(), createdAt: timestamp, updatedAt: timestamp, lastBackupAt: null };
  await tx(db, ['header'], 'readwrite', t => t.objectStore('header').put(header, HEADER_KEY)); db.close(); await derive(password, header.salt, header.iterations); return header;
}
export async function updateHeader(username: string, changes: Partial<Pick<VaultHeader, 'lastBackupAt'>>) {
  const db = await openDatabase(username), header = await request<VaultHeader>(db.transaction('header').objectStore('header').get(HEADER_KEY));
  if (!header) { db.close(); throw new Error('Vault does not exist.'); }
  const updated = { ...header, ...changes, updatedAt: now() }; await tx(db, ['header'], 'readwrite', t => t.objectStore('header').put(updated, HEADER_KEY)); db.close(); return updated;
}
export async function rotateVaultPassword(username: string, oldPassword: Credential, newPassword: string) {
  const { header } = await keyFor(username,oldPassword);
  if (!header.keys) throw new Error('Finish the recovery-key upgrade first.');
  const access = typeof oldPassword === 'string' ? await unlockDataKey(header.keys,oldPassword) : oldPassword;
  return commitKeyEnvelope(username,access,await rewrapPassword({...access,envelope:header.keys},newPassword));
}
export async function unlockVaultAccess(username: string, secret: string, recovery = false): Promise<Credential> {
  const header = await readHeader(username);
  if (!header) throw new Error('Vault does not exist.');
  if (!header.keys) { if (recovery) throw new Error('This notebook has not been upgraded for recovery keys yet.'); return secret; }
  const access = await unlockDataKey(header.keys,secret,recovery);
  if (!recovery) access.legacyPassword = secret;
  await keyFor(username,access);
  if (header.legacyToken) access.legacyWriteToken = dec.decode(await decryptBytes(header.legacyToken,access.key,'legacy-write-token'));
  return access;
}
export async function commitKeyEnvelope(username: string, access: VaultAccess, keys: KeyEnvelope, recoveryPending = false) {
  const {header} = await keyFor(username,access);
  const updated = {...header,keys,salt:keys.salt,iterations:keys.iterations,recoveryPending,updatedAt:now()};
  const db = await openDatabase(username);
  try { await tx(db,['header'],'readwrite',t => { const store=t.objectStore('header'), check=store.get(HEADER_KEY); check.onsuccess=()=>{ if(JSON.stringify(check.result)!==JSON.stringify(header)) { t.abort(); return; } store.put(updated,HEADER_KEY); }; }); } finally { db.close(); }
  access.envelope = keys;
  return updated;
}
export async function migrateVaultKey(username: string, password: Credential, legacyWriteToken?: string, existing?: VaultAccess, progress?: (done: number,total: number) => void) {
  const {key:oldKey,header} = await keyFor(username,password);
  if (header.keys) {
    const access = typeof password === 'string' ? await unlockDataKey(header.keys,password) : password;
    if (header.legacyToken) access.legacyWriteToken = dec.decode(await decryptBytes(header.legacyToken,access.key,'legacy-write-token'));
    if (!existing) return {access,recoveryKey:''};
    if (encodeBase64(access.rawKey) === encodeBase64(existing.rawKey)) {
      if (JSON.stringify(header.keys) !== JSON.stringify(existing.envelope)) await commitKeyEnvelope(username,access,existing.envelope,header.recoveryPending);
      return {access,recoveryKey:''};
    }
  }
  if (!existing && typeof password !== 'string') throw new Error('A legacy password is required for migration.');
  const db = await openDatabase(username);
  const records = await request<EncryptedRecord[]>(db.transaction('notes').objectStore('notes').getAll());
  const attachments = await request<Array<EncryptedRecord & {name:string;type:string;size:number}>>(db.transaction('attachments').objectStore('attachments').getAll());
  db.close();
  if (!records.length && !attachments.length && !header.lastSyncedSnapshot) throw new Error('Cannot authenticate an empty legacy vault.');
  const raw = existing?.rawKey || crypto.getRandomValues(new Uint8Array(32));
  const wrapped = existing ? {envelope:existing.envelope,recoveryKey:''} : await wrapDataKey(raw,password as string);
  const access: VaultAccess = existing || {key:await importDataKey(raw),rawKey:raw,envelope:wrapped.envelope,legacyWriteToken,legacyPassword:typeof password === 'string' ? password : undefined};
  const total = records.length + attachments.length; let done = 0;
  const migrate = async (record: EncryptedRecord) => { const next = {...record,...await sealRecord(await openRecord(record,oldKey),access.key,record.id)}; progress?.(++done,total); return next; };
  // All authentication/encryption finishes before opening the single write transaction.
  const nextNotes: EncryptedRecord[] = []; for (const record of records) nextNotes.push(await migrate(record));
  const nextAttachments: EncryptedRecord[] = []; for (const record of attachments) nextAttachments.push(await migrate(record));
  const next: VaultHeader = {...header,formatVersion:2,keys:wrapped.envelope,salt:wrapped.envelope.salt,recoveryPending:!!wrapped.recoveryKey,keyCheck:await encryptBytes(enc.encode('CLProText:data-key'),access.key,'key-check')};
  if (header.lastSyncedSnapshot) next.lastSyncedSnapshot = await encryptBytes(await decryptBytes(header.lastSyncedSnapshot,oldKey,'sync-snapshot'),access.key,'sync-snapshot');
  if (existing) delete next.legacyToken;
  if (legacyWriteToken) next.legacyToken = await encryptBytes(enc.encode(legacyWriteToken),access.key,'legacy-write-token');
  const nextDb = await openDatabase(username);
  try { await tx(nextDb,['header','notes','attachments'],'readwrite',t => {
    const check = t.objectStore('header').get(HEADER_KEY);
    check.onsuccess = () => {
      if (JSON.stringify(check.result) !== JSON.stringify(header)) { t.abort(); return; }
      t.objectStore('header').put(next,HEADER_KEY);
      nextNotes.forEach(record => t.objectStore('notes').put(record));
      nextAttachments.forEach(record => t.objectStore('attachments').put(record));
    };
  }); } finally { nextDb.close(); }
  return {access,recoveryKey:wrapped.recoveryKey};
}
export async function removeVault(username: string) {
  assertBrowser(); return new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase(databaseName(username)); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); });
}
async function keyFor(username: string, password: Credential) {
  const header = await readHeader(username); if (!header) throw new Error('Vault does not exist.');
  if (header.keys) {
    const access = typeof password === 'string' ? await unlockDataKey(header.keys,password) : password;
    if (!header.keyCheck || dec.decode(await decryptBytes(header.keyCheck,access.key,'key-check')) !== 'CLProText:data-key') throw new Error('Incorrect notebook key.');
    return {key:access.key,header};
  }
  if (typeof password !== 'string') throw new Error('Legacy notebook requires its password.');
  return { key: await derive(password, header.salt, header.iterations), header };
}
function normalizeStoredNote(note: StoredNote, updatedAt: string): StoredNote {
  if (note.payloadVersion !== undefined && note.payloadVersion !== 1 && note.payloadVersion !== 2 && note.payloadVersion !== 3 && note.payloadVersion !== 4 && note.payloadVersion !== 5) throw new Error('Unsupported note format.');
  return { ...note, payloadVersion: 5, updatedAt: noteTimestamp(note.updatedAt, updatedAt), ...(note.deletedAt ? { deletedAt: noteTimestamp(note.deletedAt) } : {}) };
}
export async function readSyncedSnapshot(username: string, password: Credential): Promise<SyncedSnapshot> {
  const { key, header } = await keyFor(username, password);
  if (!header.lastSyncedSnapshot) return {};
  const value = JSON.parse(dec.decode(await decryptBytes(header.lastSyncedSnapshot, key, 'sync-snapshot')));
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(time => typeof time !== 'string' || !Number.isFinite(Date.parse(time)))) throw new Error('Invalid sync snapshot.');
  return value;
}
export async function markSynced(username: string, password: Credential, notes: import('./crypto').Note[]) {
  const { key } = await keyFor(username, password);
  const snapshot = await encryptBytes(enc.encode(JSON.stringify(lastSyncedSnapshot(notes))), key, 'sync-snapshot');
  const db = await openDatabase(username);
  try { await tx(db, ['header'], 'readwrite', t => {
    const store = t.objectStore('header'), request = store.get(HEADER_KEY);
    request.onsuccess = () => store.put({ ...request.result, lastSyncedSnapshot: snapshot }, HEADER_KEY);
  }); } finally { db.close(); }
}
export async function createNote(username: string, password: Credential, note: Omit<StoredNote, 'attachmentIds'> & { attachmentIds?: string[] }) {
  const { key, header } = await keyFor(username, password), id = note.id || crypto.randomUUID(), record = await sealRecord(enc.encode(JSON.stringify({ ...note, id, payloadVersion: 5, updatedAt: noteTimestamp(note.updatedAt, header.updatedAt), attachmentIds: note.attachmentIds || [] })), key, id), db = await openDatabase(username);
  await tx(db, ['notes'], 'readwrite', t => t.objectStore('notes').put(record)); db.close(); return id;
}
export async function updateNote(username: string, password: Credential, note: StoredNote) { return createNote(username, password, note); }
export async function readNote(username: string, password: Credential, id: string): Promise<StoredNote | null> {
  const { key } = await keyFor(username, password), db = await openDatabase(username), record = await request<EncryptedRecord | undefined>(db.transaction('notes').objectStore('notes').get(id)); db.close();
  const header = await readHeader(username);
  return record ? normalizeStoredNote(JSON.parse(dec.decode(await openRecord(record, key))), header!.updatedAt) : null;
}
export async function listNotes(username: string, password: Credential) {
  const { key } = await keyFor(username, password), db = await openDatabase(username), records = await request<EncryptedRecord[]>(db.transaction('notes').objectStore('notes').getAll()); db.close();
  const header = await readHeader(username);
  return Promise.all(records.map(async record => normalizeStoredNote(JSON.parse(dec.decode(await openRecord(record, key))), header!.updatedAt)));
}
export async function removeNote(username: string, password: Credential, id: string) {
  await keyFor(username, password); const db = await openDatabase(username); await tx(db, ['notes'], 'readwrite', t => t.objectStore('notes').delete(id)); db.close();
}
export async function removeNotes(username: string, password: Credential, ids?: string[]) {
  await keyFor(username, password); const db = await openDatabase(username);
  await tx(db, ['notes'], 'readwrite', t => {
    const store = t.objectStore('notes');
    if (ids) ids.forEach(id => store.delete(id)); else store.clear();
  });
  db.close();
}
export async function createAttachment(username: string, password: Credential, attachment: Omit<StoredAttachment, 'id'> & { id?: string }) {
  const { key } = await keyFor(username, password), id = attachment.id || crypto.randomUUID(), record = await sealRecord(attachment.data, key, id), db = await openDatabase(username);
  const value = { ...record, name: attachment.name, type: attachment.type, size: attachment.size };
  await tx(db, ['attachments'], 'readwrite', t => t.objectStore('attachments').put(value)); db.close(); return id;
}
export async function readAttachment(username: string, password: Credential, id: string): Promise<StoredAttachment | null> {
  const { key } = await keyFor(username, password), db = await openDatabase(username), record = await request<(EncryptedRecord & Omit<StoredAttachment, 'data'>) | undefined>(db.transaction('attachments').objectStore('attachments').get(id)); db.close();
  return record ? { id, name: record.name, type: record.type, size: record.size, data: await openRecord(record, key) } : null;
}
export async function listAttachments(username: string, password: Credential) {
  const { key } = await keyFor(username, password), db = await openDatabase(username);
  const records = await request<Array<EncryptedRecord & { name: string; type: string; size: number }>>(db.transaction('attachments').objectStore('attachments').getAll());
  db.close();
  return Promise.all(records.map(async record => ({ id: record.id, name: record.name, type: record.type, size: record.size, data: await openRecord(record, key) })));
}
export async function removeAttachment(username: string, password: Credential, id: string) { await keyFor(username, password); const db = await openDatabase(username); await tx(db, ['attachments'], 'readwrite', t => t.objectStore('attachments').delete(id)); db.close(); }
export async function exportVault(username: string, password: Credential): Promise<VaultExport> {
  const { header } = await keyFor(username, password), db = await openDatabase(username);
  const notes = await request<EncryptedRecord[]>(db.transaction('notes').objectStore('notes').getAll());
  const attachments = await request<EncryptedRecord[]>(db.transaction('attachments').objectStore('attachments').getAll()); db.close();
  return { header, notes, attachments };
}
export async function previewVaultExport(data: VaultExport, backupPassword: string): Promise<DecryptedVaultExport> {
  const key = data.header.keys ? (await unlockDataKey(data.header.keys,backupPassword)).key : await derive(backupPassword, data.header.salt, data.header.iterations);
  const notes = await Promise.all(data.notes.map(async record => normalizeStoredNote(JSON.parse(dec.decode(await openRecord(record, key))), data.header.updatedAt)));
  const attachments = await Promise.all(data.attachments.map(async record => {
    const metadata = record as EncryptedRecord & { name: string; type: string; size: number };
    return { id: metadata.id, name: metadata.name, type: metadata.type, size: metadata.size, data: await openRecord(record, key) };
  }));
  return { notes, attachments };
}
export async function mergeVaultExport(username: string, currentPassword: Credential, data: VaultExport, backupPassword: string, replace = false) {
  const imported = await previewVaultExport(data, backupPassword);
  const { key } = await keyFor(username, currentPassword);
  const db = await openDatabase(username);
  const existingAttachments = await request<Array<EncryptedRecord & { name: string; type: string; size: number }>>(db.transaction('attachments').objectStore('attachments').getAll());
  db.close();
  const attachmentIds = new Set(imported.attachments.map(a => a.id));
  const noteIds = new Set(imported.notes.map(n => n.id));
  const nextAttachments = await Promise.all(imported.attachments.map(async attachment => ({ ...await sealRecord(attachment.data, key, attachment.id), name: attachment.name, type: attachment.type, size: attachment.size })));
  const nextNotes = await Promise.all(imported.notes.map(note => sealRecord(enc.encode(JSON.stringify(note)), key, note.id)));
  const nextDb = await openDatabase(username);
  await tx(nextDb, ['notes', 'attachments'], 'readwrite', t => {
    const noteStore = t.objectStore('notes'), attachmentStore = t.objectStore('attachments');
    if (replace) { noteStore.clear(); attachmentStore.clear(); }
    else {
      existingAttachments.filter(a => attachmentIds.has(a.id)).forEach(a => attachmentStore.delete(a.id));
      imported.notes.forEach(note => { if (noteIds.has(note.id)) noteStore.delete(note.id); });
    }
    nextNotes.forEach(record => noteStore.put(record));
    nextAttachments.forEach(record => attachmentStore.put(record));
  });
  nextDb.close();
  return { notes: imported.notes.length, attachments: imported.attachments.length };
}
export async function importVault(username: string, data: VaultExport, password: Credential) {
  const header = await readHeader(username); if (header) throw new Error('Vault already exists.');
  const verifiedKey = typeof password !== 'string' ? password.key : data.header.keys ? (await unlockDataKey(data.header.keys,password)).key : await derive(password,data.header.salt,data.header.iterations);
  for (const record of [...data.notes,...data.attachments]) await openRecord(record,verifiedKey);
  if (data.header.keyCheck) await decryptBytes(data.header.keyCheck,verifiedKey,'key-check');
  if (!data.notes.length && !data.header.keyCheck) throw new Error('Cannot authenticate an empty legacy backup.');
  const db = await openDatabase(username); await tx(db, ['header', 'notes', 'attachments'], 'readwrite', t => {
    t.objectStore('header').put(data.header, HEADER_KEY); data.notes.forEach(n => t.objectStore('notes').put(n)); data.attachments.forEach(a => t.objectStore('attachments').put(a));
  }); db.close(); await keyFor(username, password); return data.header;
}
export async function migrateLegacyLocalStorage(username: string, password: string) {
  assertBrowser(); const raw = localStorage.getItem(legacyLocalKey(username)); if (!raw || await readHeader(username)) return false;
  const legacy = JSON.parse(raw) as LegacyEnvelope, notes = await unseal(legacy.payload, await derive(password, legacy.payload.salt, legacy.payload.iterations));
  const header = await createVault(username, password), key = await derive(password, header.salt, header.iterations);
  const noteRecords: EncryptedRecord[] = [], attachmentRecords: Array<EncryptedRecord & { name: string; type: string; size: number }> = [];
  for (const note of normalizeNotes(notes, header.updatedAt)) {
    const attachmentIds: string[] = [];
    for (const attachment of note.attachments || []) {
      attachmentIds.push(attachment.id);
      const comma = attachment.dataUrl.indexOf(',');
      if (comma < 0) throw new Error('Invalid legacy attachment.');
      const meta = attachment.dataUrl.slice(0, comma), encoded = attachment.dataUrl.slice(comma + 1);
      const type = meta.slice(5, meta.indexOf(';')) || attachment.type;
      const record = await sealRecord(decodeBase64(encoded), key, attachment.id);
      attachmentRecords.push({ ...record, name: attachment.name, type, size: attachment.size });
    }
    noteRecords.push(await sealRecord(enc.encode(JSON.stringify({ id: note.id, title: note.title, text: note.text, payloadVersion: 5, updatedAt: noteTimestamp(note.updatedAt, header.updatedAt), deletedAt: note.deletedAt, history: note.history, purgedAt: note.purgedAt, pinned: note.pinned, tags: note.tags, shares: note.shares, attachmentIds })), key, note.id));
  }
  const db = await openDatabase(username);
  await tx(db, ['notes', 'attachments'], 'readwrite', t => {
    noteRecords.forEach(record => t.objectStore('notes').put(record));
    attachmentRecords.forEach(record => t.objectStore('attachments').put(record));
  });
  db.close();
  // Migration is deliberately non-destructive: the legacy key remains available for rollback.
  return true;
}

// Save the entire working copy atomically. In particular, deleted notes must not
// survive in IndexedDB and reappear on the next unlock or cloud snapshot.
export async function replaceNotebook(username: string, password: Credential, notes: import('./crypto').Note[], initialHeader?: VaultHeader) {
  const {key,header} = initialHeader ? {key:typeof password !== 'string' ? password.key : initialHeader.keys ? (await unlockDataKey(initialHeader.keys,password)).key : await derive(password,initialHeader.salt,initialHeader.iterations),header:initialHeader} : await keyFor(username,password);
  const noteRecords: EncryptedRecord[] = [], attachmentRecords: Array<EncryptedRecord & {name:string;type:string;size:number}> = [];
  for (const note of normalizeNotes(notes, header.updatedAt)) {
    const attachmentIds: string[] = [];
    for(const attachment of note.attachments || []) {
      const comma=attachment.dataUrl.indexOf(',');
      if(comma<0) throw new Error('Invalid attachment.');
      const data=decodeBase64(attachment.dataUrl.slice(comma+1));
      if(data.length>5*1024*1024) throw new Error('Attachments must be 5 MB or smaller.');
      attachmentRecords.push({...await sealRecord(data,key,attachment.id),name:attachment.name,type:attachment.type,size:attachment.size});
      attachmentIds.push(attachment.id);
    }
    noteRecords.push(await sealRecord(enc.encode(JSON.stringify({id:note.id,title:note.title,text:note.text,payloadVersion:5,updatedAt:noteTimestamp(note.updatedAt,header.updatedAt),deletedAt:note.deletedAt,history:note.history,purgedAt:note.purgedAt,pinned:note.pinned,tags:note.tags,shares:note.shares,attachmentIds})),key,note.id));
  }
  const db=await openDatabase(username);
  try { await tx(db,['header','notes','attachments'],'readwrite',t=> {
    t.objectStore('notes').clear(); t.objectStore('attachments').clear();
    noteRecords.forEach(record=>t.objectStore('notes').put(record));
    attachmentRecords.forEach(record=>t.objectStore('attachments').put(record));
    if (initialHeader) t.objectStore('header').add(header,HEADER_KEY);
    else t.objectStore('header').put({...header,updatedAt:now()},HEADER_KEY);
  }); } finally { db.close(); }
}
// Caller must authenticate the cloud envelope before calling this function.
export async function installCloudNotebook(username: string, password: Credential, notes: import('./crypto').Note[], envelope: {salt:string;iterations:number;keys?:KeyEnvelope}) {
  const timestamp = now();
  const header: VaultHeader = {formatVersion:1,kdf:'PBKDF2-SHA-256',salt:envelope.salt,iterations:envelope.iterations,createdAt:timestamp,updatedAt:timestamp,lastBackupAt:null};
  if (envelope.keys) { const access = typeof password === 'string' ? await unlockDataKey(envelope.keys,password) : password; header.formatVersion=2; header.keys=envelope.keys; header.keyCheck=await encryptBytes(enc.encode('CLProText:data-key'),access.key,'key-check'); }
  await replaceNotebook(username,password,notes,header);
  await markSynced(username,password,notes);
  return header;
}
