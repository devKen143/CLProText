import { env } from 'cloudflare:workers';
import { createShareHandler } from '../../../lib/share-api';
import { shareRepository } from '../../../lib/share-repository';
export const dynamic = 'force-dynamic';
const handler = createShareHandler(()=> {
 const bindings = env as unknown as { DB?:D1Database; BUCKET?:R2Bucket; SHARE_RATE_LIMITER?:{limit:(options:{key:string})=>Promise<{success:boolean}>} };
 if(!bindings.DB || !bindings.BUCKET)return null;
 const bucket=bindings.BUCKET, limiter=bindings.SHARE_RATE_LIMITER;
 return {repository:shareRepository(bindings.DB),blobs:{
  get:async(key:string)=>{const object=await bucket.get(key);return object ? object.text() : null;},
  put:async(key:string,value:string)=>{if(!await bucket.put(key,value,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}}))throw new Error('Share already exists.');},
  delete:async(key:string)=>{await bucket.delete(key);},
 },rateLimit:limiter ? async(request:Request)=>(await limiter.limit({key:request.headers.get('cf-connecting-ip') || 'unknown'})).success : undefined};
});
export const POST = handler;
export const GET = handler;
export const DELETE = handler;
