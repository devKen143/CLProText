export const MAX_SHARE_BYTES = 256 * 1024;
export const MAX_SHARE_REQUEST_BYTES = Math.ceil(MAX_SHARE_BYTES / 3) * 4 + 2048;
export const SHARE_DURATIONS = [3600,86400,604800] as const;
export type ShareCiphertext = { iv: string; data: string };
export function validShareCiphertext(value: unknown): value is ShareCiphertext {
 if (!value || typeof value !== 'object') return false;
 const p = value as ShareCiphertext;
 if (typeof p.iv !== 'string' || !/^[A-Za-z0-9+/]{16}$/.test(p.iv) || typeof p.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.data) || p.data.length % 4 || p.data.length < 24) return false;
 const size = p.data.length / 4 * 3 - (p.data.endsWith('==') ? 2 : p.data.endsWith('=') ? 1 : 0);
 return size <= MAX_SHARE_BYTES;
}
export function validShareId(id: string) { return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id); }
