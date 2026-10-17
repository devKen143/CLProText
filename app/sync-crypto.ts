import { derive, salt, encryptBytes, decryptBytes, encodeBase64, type Note } from './crypto';
import { MAX_BLOB_BYTES, validBlob, validUsername, type CloudBlob } from '../lib/sync-contract';
const encoder = new TextEncoder();
export const WRITE_TOKEN_CONTEXT = 'CLProText:write-token:v1:';
export async function deriveWriteToken(password: string, username: string) {
  if (!validUsername(username)) throw new Error('Invalid username.');
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: encoder.encode(WRITE_TOKEN_CONTEXT + username) }, material, 256);
  return encodeBase64(new Uint8Array(bits));
}
export async function sealCloud(notes: Note[], password: string, username: string): Promise<CloudBlob> {
  const s = salt(), key = await derive(password, s);
  const packed = new Uint8Array(await new Response(new Blob([JSON.stringify(notes)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const encrypted = await encryptBytes(packed, key, `cloud:v2:${username}`);
  const blob: CloudBlob = { format: 2, iterations: 600000, compression: 'gzip', salt: s, ...encrypted };
  if (encoder.encode(JSON.stringify(blob)).byteLength > MAX_BLOB_BYTES) throw new Error('Cloud snapshot exceeds 8 MiB. Local notes are safe; remove attachments or export a backup.');
  return blob;
}
export async function openCloud(blob: CloudBlob, password: string, username: string): Promise<Note[]> {
  if (!validBlob(blob)) throw new Error('Invalid cloud notebook.');
  const key = await derive(password, blob.salt);
  const packed = await decryptBytes(blob, key, `cloud:v2:${username}`);
  const reader = new Blob([packed as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try { for (;;) { const {value,done} = await reader.read(); if(done) break; total += value.byteLength; if(total > 32 * 1024 * 1024) { await reader.cancel(); throw new Error('Cloud snapshot expands beyond the supported limit.'); } chunks.push(value); } } finally { reader.releaseLock(); }
  const parsed = JSON.parse(await new Blob(chunks as BlobPart[]).text());
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 10000 || new Set(parsed.map(n => n?.id)).size !== parsed.length) throw new Error('Invalid cloud notes.');
  for (const n of parsed) {
    if (!n || typeof n.id !== 'string' || typeof n.title !== 'string' || typeof n.text !== 'string' || (n.attachments !== undefined && !Array.isArray(n.attachments))) throw new Error('Invalid cloud note.');
    for (const a of n.attachments || []) {
      if (!a || typeof a.id !== 'string' || typeof a.name !== 'string' || typeof a.type !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(a.type) || !Number.isSafeInteger(a.size) || a.size < 0 || a.size > 5 * 1024 * 1024 || typeof a.dataUrl !== 'string' || !a.dataUrl.startsWith(`data:${a.type};base64,`)) throw new Error('Invalid cloud attachment.');
      const raw = a.dataUrl.slice(a.dataUrl.indexOf(',')+1);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || atob(raw).length !== a.size) throw new Error('Invalid cloud attachment size.');
    }
  }
  return parsed;
}
