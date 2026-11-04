import { hashToken, equalHash, type BlobStore } from './vault-api';
import { MAX_SHARE_REQUEST_BYTES, SHARE_DURATIONS, validShareCiphertext, validShareId } from './share-contract';
export type ShareRow = { id:string; expiresAt:number; burn:boolean; createdAt:number; deleteTokenHash:string; state:'active'|'burned'|'revoked'|'expired' };
export interface ShareRepository {
 get(id:string): Promise<ShareRow | undefined>;
 create(row:ShareRow): Promise<void>;
 acquire(id:string,now:number): Promise<ShareRow | undefined>;
 expire(id:string,now:number): Promise<void>;
 revoke(id:string,hash:string): Promise<void>;
}
export type ShareDeps = { repository:ShareRepository; blobs:BlobStore; rateLimit?:(request:Request)=>Promise<boolean>; now?:()=>number };
const headers = {'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex','X-Content-Type-Options':'nosniff'};
const response = (body:unknown,status=200)=>Response.json(body,{status,headers});
const unavailable = (row?:ShareRow) => response({error:row?.state === 'expired' ? 'This share has expired.' : row?.state === 'burned' ? 'This one-time share has already been read.' : row?.state === 'revoked' ? 'This share was revoked.' : 'This share is no longer available.'},410);
class ShareError extends Error { constructor(public status:number,message:string) { super(message); } }
async function body(request:Request) {
 if (!request.headers.get('content-type')?.startsWith('application/json')) throw new ShareError(415,'Expected application/json.');
 if (Number(request.headers.get('content-length')) > MAX_SHARE_REQUEST_BYTES) throw new ShareError(413,'Share exceeds 256 KB.');
 const reader=request.body?.getReader(); if(!reader) throw new ShareError(400,'Missing ciphertext.');
 const chunks:Uint8Array[]=[];let size=0;
 try { for (;;) { const {value,done}=await reader.read(); if(done)break; size+=value.byteLength; if(size>MAX_SHARE_REQUEST_BYTES){await reader.cancel();throw new ShareError(413,'Share exceeds 256 KB.');} chunks.push(value); } } finally { reader.releaseLock(); }
 try { return JSON.parse(await new Blob(chunks as BlobPart[]).text()); } catch { throw new ShareError(400,'Invalid share request.'); }
}
export function createShareHandler(dependencies:()=>ShareDeps|null) {
 return async(request:Request):Promise<Response>=> {
  try {
   const deps=dependencies();if(!deps)return response({error:'Sharing is unavailable.'},503);
   if(deps.rateLimit && !await deps.rateLimit(request))return response({error:'Too many requests. Try again later.'},429);
   const {repository,blobs}=deps, now=deps.now?.()??Date.now(), url=new URL(request.url);
   if(request.method==='POST') {
    const origin=request.headers.get('origin');if(origin && origin!==url.origin)return response({error:'Cross-origin write rejected.'},403);
    const value=await body(request), expiresIn=value?.expiresIn, burn=value?.burn;
    if(!value || Object.keys(value).sort().join(',')!=='burn,data,expiresIn,iv' || !validShareCiphertext(value) || !SHARE_DURATIONS.includes(expiresIn) || typeof burn!=='boolean')return response({error:'Invalid ciphertext or expiry.'},400);
    const id=crypto.randomUUID(), raw=crypto.getRandomValues(new Uint8Array(32));
    const deleteToken=btoa(String.fromCharCode(...raw)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const row:ShareRow={id,createdAt:now,expiresAt:now+expiresIn*1000,burn,deleteTokenHash:await hashToken(deleteToken),state:'active'};
    const blobKey=`shares/${id}`;
    await blobs.put(blobKey,JSON.stringify({iv:value.iv,data:value.data}));
    try { await repository.create(row); }
    catch (error) { const stored=await repository.get(id); if(!stored) { await blobs.delete(blobKey); throw error; } if(stored.deleteTokenHash!==row.deleteTokenHash)throw error; }
    return response({id,deleteToken,expiresAt:row.expiresAt,createdAt:row.createdAt},201);
   }
   const id=url.pathname.split('/').pop() || '';if(!validShareId(id))return response({error:'Invalid share link.'},400);
   const row=await repository.get(id);if(!row)return response({error:'This share was not found or is no longer available.'},404);
   const blobKey=`shares/${id}`;
   if(request.method==='DELETE') {
    const origin=request.headers.get('origin');if(origin && origin!==url.origin)return response({error:'Cross-origin write rejected.'},403);
    const token=request.headers.get('authorization')?.replace(/^Bearer /,'') || '';
    if(!/^[A-Za-z0-9_-]{43}$/.test(token) || !equalHash(row.deleteTokenHash,await hashToken(token)))return response({error:'Invalid revocation token.'},403);
    await repository.revoke(id,row.deleteTokenHash);await blobs.delete(blobKey).catch(()=>{});
    return response({revoked:true});
   }
   if(request.method!=='GET')return response({error:'Method not allowed.'},405);
   if(row.expiresAt<=now && row.state==='active') { await repository.expire(id,now);await blobs.delete(blobKey).catch(()=>{});return unavailable({...row,state:'expired'}); }
   if(row.state!=='active') { await blobs.delete(blobKey).catch(()=>{});return unavailable(row); }
   const ciphertext=await blobs.get(blobKey);if(ciphertext===null)return response({error:'Shared note temporarily unavailable.'},503);
   // Fetch first, then atomically claim. A failed R2 fetch must not burn the share.
   const acquired=await repository.acquire(id,deps.now?.()??Date.now());
   if(!acquired) { const latest=await repository.get(id); if(latest && latest.expiresAt<=(deps.now?.()??Date.now()) && latest.state==='active') { await repository.expire(id,deps.now?.()??Date.now());await blobs.delete(blobKey).catch(()=>{});return unavailable({...latest,state:'expired'}); } return unavailable(latest); }
   if(acquired.burn)await blobs.delete(blobKey).catch(()=>{});
   return response(JSON.parse(ciphertext));
  } catch(error) { return response({error:error instanceof ShareError ? error.message : 'Sharing is temporarily unavailable.'},error instanceof ShareError ? error.status : 503); }
 };
}
