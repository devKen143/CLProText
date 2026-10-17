import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createVaultHandler, hashToken, equalHash, type VaultRow} from '../lib/vault-api';
import {MAX_BLOB_BYTES, validUsername} from '../lib/sync-contract';
import {deriveWriteToken, sealCloud, openCloud, WRITE_TOKEN_CONTEXT} from '../app/sync-crypto';
import {encodeBase64} from '../app/crypto';

const password='Test-only! Long notebook password 473';
const token=await deriveWriteToken(password,'alice');
assert.equal(token,await deriveWriteToken(password,'alice'));
assert.notEqual(token,await deriveWriteToken(password,'bob'));
const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
const expected=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',iterations:600000,salt:new TextEncoder().encode(WRITE_TOKEN_CONTEXT+'alice')},material,256);
assert.equal(token,encodeBase64(new Uint8Array(expected)));
const encryptionSalt=crypto.getRandomValues(new Uint8Array(16));
const encryptionBits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',iterations:600000,salt:encryptionSalt},material,256);
assert.notEqual(token,encodeBase64(new Uint8Array(encryptionBits)));
assert.equal(validUsername(' ALICE '),false);assert.equal(validUsername('../alice'),false);
const notes=[{id:'note-1',title:'Secret title',text:'Private notes',attachments:[{id:'file-1',name:'confidential.txt',type:'text/plain',size:5,dataUrl:'data:text/plain;base64,aGVsbG8='}]}];
const blob=await sealCloud(notes,password,'alice');
assert.deepEqual(await openCloud(blob,password,'alice'),notes);
assert(!JSON.stringify(blob).includes('confidential')); assert(!JSON.stringify(blob).includes('Secret title'));
await assert.rejects(()=>openCloud(blob,'wrong password','alice'));
await assert.rejects(()=>openCloud(blob,password,'bob'));
await assert.rejects(()=>openCloud({...blob,data:(blob.data[0]==='A'?'B':'A')+blob.data.slice(1)},password,'alice'));
assert.notEqual((await sealCloud(notes,password,'alice')).iv,blob.iv);
// A random 5 MiB attachment must fit in the 8 MiB encrypted cloud envelope.
const large=new Uint8Array(5*1024*1024);
for(let i=0;i<large.length;i+=65536) crypto.getRandomValues(large.subarray(i,Math.min(i+65536,large.length)));
const attached=[{id:'large',title:'Large attachment',text:'',attachments:[{id:'binary',name:'five-mib.bin',type:'application/octet-stream',size:large.length,dataUrl:'data:application/octet-stream;base64,'+Buffer.from(large).toString('base64')}]}];
const largeBlob=await sealCloud(attached,password,'alice');
assert(Buffer.byteLength(JSON.stringify(largeBlob))<=MAX_BLOB_BYTES);
assert.deepEqual(await openCloud(largeBlob,password,'alice'),attached);

