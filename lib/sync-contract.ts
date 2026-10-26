export const MAX_BLOB_BYTES = 8 * 1024 * 1024;
export const MAX_REQUEST_BYTES = MAX_BLOB_BYTES + 4096;
export const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;
const reserved = new Set(['api', '_next', 'assets', 'signin-with-chatgpt', 'signout-with-chatgpt', 'callback']);
export function normalizeUsername(value: string) { return value.trim().toLowerCase(); }
export function validUsername(value: unknown): value is string {
  return typeof value === 'string' && value === normalizeUsername(value) && USERNAME_PATTERN.test(value) && !reserved.has(value);
}
export type CloudBlob = { format: 2; iterations: 600000; compression: 'gzip'; salt: string; iv: string; data: string };
export function validBlob(value: unknown): value is CloudBlob {
  if (!value || typeof value !== 'object') return false;
  const p = value as CloudBlob;
  return Object.keys(p).sort().join(',') === 'compression,data,format,iterations,iv,salt' && p.format === 2 && p.iterations === 600000 && p.compression === 'gzip' &&
    typeof p.salt === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(p.salt) &&
    typeof p.iv === 'string' && /^[A-Za-z0-9+/]{16}$/.test(p.iv) &&
    typeof p.data === 'string' && p.data.length >= 24 && p.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(p.data);
}
