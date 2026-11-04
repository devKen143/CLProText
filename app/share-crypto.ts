import { encryptBytes, decryptBytes, importDataKey, encodeBase64, decodeBase64 } from './crypto';
import { MAX_SHARE_BYTES, validShareCiphertext, type ShareCiphertext } from '../lib/share-contract';
export function decodeShareKey(key: string) {
 if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('The share key is missing or invalid.');
 return decodeBase64(key.replace(/-/g,'+').replace(/_/g,'/')+'=');
}
export async function encryptShare(note: { title: string; text: string }) {
 const bytes = new TextEncoder().encode(JSON.stringify({title:note.title,text:note.text}));
 if (bytes.length + 16 > MAX_SHARE_BYTES) throw new Error('This note is too large to share (256 KB maximum).');
 const raw = crypto.getRandomValues(new Uint8Array(32));
 const ciphertext = await encryptBytes(bytes,await importDataKey(raw),'share:v1');
 return {...ciphertext,key:encodeBase64(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')};
}
export async function decryptShare(ciphertext: ShareCiphertext, key: string): Promise<{title:string;text:string}> {
 if (!validShareCiphertext(ciphertext)) throw new Error('Invalid shared note.');
 const bytes = await decryptBytes(ciphertext,await importDataKey(decodeShareKey(key)),'share:v1');
 const note = JSON.parse(new TextDecoder().decode(bytes));
 if (!note || typeof note.title !== 'string' || typeof note.text !== 'string') throw new Error('Invalid shared note.');
 return {title:note.title,text:note.text};
}