const rows=new Map<string,VaultRow>(), objects=new Map<string,string>();
let failPut=false;
const handler=createVaultHandler(()=>({repository:{
 get:async name=>rows.has(name)?{...rows.get(name)!}:undefined,
 create:async row=>{if(rows.has(row.username))return false;rows.set(row.username,row);return true;},
 update:async (previous,next)=>{const row=rows.get(previous.username);if(row?.version!==previous.version||row.blobKey!==previous.blobKey)return false;rows.set(next.username,next);return true;},
 remove:async previous=>{const row=rows.get(previous.username);if(row?.version!==previous.version||row.blobKey!==previous.blobKey)return false;rows.delete(previous.username);return true;},
},blobs:{get:async key=>objects.get(key)??null,put:async(key,value)=>{if(failPut)throw new Error();objects.set(key,value);},delete:async key=>{objects.delete(key);}}}));
const call=(method:string,body?:unknown,query='alice')=>handler(new Request('https://clprotext.test/api/vault?username='+encodeURIComponent(query),{method,headers:{'content-type':'application/json',origin:'https://clprotext.test'},body:body===undefined?undefined:JSON.stringify(body)}));
const body={username:'alice',writeToken:token,expectedVersion:0,blob};
assert.equal((await call('GET')).status,404);
assert.equal((await call('GET',undefined,'../bad')).status,400);
const creates=await Promise.all([call('PUT',body),call('PUT',body)]);
assert.deepEqual(creates.map(r=>r.status).sort(),[201,409]);
assert.equal(rows.get('alice')!.writeTokenHash,await hashToken(token));
assert.notEqual(rows.get('alice')!.writeTokenHash,token);
assert(equalHash(await hashToken(token),await hashToken(token)));
assert(!equalHash(await hashToken(token),'0'.repeat(64)));
assert.equal((await call('PUT',{...body,expectedVersion:1,writeToken:'A'.repeat(43)+'='})).status,403);
const updates=await Promise.all([call('PUT',{...body,expectedVersion:1}),call('PUT',{...body,expectedVersion:1})]);
assert.deepEqual(updates.map(r=>r.status).sort(),[200,409]);
const conflict=await call('PUT',{...body,expectedVersion:1});assert.equal(conflict.status,409);assert.equal((await conflict.json() as {version:number}).version,2);
assert.equal(objects.size,1);assert(objects.has(rows.get('alice')!.blobKey));
assert.equal((await call('PUT',{...body,expectedVersion:2,blob:{...blob,data:'A'.repeat(MAX_BLOB_BYTES)}})).status,413);
assert.equal((await call('PUT',{...body,expectedVersion:2,blob:{...blob,plaintext:'no'}})).status,400);
assert.equal((await call('PUT',{...body,expectedVersion:2.5})).status,400);
assert.equal((await handler(new Request('https://clprotext.test/api/vault',{method:'PUT',headers:{'content-type':'application/json'},body:'{invalid'}))).status,400);
assert.equal((await handler(new Request('https://clprotext.test/api/vault',{method:'PUT',headers:{'content-type':'application/json','content-length':String(MAX_BLOB_BYTES+9999)},body:'{}'}))).status,413);
assert.equal((await handler(new Request('https://clprotext.test/api/vault',{method:'PUT',headers:{'content-type':'application/json',origin:'https://other.test'},body:'{}'}))).status,403);
failPut=true;assert.equal((await call('PUT',{...body,expectedVersion:2})).status,503);assert.equal(rows.get('alice')!.version,2);failPut=false;
const fetched=await call('GET');assert.equal(fetched.status,200);assert.deepEqual((await fetched.json() as {blob:unknown}).blob,blob);
assert.equal((await call('DELETE',{...body,expectedVersion:2,writeToken:'B'.repeat(43)+'='})).status,403);
assert.equal((await call('DELETE',{...body,expectedVersion:1})).status,409);
assert.equal((await call('DELETE',{username:'alice',writeToken:token,expectedVersion:2})).status,200);
assert.equal((await call('GET')).status,404);assert.equal(objects.size,0);
assert.equal((await createVaultHandler(()=>null)(new Request('https://test/api/vault?username=alice'))).status,503);

const sqlite=new DatabaseSync(':memory:');
sqlite.exec(readFileSync('drizzle/0000_left_mockingbird.sql','utf8'));
sqlite.prepare('INSERT INTO vaults VALUES (?,?,?)').run('old-owner','encrypted legacy',1);
sqlite.exec(readFileSync('drizzle/0001_cloud_sync_metadata.sql','utf8'));
assert.equal(sqlite.prepare('SELECT payload FROM legacy_vaults').get()!.payload,'encrypted legacy');
assert.equal(sqlite.prepare('SELECT count(*) AS n FROM vaults').get()!.n,0);
sqlite.close();
console.log('PASS: token separation; ciphertext-only attachment round trip including 5 MiB; wrong password/tamper rejection; create/update/read/delete; concurrent CAS; 409/403/400/413/503; non-destructive migration.');

if(process.env.SYNC_TEST_ORIGIN) {
 const origin=new URL(process.env.SYNC_TEST_ORIGIN);
 if(origin.hostname!=='127.0.0.1') throw new Error('Integration tests must target local emulation.');
 const username='qa-'+crypto.randomUUID().slice(0,8), writeToken=await deriveWriteToken(password,username), payload=await sealCloud(notes,password,username);
 const live=async(method:string,value?:unknown)=>fetch(`${origin.origin}/api/vault?username=${username}`,{method,headers:{'Content-Type':'application/json',Origin:origin.origin},body:value===undefined?undefined:JSON.stringify(value),signal:AbortSignal.timeout(10000)});
 const first=await live('PUT',{username,writeToken,expectedVersion:0,blob:payload});assert.equal(first.status,201,await first.text());
 const read=await live('GET');assert.equal(read.status,200);const saved=await read.json() as {blob:typeof payload;version:number};assert.equal(saved.version,1);assert.deepEqual(await openCloud(saved.blob,password,username),notes);
 const races=await Promise.all([live('PUT',{username,writeToken,expectedVersion:1,blob:payload}),live('PUT',{username,writeToken,expectedVersion:1,blob:payload})]);assert.deepEqual(races.map(r=>r.status).sort(),[200,409]);
 assert.equal((await live('PUT',{username,writeToken:'A'.repeat(43)+'=',expectedVersion:2,blob:payload})).status,403);
 assert.equal((await live('DELETE',{username,writeToken,expectedVersion:2})).status,200);
 assert.equal((await live('GET')).status,404);
 const page=await fetch(`${origin.origin}/qa-notebook`);assert.equal(page.status,200);assert((await page.text()).includes('Open cloud notebook'));
 console.log('PASS: actual built Worker + local D1/R2 create/read/decrypt/concurrent update/bad-token/delete and username-route response.');
}
