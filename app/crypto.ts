export const DEFAULT_KDF_ITERATIONS = 600000;
export type Envelope = { format: number; iterations: number; salt: string; iv: string; data: string };
export type Attachment = { id: string; name: string; type: string; size: number; dataUrl: string };
export type NoteVersion = { title: string; text: string; at: string };
export type NoteShare = { id: string; key: string; deleteToken: string; expiresAt: number; createdAt: number; burn: boolean; revokedAt?: string };
export type Note = { id: string; title: string; text: string; payloadVersion?: 1 | 2 | 3 | 4 | 5; shares?: NoteShare[]; pinned?: boolean; tags?: string[]; history?: NoteVersion[]; purgedAt?: string; updatedAt?: string | number; deletedAt?: string; attachments?: Attachment[] };
export const previewableImageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const enc = new TextEncoder();
function b64(bytes: Uint8Array) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function bytes(s: string) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
export function salt() { return b64(crypto.getRandomValues(new Uint8Array(16))); }
export async function derive(password: string, s: string, iterations = DEFAULT_KDF_ITERATIONS) {
 const material = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
 return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: bytes(s), iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export const encodeBase64 = b64;
export const decodeBase64 = bytes;
export async function encryptBytes(value: Uint8Array, key: CryptoKey, purpose: string) {
 const iv = crypto.getRandomValues(new Uint8Array(12));
 const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`CLProText:${purpose}`) }, key, value.slice().buffer as ArrayBuffer);
 return { iv: b64(iv), data: b64(new Uint8Array(data)) };
}
export async function decryptBytes(value: { iv: string; data: string }, key: CryptoKey, purpose: string) {
 return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(value.iv), additionalData: enc.encode(`CLProText:${purpose}`) }, key, bytes(value.data)));
}
export async function seal(notes: Note[], key: CryptoKey, s: string): Promise<Envelope> {
 const iv = crypto.getRandomValues(new Uint8Array(12));
 const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('CLProText:v1') }, key, enc.encode(JSON.stringify(notes)));
 return { format: 1, iterations: DEFAULT_KDF_ITERATIONS, salt: s, iv: b64(iv), data: b64(new Uint8Array(data)) };
}
export async function unseal(p: Envelope, key: CryptoKey): Promise<Note[]> {
 if (p.format !== 1 || p.iterations !== DEFAULT_KDF_ITERATIONS || bytes(p.salt).length !== 16 || bytes(p.iv).length !== 12) throw new Error('Unsupported backup format.');
 const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(p.iv), additionalData: enc.encode('CLProText:v1') }, key, bytes(p.data));
 const notes = JSON.parse(new TextDecoder().decode(data));
 if (!Array.isArray(notes) || !notes.length || notes.some(n => typeof n.id !== 'string' || typeof n.title !== 'string' || typeof n.text !== 'string' || (n.attachments !== undefined && (!Array.isArray(n.attachments) || n.attachments.some((a: Attachment) => typeof a.id !== 'string' || typeof a.name !== 'string' || typeof a.type !== 'string' || !Number.isSafeInteger(a.size) || a.size < 0 || typeof a.dataUrl !== 'string' || !a.dataUrl.startsWith(`data:${a.type};base64,`))))) || new Set(notes.map(n => n.id)).size !== notes.length) throw new Error('Invalid notebook.');
 return notes;
}

export type WrappedKey = { iv: string; data: string };
export type KeyEnvelope = { salt: string; iterations: number; wrappedKey: WrappedKey; recoverySalt: string; recoveryWrappedKey: WrappedKey };
export type VaultAccess = { key: CryptoKey; rawKey: Uint8Array; envelope: KeyEnvelope; legacyWriteToken?: string; legacyPassword?: string };
export type Credential = string | VaultAccess;
export async function importDataKey(raw: Uint8Array) {
 if (raw.length !== 32) throw new Error('Invalid data key.');
 return crypto.subtle.importKey('raw', raw.slice().buffer, 'AES-GCM', false, ['encrypt','decrypt']);
}
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function encodeRecoveryKey(raw: Uint8Array) {
 if (raw.length !== 20) throw new Error('Invalid recovery key.');
 let bits = 0, value = 0, result = '';
 for (const byte of raw) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; result += alphabet[(value >>> bits) & 31]; } }
 return result.match(/.{4}/g)!.join('-');
}
export function decodeRecoveryKey(text: string) {
 const value = text.toUpperCase().replace(/[-\s]/g,'');
 if (!/^[A-Z2-7]{32}$/.test(value)) throw new Error('Enter the complete recovery key.');
 const raw: number[] = []; let bits = 0, buffer = 0;
 for (const char of value) { buffer = (buffer << 5) | alphabet.indexOf(char); bits += 5; if (bits >= 8) { bits -= 8; raw.push((buffer >>> bits) & 255); } }
 return new Uint8Array(raw);
}
async function recoveryWrappingKey(recoveryKey: string, recoverySalt: string) {
 const material = await crypto.subtle.importKey('raw', decodeRecoveryKey(recoveryKey), 'HKDF', false, ['deriveKey']);
 return crypto.subtle.deriveKey({ name:'HKDF', hash:'SHA-256', salt:decodeBase64(recoverySalt), info:enc.encode('clprotext-recovery-wrap') }, material, {name:'AES-GCM',length:256}, false, ['encrypt','decrypt']);
}
export async function wrapDataKey(raw: Uint8Array, password: string) {
 const s = salt(), recoverySalt = salt(), recoveryKey = encodeRecoveryKey(crypto.getRandomValues(new Uint8Array(20)));
 const envelope: KeyEnvelope = { salt:s, iterations:DEFAULT_KDF_ITERATIONS, wrappedKey:await encryptBytes(raw,await derive(password,s),'dek:password'), recoverySalt, recoveryWrappedKey:await encryptBytes(raw,await recoveryWrappingKey(recoveryKey,recoverySalt),'dek:recovery') };
 return { envelope, recoveryKey };
}
export async function unlockDataKey(envelope: KeyEnvelope, secret: string, recovery = false): Promise<VaultAccess> {
 if (envelope.iterations !== DEFAULT_KDF_ITERATIONS) throw new Error('Unsupported key derivation.');
 const key = recovery ? await recoveryWrappingKey(secret,envelope.recoverySalt) : await derive(secret,envelope.salt,envelope.iterations);
 const rawKey = await decryptBytes(recovery ? envelope.recoveryWrappedKey : envelope.wrappedKey,key,recovery ? 'dek:recovery' : 'dek:password');
 return { key:await importDataKey(rawKey),rawKey,envelope };
}
export async function rewrapPassword(access: VaultAccess, password: string): Promise<KeyEnvelope> {
 const s = salt();
 return { ...access.envelope, salt:s, wrappedKey:await encryptBytes(access.rawKey,await derive(password,s),'dek:password') };
}
export async function rewrapRecovery(access: VaultAccess) {
 const recoveryKey = encodeRecoveryKey(crypto.getRandomValues(new Uint8Array(20))), recoverySalt = salt();
 return { recoveryKey, envelope:{ ...access.envelope,recoverySalt,recoveryWrappedKey:await encryptBytes(access.rawKey,await recoveryWrappingKey(recoveryKey,recoverySalt),'dek:recovery') } };
}
export async function dataKeyWriteToken(raw: Uint8Array) {
 const material = await crypto.subtle.importKey('raw',raw.slice().buffer,'HKDF',false,['deriveBits']);
 const token = await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:new Uint8Array(32),info:enc.encode('clprotext-write-token')},material,256);
 return encodeBase64(new Uint8Array(token));
}
