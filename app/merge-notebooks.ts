import type { Note } from './crypto';

export type SyncedSnapshot = Record<string, string>;
const epoch = '1970-01-01T00:00:00.000Z';
export function noteTimestamp(value: string | number | undefined, fallback: string | number = epoch): string {
 const input = value === undefined || value === 0 ? fallback : value;
 if (typeof input !== 'string' && typeof input !== 'number') throw new Error('Invalid note timestamp.');
 const date = new Date(input);
 if (!Number.isFinite(date.getTime())) throw new Error('Invalid note timestamp.');
 return date.toISOString();
}
export function normalizeNotes(notes: Note[], notebookUpdatedAt: string | number = epoch): Note[] {
 if (!Array.isArray(notes) || notes.length > 10000) throw new Error('Invalid notebook.');
 const ids = new Set<string>(), attachments = new Map<string, string>();
 return notes.map(note => {
  if (!note || typeof note.id !== 'string' || !note.id || ids.has(note.id) || typeof note.title !== 'string' || typeof note.text !== 'string') throw new Error('Invalid note.');
  if (note.payloadVersion !== undefined && note.payloadVersion !== 1 && note.payloadVersion !== 2 && note.payloadVersion !== 3 && note.payloadVersion !== 4 && note.payloadVersion !== 5) throw new Error('Unsupported note format.');
  if (note.pinned !== undefined && typeof note.pinned !== 'boolean') throw new Error('Invalid pin.');
  if (note.tags !== undefined && (!Array.isArray(note.tags) || note.tags.some(tag => typeof tag !== 'string'))) throw new Error('Invalid tags.');
  if (note.shares !== undefined && (!Array.isArray(note.shares) || note.shares.some(share => !share || typeof share.id !== 'string' || !/^[a-f0-9-]{36}$/.test(share.id) || !/^[A-Za-z0-9_-]{43}$/.test(share.key) || !/^[A-Za-z0-9_-]{43}$/.test(share.deleteToken) || !Number.isFinite(share.expiresAt) || !Number.isFinite(share.createdAt) || typeof share.burn !== 'boolean' || (share.revokedAt !== undefined && !Number.isFinite(Date.parse(share.revokedAt)))))) throw new Error('Invalid share metadata.');
  ids.add(note.id);
  if (note.attachments !== undefined && !Array.isArray(note.attachments)) throw new Error('Invalid attachments.');
  for (const a of note.attachments || []) {
   if (!a || typeof a.id !== 'string' || !a.id || typeof a.name !== 'string' || typeof a.type !== 'string' || !Number.isSafeInteger(a.size) || a.size < 0 || a.size > 5 * 1024 * 1024 || typeof a.dataUrl !== 'string' || !a.dataUrl.startsWith(`data:${a.type};base64,`)) throw new Error('Invalid attachment.');
   const value = JSON.stringify(a);
   if (attachments.has(a.id) && attachments.get(a.id) !== value) throw new Error('Conflicting attachment IDs.');
   attachments.set(a.id, value);
  }
  if (note.history !== undefined && (!Array.isArray(note.history) || note.history.length > 5 || note.history.some(v => !v || typeof v.title !== 'string' || typeof v.text !== 'string' || typeof v.at !== 'string' || !Number.isFinite(Date.parse(v.at))))) throw new Error('Invalid note history.');
  if (note.purgedAt !== undefined && (!note.deletedAt || !Number.isFinite(Date.parse(note.purgedAt)))) throw new Error('Invalid deletion marker.');
  if (note.purgedAt) return { id: note.id, title: '', text: '', payloadVersion: 5, updatedAt: noteTimestamp(note.updatedAt, notebookUpdatedAt), deletedAt: noteTimestamp(note.deletedAt), purgedAt: noteTimestamp(note.purgedAt) };
  const deletedAt = note.deletedAt === undefined ? undefined : noteTimestamp(note.deletedAt);
  const updatedAt = noteTimestamp(note.updatedAt, notebookUpdatedAt);
  return { ...note, pinned: note.pinned ?? false, tags: [...new Set((note.tags || []).map(tag => tag.trim().toLowerCase()).filter(Boolean))], payloadVersion: 5, updatedAt: deletedAt && deletedAt > updatedAt ? deletedAt : updatedAt, ...(deletedAt ? { deletedAt } : {}) };
 });
}
export function lastSyncedSnapshot(notes: Note[]): SyncedSnapshot {
 return Object.fromEntries(normalizeNotes(notes).map(note => [note.id, noteTimestamp(note.updatedAt)]));
}
function canonical(value: unknown): unknown {
 if (Array.isArray(value)) return value.map(canonical);
 if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => [key,canonical(item)]));
 return value;
}
function content(note: Note) {
 const { updatedAt, payloadVersion, attachments, ...rest } = note;
 void updatedAt; void payloadVersion;
 return JSON.stringify(canonical({ ...rest, attachments: [...(attachments || [])].sort((a,b) => a.id.localeCompare(b.id)) }));
}
// No clock, random IDs, storage, or network: the same inputs produce the same result.
export function mergeNotebooks(local: Note[], cloud: Note[], base: SyncedSnapshot = {}) {
 const left = new Map(normalizeNotes(local).map(n => [n.id,n])), right = new Map(normalizeNotes(cloud).map(n => [n.id,n]));
 const used = new Set([...left.keys(), ...right.keys()]), notes: Note[] = [];
 let conflictCopies = 0;
 for (const id of [...used].sort()) {
  const l = left.get(id), c = right.get(id);
  // Absence is not a deletion: legacy clients did not retain tombstones.
  if (!l || !c) { notes.push((l || c)!); continue; }
  if (l.purgedAt && noteTimestamp(c.updatedAt) <= l.purgedAt) { notes.push(l); continue; }
  if (c.purgedAt && noteTimestamp(l.updatedAt) <= c.purgedAt) { notes.push(c); continue; }
  if (content(l) === content(c)) { notes.push(noteTimestamp(l.updatedAt) >= noteTimestamp(c.updatedAt) ? l : c); continue; }
  const previous = Object.hasOwn(base, id) ? base[id] : undefined;
  const localChanged = noteTimestamp(l.updatedAt) !== previous, cloudChanged = noteTimestamp(c.updatedAt) !== previous;
  if (previous && l.deletedAt && noteTimestamp(l.updatedAt) < previous && !cloudChanged) { notes.push(c); continue; }
  if (previous && c.deletedAt && noteTimestamp(c.updatedAt) < previous && !localChanged) { notes.push(l); continue; }
  if (localChanged && !cloudChanged) { notes.push(l); continue; }
  if (cloudChanged && !localChanged) { notes.push(c); continue; }
  // Unknown baseline or timestamp collisions: preserve both instead of guessing.
  notes.push(l);
  const makeCopy = (copyId: string): Note => {
   if (c.purgedAt) return { ...c, id: copyId };
   const { deletedAt, ...copy } = c;
   void deletedAt;
   return { ...copy, id: copyId, title: `${c.title} (conflict copy)`, attachments: c.attachments?.map((a,index) => ({ ...a, id: `${copyId}:attachment:${index}` })) };
  };
  let copyId = `${id}:conflict:${noteTimestamp(c.updatedAt)}`, suffix = 1;
  while (used.has(copyId) && content((left.get(copyId) || right.get(copyId) || notes.find(n => n.id === copyId))!) !== content(makeCopy(copyId))) copyId = `${id}:conflict:${noteTimestamp(c.updatedAt)}:${suffix++}`;
  if (used.has(copyId)) continue; // Retry after an upload failure must not duplicate a conflict copy.
  used.add(copyId);
  notes.push(makeCopy(copyId));
  conflictCopies++;
 }
 return { notes: normalizeNotes(notes), merged: notes.length - conflictCopies, conflictCopies };
}
