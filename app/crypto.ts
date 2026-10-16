export type Envelope = { format: number; iterations: number; salt: string; iv: string; data: string };
export type Attachment = { id: string; name: string; type: string; size: number; dataUrl: string };
export type Note = { id: string; title: string; text: string; attachments?: Attachment[] };
export const previewableImageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const enc = new TextEncoder();
function b64(bytes: Uint8Array) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function bytes(s: string) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
export function salt() { return b64(crypto.getRandomValues(new Uint8Array(16))); }
export async function derive(password: string, s: string, iterations = 600000) {
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
 return { format: 1, iterations: 600000, salt: s, iv: b64(iv), data: b64(new Uint8Array(data)) };
}
export async function unseal(p: Envelope, key: CryptoKey): Promise<Note[]> {
 if (p.format !== 1 || p.iterations !== 600000 || bytes(p.salt).length !== 16 || bytes(p.iv).length !== 12) throw new Error('Unsupported backup format.');
 const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(p.iv), additionalData: enc.encode('CLProText:v1') }, key, bytes(p.data));
 const notes = JSON.parse(new TextDecoder().decode(data));
 if (!Array.isArray(notes) || !notes.length || notes.some(n => typeof n.id !== 'string' || typeof n.title !== 'string' || typeof n.text !== 'string' || (n.attachments !== undefined && (!Array.isArray(n.attachments) || n.attachments.some((a: Attachment) => typeof a.id !== 'string' || typeof a.name !== 'string' || typeof a.type !== 'string' || !Number.isSafeInteger(a.size) || a.size < 0 || typeof a.dataUrl !== 'string' || !a.dataUrl.startsWith(`data:${a.type};base64,`))))) || new Set(notes.map(n => n.id)).size !== notes.length) throw new Error('Invalid notebook.');
 return notes;
}
