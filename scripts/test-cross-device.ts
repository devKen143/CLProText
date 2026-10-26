import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createVaultHandler, type VaultRow} from '../lib/vault-api';
import {normalizeUsername, validUsername} from '../lib/sync-contract';
import {findCloud, downloadCloud, writeCloud, sameNotebook} from '../app/cloud-client';
import {installCloudNotebook, readHeader, listNotes, listAttachments, replaceNotebook} from '../app/storage';
import {derive, salt, seal} from '../app/crypto';
import {openCloud, deriveWriteToken} from '../app/sync-crypto';

const password = 'Cross-device! notebook password 982';
const notes = [{id:'one',title:'A private note',text:'Device A',attachments:[{id:'file',name:'test.txt',type:'text/plain',size:2,dataUrl:'data:text/plain;base64,aGk='}]}];
const rows = new Map<string,VaultRow>(), objects = new Map<string,string>();
let failCreate = false, ambiguousCommit = false, failPut = false, blobReads = 0;
const repository = {
 get:async (name:string)=>{const row=rows.get(name);return row && {...row};},
 create:async (row:VaultRow)=>{if(failCreate) throw new Error('D1 failure');if(rows.has(row.username))return false;rows.set(row.username,row);if(ambiguousCommit)throw new Error('Lost response');return true;},
 update:async (before:VaultRow,after:VaultRow)=>{if(rows.get(before.username)?.version!==before.version)return false;rows.set(before.username,after);return true;},
 remove:async ()=>false,
};
const handler=createVaultHandler(()=>({repository,blobs:{get:async key=>{blobReads++;return objects.get(key)??null;},put:async(key,value)=>{if(failPut)throw new Error('R2 failure');assert(!objects.has(key));objects.set(key,value);},delete:async key=>{objects.delete(key);}}}));
const realFetch=globalThis.fetch;
globalThis.fetch=async (input,init)=>handler(new Request(new URL(String(input),'https://test.local'),init));
function device() { const idb=new IDBFactory(); Object.assign(globalThis,{indexedDB:idb,window:{indexedDB:idb}});return idb; }
device();
assert.equal(normalizeUsername(' Friend '),'friend');
assert(validUsername('ab'));assert(validUsername('a'));assert(!validUsername('api'));assert(!validUsername('-a'));
assert.equal(await findCloud('friend',true),null);
assert.equal(await readHeader('friend'),undefined);
assert.equal((await indexedDB.databases()).length,0);
assert.equal(await writeCloud('friend',password,notes,0),1);
// Existing deployments may use arbitrary R2 keys. Follow the D1 pointer verbatim.
const oldKey=rows.get('friend')!.blobKey, legacyKey='vaults_micro_existing-uuid';
objects.set(legacyKey,objects.get(oldKey)!);objects.delete(oldKey);rows.get('friend')!.blobKey=legacyKey;
const beforeReads=blobReads;assert(await findCloud('Friend',true));assert.equal(blobReads,beforeReads,'existence check does not download ciphertext');
const snapshotBefore=JSON.stringify([...objects]);
await assert.rejects(()=>writeCloud('Friend','another long password',notes,0),/newer version/);
assert.equal(JSON.stringify([...objects]),snapshotBefore);assert.equal(rows.get('friend')!.version,1);

// Fresh browser: authentication happens before any IndexedDB operation.
device();
await assert.rejects(()=>downloadCloud('Friend','wrong password'));
assert.equal((await indexedDB.databases()).length,0);
const pulled=await downloadCloud('Friend',password);
await installCloudNotebook('Friend',password,pulled.notes,pulled.snapshot.blob);
assert.equal((await readHeader('friend'))!.salt,pulled.snapshot.blob.salt);
assert.equal((await listNotes('friend',password))[0].text,'Device A');
assert.equal((await listAttachments('friend',password))[0].name,'test.txt');
assert.equal((await indexedDB.databases()).length,1);
await assert.rejects(()=>installCloudNotebook('friend',password,[],pulled.snapshot.blob));
assert.equal((await listNotes('friend',password)).length,1,'failed duplicate install is atomic');
const changed=[{...notes[0],text:'Device B saved'}];
await replaceNotebook('friend',password,changed);
assert.equal(await writeCloud('friend',password,changed,pulled.snapshot.version,pulled.snapshot.cryptoUsername),2);
await assert.rejects(()=>writeCloud('friend',password,notes,1),/newer version/);
assert.equal((await downloadCloud('friend',password)).notes[0].text,'Device B saved');
assert(sameNotebook([{id:'x',title:'',text:''}],[{id:'x',title:'',text:'',attachments:[]}]));

for(const status of [500,503,403]) {
 globalThis.fetch=async()=>new Response('{}',{status});
 await assert.rejects(()=>findCloud('unknown',true),/Could not reach the cloud/);
}
globalThis.fetch=async()=>{throw new TypeError('offline');};
await assert.rejects(()=>findCloud('unknown',true),/Could not reach the cloud/);
globalThis.fetch=async(input,init)=>handler(new Request(new URL(String(input),'https://test.local'),init));
failCreate=true;const count=objects.size;
await assert.rejects(()=>writeCloud('fail-create',password,notes,0));assert.equal(objects.size,count);assert(!rows.has('fail-create'));failCreate=false;
failPut=true;await assert.rejects(()=>writeCloud('fail-put',password,notes,0));assert(!rows.has('fail-put'));assert.equal(objects.size,count);failPut=false;
ambiguousCommit=true;assert.equal(await writeCloud('lost-response',password,notes,0),1);assert(objects.has(rows.get('lost-response')!.blobKey));ambiguousCommit=false;

const s=salt();const legacy=await seal(notes,await derive(password,s),s);
assert.deepEqual(await openCloud(legacy,password,'friend'),notes);
await assert.rejects(()=>openCloud(legacy,'incorrect','friend'));
assert.equal(await deriveWriteToken(password,'friend'),await deriveWriteToken(password,'friend'));

// Existing mixed-case IndexedDB names remain readable, without destructive migration.
device();
const oldName='clprotext-vault-'+Buffer.from('MixedCase').toString('base64url');
await new Promise<void>((resolve,reject)=>{const r=indexedDB.open(oldName,1);r.onupgradeneeded=()=>{r.result.createObjectStore('header');r.result.createObjectStore('notes',{keyPath:'id'});r.result.createObjectStore('attachments',{keyPath:'id'});};r.onsuccess=()=>{r.result.close();resolve();};r.onerror=()=>reject(r.error);});
await installCloudNotebook('mixedcase',password,notes,pulled.snapshot.blob);
assert.equal((await indexedDB.databases())[0].name,oldName);
assert.equal((await listNotes('MixedCase',password))[0].text,'Device A');

const db=new DatabaseSync(':memory:');
db.exec(readFileSync('drizzle/0000_left_mockingbird.sql','utf8'));
db.exec(readFileSync('drizzle/0001_cloud_sync_metadata.sql','utf8'));
db.exec(readFileSync('drizzle/0002_canonical_usernames.sql','utf8'));
db.prepare('INSERT INTO vaults VALUES (?,?,?,?,?,?,?)').run('Friend','hash',1,'legacy-object',1,1,1);
assert.throws(()=>db.prepare('INSERT INTO vaults VALUES (?,?,?,?,?,?,?)').run('friend','hash',1,'new-object',1,1,1));
db.close();globalThis.fetch=realFetch;
console.log('PASS: fresh-device lookup/unlock/save; wrong password writes nothing; canonical names; legacy IndexedDB/format-1 compatibility; duplicate creation; stale save; offline/5xx; R2/D1 failure compensation; ambiguous commit reconciliation.');
