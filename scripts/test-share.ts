import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {encryptShare,decryptShare} from '../app/share-crypto';
import {createShareHandler} from '../lib/share-api';
import {shareRepository} from '../lib/share-repository';
import {MAX_SHARE_BYTES,MAX_SHARE_REQUEST_BYTES} from '../lib/share-contract';

function fixture() {
 const db=new DatabaseSync(':memory:');db.exec(readFileSync('drizzle/0004_shares.sql','utf8'));
 const binding={prepare:(sql:string)=>({bind:(...args:Array<string|number>)=>({
  first:async()=>db.prepare(sql).get(...args) || null,
  run:async()=>db.prepare(sql).run(...args),
 })})} as unknown as D1Database;
 const repository=shareRepository(binding),objects=new Map<string,string>();let now=1000000;
 const handler=createShareHandler(()=>({repository,now:()=>now,blobs:{get:async key=>objects.get(key)??null,put:async(key,value)=>{objects.set(key,value);},delete:async key=>{objects.delete(key);}}}));
 const send=(method:string,path:string,body?:unknown,token?:string)=>handler(new Request('https://test.local'+path,{method,headers:{...(body ? {'Content-Type':'application/json'} : {}),...(token ? {Authorization:`Bearer ${token}`} : {})},body:body ? JSON.stringify(body) : undefined}));
 const create=async(burn=false)=>{
  const cipher=await encryptShare({title:'Private title',text:'Private text'});
  const response=await send('POST','/api/share',{iv:cipher.iv,data:cipher.data,expiresIn:3600,burn});
  assert.equal(response.status,201);
  return {...await response.json() as {id:string;deleteToken:string;expiresAt:number},key:cipher.key};
 };
 return {db,repository,objects,send,create,setTime:(value:number)=>{now=value;}};
}
test('share encryption excludes attachments; wrong key and tampering fail; size cap enforced',async()=>{
 const source={title:'Title',text:'Text',attachments:[{dataUrl:'not shared'}]};
 const encrypted=await encryptShare(source);
 assert.match(encrypted.key,/^[A-Za-z0-9_-]{43}$/);
 assert.deepEqual(await decryptShare(encrypted,encrypted.key),{title:'Title',text:'Text'});
 assert(!encrypted.data.includes('Title'));
 await assert.rejects(()=>decryptShare(encrypted,'A'.repeat(43)));
 await assert.rejects(()=>decryptShare({...encrypted,data:(encrypted.data[0]==='A'?'B':'A')+encrypted.data.slice(1)},encrypted.key));
 await assert.rejects(()=>encryptShare({title:'',text:'x'.repeat(MAX_SHARE_BYTES)}));
});
test('ciphertext-only creation and revocation; delete token is hashed in D1',async()=>{
 const f=fixture();try {
  const share=await f.create();
  const row=await f.repository.get(share.id);assert.equal(row!.deleteTokenHash.length,64);assert.notEqual(row!.deleteTokenHash,share.deleteToken);
  const stored=f.objects.get(`shares/${share.id}`)!;assert(!stored.includes('Private'));assert(!stored.includes(share.key));assert(!stored.includes(share.deleteToken));
  const read=await f.send('GET',`/api/share/${share.id}`);assert.equal(read.status,200);
  assert.equal(read.headers.get('Cache-Control'),'no-store');assert.equal(read.headers.get('Referrer-Policy'),'no-referrer');assert.equal(read.headers.get('X-Robots-Tag'),'noindex');
  assert.equal((await decryptShare(await read.json() as {iv:string;data:string},share.key)).text,'Private text');
  assert.equal((await f.send('DELETE',`/api/share/${share.id}`,undefined,'A'.repeat(43))).status,403);
  assert.equal((await f.send('DELETE',`/api/share/${share.id}`,undefined,share.deleteToken)).status,200);
  const gone=await f.send('GET',`/api/share/${share.id}`);assert.equal(gone.status,410);assert.match((await gone.json() as {error:string}).error,/revoked/);
  assert.equal(f.objects.size,0);
 } finally {f.db.close();}
});
test('expired shares reject and delete their ciphertext lazily',async()=>{
 const f=fixture();try {
  const share=await f.create();f.setTime(share.expiresAt);
  const response=await f.send('GET',`/api/share/${share.id}`);assert.equal(response.status,410);assert.match((await response.json() as {error:string}).error,/expired/);
  assert.equal(f.objects.size,0);assert.equal((await f.repository.get(share.id))!.state,'expired');
 } finally {f.db.close();}
});
test('concurrent burn readers: exactly one wins the atomic D1 update',async()=>{
 const f=fixture();try {
  const share=await f.create(true);
  const responses=await Promise.all([f.send('GET',`/api/share/${share.id}`),f.send('GET',`/api/share/${share.id}`)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,410]);
  const success=responses.find(r=>r.status===200)!;
  assert.equal((await decryptShare(await success.json() as {iv:string;data:string},share.key)).title,'Private title');
  assert.equal((await f.repository.get(share.id))!.state,'burned');assert.equal(f.objects.size,0);
  const again=await f.send('GET',`/api/share/${share.id}`);assert.match((await again.json() as {error:string}).error,/already been read/);
 } finally {f.db.close();}
});
test('missing ciphertext does not burn a one-time share',async()=>{
 const f=fixture();try {
  const share=await f.create(true);f.objects.clear();
  assert.equal((await f.send('GET',`/api/share/${share.id}`)).status,503);
  assert.equal((await f.repository.get(share.id))!.state,'active');
 } finally {f.db.close();}
});
test('invalid options, plaintext fields, oversized requests, and rate limit are rejected',async()=>{
 const f=fixture();try {
  const cipher=await encryptShare({title:'',text:'text'}),body={iv:cipher.iv,data:cipher.data,expiresIn:3600,burn:false};
  assert.equal((await f.send('POST','/api/share',{...body,title:'plaintext'})).status,400);
  assert.equal((await f.send('POST','/api/share',{...body,expiresIn:123})).status,400);
  assert.equal((await f.send('POST','/api/share',{...body,data:'A'.repeat(MAX_SHARE_REQUEST_BYTES)})).status,413);
  const limited=createShareHandler(()=>({repository:f.repository,blobs:{get:async()=>null,put:async()=>{},delete:async()=>{}},rateLimit:async()=>false}));
  assert.equal((await limited(new Request('https://test.local/api/share'))).status,429);
 } finally {f.db.close();}
});
