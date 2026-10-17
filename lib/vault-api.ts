import { MAX_BLOB_BYTES, MAX_REQUEST_BYTES, validBlob, validUsername } from './sync-contract';
import { timingSafeEqual } from 'node:crypto';
export type VaultRow = { username: string; writeTokenHash: string; version: number; blobKey: string; sizeBytes: number; createdAt: number; updatedAt: number };
export interface VaultRepository {
  get(username: string): Promise<VaultRow | undefined>;
  create(row: VaultRow): Promise<boolean>;
  update(previous: VaultRow, next: VaultRow): Promise<boolean>;
  remove(previous: VaultRow): Promise<boolean>;
}
export interface BlobStore { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void>; delete(key: string): Promise<void> }
export type ApiDeps = { repository: VaultRepository; blobs: BlobStore; rateLimit?: (request: Request) => Promise<boolean> };
const encoder = new TextEncoder();
const response = (body: unknown, status = 200) => Response.json(body, {status, headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export async function hashToken(token: string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))), b => b.toString(16).padStart(2,'0')).join(''); }
export function equalHash(a: string, b: string) { return a.length === 64 && b.length === 64 && timingSafeEqual(encoder.encode(a),encoder.encode(b)); }
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
async function readBody(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415,'Expected application/json.');
  if (Number(request.headers.get('content-length')) > MAX_REQUEST_BYTES) throw new HttpError(413,'Request too large.');
  const reader = request.body?.getReader(); if (!reader) throw new HttpError(400,'Missing body.');
  let total = 0; const chunks: Uint8Array[] = [];
  try { for (;;) { const {value,done} = await reader.read(); if(done) break; total += value.byteLength; if(total > MAX_REQUEST_BYTES) { await reader.cancel(); throw new HttpError(413,'Request too large.'); } chunks.push(value); } } finally { reader.releaseLock(); }
  try { const value = JSON.parse(await new Blob(chunks as BlobPart[]).text()); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; } catch { throw new HttpError(400,'Invalid JSON body.'); }
}
export function createVaultHandler(dependencies: () => ApiDeps | null) {
  return async (request: Request): Promise<Response> => {
    try {
      const deps = dependencies(); if (!deps) return response({error:'Cloud sync is not configured. Local notes still work.'},503);
      // Deployment hook: bind a distributed limiter/WAF rule here; never log the body or token.
      if (deps.rateLimit && !await deps.rateLimit(request)) return response({error:'Too many requests. Try later.'},429);
      const {repository,blobs} = deps;
      if (request.method === 'GET') {
        const username = new URL(request.url).searchParams.get('username');
        if (!validUsername(username)) return response({error:'Invalid username.'},400);
        for(let attempt=0;attempt<2;attempt++) {
          const row = await repository.get(username); if (!row) return response({error:'Notebook not found.'},404);
          const blob = await blobs.get(row.blobKey);
          if (blob !== null) return response({blob:JSON.parse(blob),version:row.version});
        }
        return response({error:'Cloud snapshot temporarily unavailable. Retry later.'},503);
      }
      if (!['PUT','DELETE'].includes(request.method)) return response({error:'Method not allowed.'},405);
      const origin = request.headers.get('origin');
      if (origin && origin !== new URL(request.url).origin) return response({error:'Cross-origin write rejected.'},403);
      const body = await readBody(request);
      if (!validUsername(body.username) || typeof body.writeToken !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(body.writeToken) || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) return response({error:'Invalid username, token or version.'},400);
      const current = await repository.get(body.username), tokenHash = await hashToken(body.writeToken);
      if (current && !equalHash(current.writeTokenHash,tokenHash)) return response({error:'Incorrect write token. Check the notebook password.'},403);
      if ((current?.version || 0) !== body.expectedVersion) return response({error:'Cloud version changed.',version:current?.version || 0},409);
      if (request.method === 'DELETE') {
        if (!current) return response({error:'Notebook not found.'},404);
        if (!await repository.remove(current)) return response({error:'Cloud version changed.',version:(await repository.get(body.username))?.version || 0},409);
        await blobs.delete(current.blobKey).catch(()=>{});
        return response({deleted:true});
      }
      if (!validBlob(body.blob)) return response({error:'Malformed encrypted blob.'},400);
      const serialized = JSON.stringify(body.blob), sizeBytes = encoder.encode(serialized).byteLength;
      if(sizeBytes > MAX_BLOB_BYTES) return response({error:'Encrypted blob exceeds 8 MiB.'},413);
      const now = Date.now(), blobKey = `vaults/${body.username}/${crypto.randomUUID()}`;
      const next: VaultRow = {username:body.username,writeTokenHash:tokenHash,version:(current?.version || 0)+1,blobKey,sizeBytes,createdAt:current?.createdAt || now,updatedAt:now};
      await blobs.put(blobKey,serialized);
      // Immutable R2 blobs plus a D1 compare-and-swap prevent a losing write corrupting the winner.
      // On an ambiguous D1 failure retain the blob: deleting it might delete a committed snapshot.
      const accepted = current ? await repository.update(current,next) : await repository.create(next);
      if(!accepted) { await blobs.delete(blobKey).catch(()=>{}); return response({error:'Cloud version changed.',version:(await repository.get(body.username))?.version || 0},409); }
      if(current) await blobs.delete(current.blobKey).catch(()=>{});
      return response({version:next.version},current ? 200 : 201);
    } catch(e) { return response({error:e instanceof HttpError ? e.message : 'Cloud storage unavailable. Local notes are safe.'},e instanceof HttpError ? e.status : 503); }
  };
}
