'use client';
import { normalizeUsername, validUsername } from '../lib/sync-contract';

import {
  decodeBase64, decryptBytes, derive, encodeBase64, encryptBytes, salt, unseal,
} from './crypto';

export const STORAGE_FORMAT_VERSION = 1;
export const DEFAULT_KDF_ITERATIONS = 600000;
const DB_PREFIX = 'clprotext-vault-';
const HEADER_KEY = 'header';
const enc = new TextEncoder();
const dec = new TextDecoder();

export type VaultHeader = {
  formatVersion: number; kdf: 'PBKDF2-SHA-256'; iterations: number; salt: string;
  createdAt: string; updatedAt: string; lastBackupAt: string | null;
};
export type EncryptedRecord = { id: string; iv: string; data: string; compressed: boolean; updatedAt: string };
export type StoredNote = { id: string; title: string; text: string; attachmentIds: string[] };
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
export async function rotateVaultPassword(username: string, oldPassword: string, newPassword: string) {
  const { key: oldKey, header } = await keyFor(username, oldPassword);
  const db = await openDatabase(username);
  const notes = await request<EncryptedRecord[]>(db.transaction('notes').objectStore('notes').getAll());
  const attachments = await request<Array<EncryptedRecord & { name: string; type: string; size: number }>>(db.transaction('attachments').objectStore('attachments').getAll());
  db.close();
  const nextHeader: VaultHeader = { ...header, salt: salt(), updatedAt: now() };
  const newKey = await derive(newPassword, nextHeader.salt, nextHeader.iterations);
  const nextNotes = await Promise.all(notes.map(async record => sealRecord(await openRecord(record, oldKey), newKey, record.id)));
  const nextAttachments = await Promise.all(attachments.map(async record => ({ ...await sealRecord(await openRecord(record, oldKey), newKey, record.id), name: record.name, type: record.type, size: record.size })));
  const nextDb = await openDatabase(username);
  await tx(nextDb, ['header', 'notes', 'attachments'], 'readwrite', t => {
    t.objectStore('header').put(nextHeader, HEADER_KEY);
    nextNotes.forEach(record => t.objectStore('notes').put(record));
    nextAttachments.forEach(record => t.objectStore('attachments').put(record));
  });
  nextDb.close();
  return nextHeader;
}
export async function removeVault(username: string) {
  assertBrowser(); return new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase(databaseName(username)); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); });
}
async function keyFor(username: string, password: string) {
  const header = await readHeader(username); if (!header) throw new Error('Vault does not exist.');
  return { key: await derive(password, header.salt, header.iterations), header };
}
export async function createNote(username: string, password: string, note: Omit<StoredNote, 'attachmentIds'> & { attachmentIds?: string[] }) {
  const { key } = await keyFor(username, password), id = note.id || crypto.randomUUID(), record = await sealRecord(enc.encode(JSON.stringify({ ...note, id, attachmentIds: note.attachmentIds || [] })), key, id), db = await openDatabase(username);
  await tx(db, ['notes'], 'readwrite', t => t.objectStore('notes').put(record)); db.close(); return id;
}
export async function updateNote(username: string, password: string, note: StoredNote) { return createNote(username, password, note); }
export async function readNote(username: string, password: string, id: string): Promise<StoredNote | null> {
  const { key } = await keyFor(username, password), db = await openDatabase(username), record = await request<EncryptedRecord | undefined>(db.transaction('notes').objectStore('notes').get(id)); db.close();
  return record ? JSON.parse(dec.decode(await openRecord(record, key))) as StoredNote : null;
}
export async function listNotes(username: string, password: string) {
  const { key } = await keyFor(username, password), db = await openDatabase(username), records = await request<EncryptedRecord[]>(db.transaction('notes').objectStore('notes').getAll()); db.close();
  return Promise.all(records.map(async record => JSON.parse(dec.decode(await openRecord(record, key))) as StoredNote));
}
export async function removeNote(username: string, password: string, id: string) {
  await keyFor(username, password); const db = await openDatabase(username); await tx(db, ['notes'], 'readwrite', t => t.objectStore('notes').delete(id)); db.close();
}
export async function removeNotes(username: string, password: string, ids?: string[]) {
  await keyFor(username, password); const db = await openDatabase(username);
  await tx(db, ['notes'], 'readwrite', t => {
    const store = t.objectStore('notes');
    if (ids) ids.forEach(id => store.delete(id)); else store.clear();
  });
  db.close();
}
export async function createAttachment(username: string, password: string, attachment: Omit<StoredAttachment, 'id'> & { id?: string }) {
  const { key } = await keyFor(username, password), id = attachment.id || crypto.randomUUID(), record = await sealRecord(attachment.data, key, id), db = await openDatabase(username);
  const value = { ...record, name: attachment.name, type: attachment.type, size: attachment.size };
  await tx(db, ['attachments'], 'readwrite', t => t.objectStore('attachments').put(value)); db.close(); return id;
}
export async function readAttachment(username: string, password: string, id: string): Promise<StoredAttachment | null> {
  const { key } = await keyFor(username, password), db = await openDatabase(username), record = await request<(EncryptedRecord & Omit<StoredAttachment, 'data'>) | undefined>(db.transaction('attachments').objectStore('attachments').get(id)); db.close();
  return record ? { id, name: record.name, type: record.type, size: record.size, data: await openRecord(record, key) } : null;
}
export async function listAttachments(username: string, password: string) {
  const { key } = await keyFor(username, password), db = await openDatabase(username);
  const records = await request<Array<EncryptedRecord & { name: string; type: string; size: number }>>(db.transaction('attachments').objectStore('attachments').getAll());
  db.close();
  return Promise.all(records.map(async record => ({ id: record.id, name: record.name, type: record.type, size: record.size, data: await openRecord(record, key) })));
}
export async function removeAttachment(username: string, password: string, id: string) { await keyFor(username, password); const db = await openDatabase(username); await tx(db, ['attachments'], 'readwrite', t => t.objectStore('attachments').delete(id)); db.close(); }
export async function exportVault(username: string, password: string): Promise<VaultExport> {
  const { header } = await keyFor(username, password), db = await openDatabase(username);
  const notes = await request<EncryptedRecord[]>(db.transaction('notes').objectStore('notes').getAll());
  const attachments = await request<EncryptedRecord[]>(db.transaction('attachments').objectStore('attachments').getAll()); db.close();
  return { header, notes, attachments };
}
export async function previewVaultExport(data: VaultExport, backupPassword: string): Promise<DecryptedVaultExport> {
  const key = await derive(backupPassword, data.header.salt, data.header.iterations);
  const notes = await Promise.all(data.notes.map(async record => JSON.parse(dec.decode(await openRecord(record, key))) as StoredNote));
  const attachments = await Promise.all(data.attachments.map(async record => {
    const metadata = record as EncryptedRecord & { name: string; type: string; size: number };
    return { id: metadata.id, name: metadata.name, type: metadata.type, size: metadata.size, data: await openRecord(record, key) };
  }));
  return { notes, attachments };
}
export async function mergeVaultExport(username: string, currentPassword: string, data: VaultExport, backupPassword: string, replace = false) {
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
export async function importVault(username: string, data: VaultExport, password: string) {
  const header = await readHeader(username); if (header) throw new Error('Vault already exists.');
  const db = await openDatabase(username); await tx(db, ['header', 'notes', 'attachments'], 'readwrite', t => {
    t.objectStore('header').put(data.header, HEADER_KEY); data.notes.forEach(n => t.objectStore('notes').put(n)); data.attachments.forEach(a => t.objectStore('attachments').put(a));
  }); db.close(); await keyFor(username, password); return data.header;
}
export async function migrateLegacyLocalStorage(username: string, password: string) {
  assertBrowser(); const raw = localStorage.getItem(legacyLocalKey(username)); if (!raw || await readHeader(username)) return false;
  const legacy = JSON.parse(raw) as LegacyEnvelope, notes = await unseal(legacy.payload, await derive(password, legacy.payload.salt, legacy.payload.iterations));
  const header = await createVault(username, password), key = await derive(password, header.salt, header.iterations);
  const noteRecords: EncryptedRecord[] = [], attachmentRecords: Array<EncryptedRecord & { name: string; type: string; size: number }> = [];
  for (const note of notes) {
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
    noteRecords.push(await sealRecord(enc.encode(JSON.stringify({ id: note.id, title: note.title, text: note.text, attachmentIds })), key, note.id));
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
export async function replaceNotebook(username: string, password: string, notes: import('./crypto').Note[], initialHeader?: VaultHeader) {
  const {key,header} = initialHeader ? {key:await derive(password,initialHeader.salt,initialHeader.iterations),header:initialHeader} : await keyFor(username,password);
  const noteRecords: EncryptedRecord[] = [], attachmentRecords: Array<EncryptedRecord & {name:string;type:string;size:number}> = [];
  for (const note of notes) {
    const attachmentIds: string[] = [];
    for(const attachment of note.attachments || []) {
      const comma=attachment.dataUrl.indexOf(',');
      if(comma<0) throw new Error('Invalid attachment.');
      const data=decodeBase64(attachment.dataUrl.slice(comma+1));
      if(data.length>5*1024*1024) throw new Error('Attachments must be 5 MB or smaller.');
      attachmentRecords.push({...await sealRecord(data,key,attachment.id),name:attachment.name,type:attachment.type,size:attachment.size});
      attachmentIds.push(attachment.id);
    }
    noteRecords.push(await sealRecord(enc.encode(JSON.stringify({id:note.id,title:note.title,text:note.text,attachmentIds})),key,note.id));
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
export async function installCloudNotebook(username: string, password: string, notes: import('./crypto').Note[], envelope: {salt:string;iterations:number}) {
  const timestamp = now();
  const header: VaultHeader = {formatVersion:1,kdf:'PBKDF2-SHA-256',salt:envelope.salt,iterations:envelope.iterations,createdAt:timestamp,updatedAt:timestamp,lastBackupAt:null};
  await replaceNotebook(username,password,notes,header);
  return header;
}
