import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { wrapDataKey, unlockDataKey, rewrapPassword, rewrapRecovery, dataKeyWriteToken, encodeRecoveryKey, decodeRecoveryKey } from '../app/crypto';
import { createVault, replaceNotebook, migrateVaultKey, listNotes, listAttachments, exportVault, readHeader, rotateVaultPassword, unlockVaultAccess, markSynced, readSyncedSnapshot } from '../app/storage';
import { sealCloud, openCloud, deriveWriteToken } from '../app/sync-crypto';
import { createVaultHandler, hashToken, type VaultRow } from '../lib/vault-api';
import { validBlob } from '../lib/sync-contract';

const indexedDB = new IDBFactory(); Object.assign(globalThis,{indexedDB,window:{indexedDB}});
const password = 'Tests-only! long password 456', nextPassword = 'New-test-only! password 987';
const notes = [{id:'one',title:'Private',text:'Contents',updatedAt:'2026-01-01T00:00:00.000Z',attachments:[{id:'attachment',name:'test.txt',type:'text/plain',size:2,dataUrl:'data:text/plain;base64,aGk='}]}];

test('password and recovery wrappers round trip, wrong credentials fail, HKDF token is stable', async () => {
 const raw = crypto.getRandomValues(new Uint8Array(32)), wrapped = await wrapDataKey(raw,password);
 const byPassword = await unlockDataKey(wrapped.envelope,password), byRecovery = await unlockDataKey(wrapped.envelope,wrapped.recoveryKey,true);
 assert.deepEqual(byPassword.rawKey,raw); assert.deepEqual(byRecovery.rawKey,raw);
 assert.equal(decodeRecoveryKey(wrapped.recoveryKey).length,20);
 assert.equal(encodeRecoveryKey(decodeRecoveryKey(wrapped.recoveryKey)),wrapped.recoveryKey);
 await assert.rejects(()=>unlockDataKey(wrapped.envelope,'wrong'));
 await assert.rejects(()=>unlockDataKey(wrapped.envelope,'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA',true));
 const next = await rewrapPassword(byPassword,nextPassword);
 assert.deepEqual(next.recoveryWrappedKey,wrapped.envelope.recoveryWrappedKey);
 const changed = await unlockDataKey(next,nextPassword);
 assert.equal(await dataKeyWriteToken(changed.rawKey),await dataKeyWriteToken(raw));
 await assert.rejects(()=>unlockDataKey(next,password));
 const replacement = await rewrapRecovery(changed);
 await assert.rejects(()=>unlockDataKey(replacement.envelope,wrapped.recoveryKey,true));
 assert.deepEqual((await unlockDataKey(replacement.envelope,replacement.recoveryKey,true)).rawKey,raw);
 const modern = await sealCloud(notes,changed,'test'); assert(validBlob(modern)); assert.equal(modern.format,3);
 assert.equal((await openCloud(modern,nextPassword,'test'))[0].text,'Contents');
 assert.equal((await openCloud(modern,changed,'test'))[0].attachments![0].name,'test.txt');
 const legacy = await sealCloud(notes,password,'test'); assert.equal(legacy.format,2);
 assert.equal((await openCloud(legacy,password,'test'))[0].text,'Contents');
});
test('legacy migration is atomic, wrong passwords write nothing, password rotation leaves records untouched', async () => {
 await createVault('migration',password); await replaceNotebook('migration',password,notes); await markSynced('migration',password,notes);
 const before = await exportVault('migration',password);
 await assert.rejects(()=>migrateVaultKey('migration','wrong'));
 assert.deepEqual(await exportVault('migration',password),before);
 await assert.rejects(()=>migrateVaultKey('migration',password,undefined,undefined,()=>{ throw new Error('Simulated interruption'); }));
 assert.deepEqual(await exportVault('migration',password),before);
 const upgraded = await migrateVaultKey('migration',password,await deriveWriteToken(password,'migration'));
 assert.equal((await readHeader('migration'))!.formatVersion,2); assert(upgraded.recoveryKey);
 assert.equal((await listNotes('migration',upgraded.access))[0].text,'Contents');
 assert.equal((await listAttachments('migration',upgraded.access))[0].name,'test.txt');
 assert.deepEqual(await readSyncedSnapshot('migration',upgraded.access),{one:notes[0].updatedAt});
 const recovery = await unlockVaultAccess('migration',upgraded.recoveryKey,true);
 assert.equal((await listNotes('migration',recovery))[0].text,'Contents');
 const migratedRecords = await exportVault('migration',upgraded.access);
 await assert.rejects(()=>unlockVaultAccess('migration','AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA',true));
 assert.deepEqual(await exportVault('migration',upgraded.access),migratedRecords);
 await rotateVaultPassword('migration',upgraded.access,nextPassword);
 const after = await exportVault('migration',nextPassword);
 assert.deepEqual(after.notes,migratedRecords.notes); assert.deepEqual(after.attachments,migratedRecords.attachments);
 await assert.rejects(()=>listNotes('migration',password));
 assert.equal((await listNotes('migration',await unlockVaultAccess('migration',upgraded.recoveryKey,true)))[0].text,'Contents');
});
test('independently migrated devices can adopt the existing cloud data key without losing local notes', async () => {
 await createVault('adopt',password); await replaceNotebook('adopt',password,notes);
 const local = await migrateVaultKey('adopt',password);
 const remoteKeys = await wrapDataKey(crypto.getRandomValues(new Uint8Array(32)),password);
 const remote = await unlockDataKey(remoteKeys.envelope,password);
 const adopted = await migrateVaultKey('adopt',local.access,undefined,remote);
 assert.deepEqual(adopted.access.rawKey,remote.rawKey);
 assert.equal((await listNotes('adopt',password))[0].text,'Contents');
 assert.equal((await listAttachments('adopt',remote))[0].size,2);
});
test('rekey accepts only the old token and observed version, changes token hash and version atomically', async () => {
 const rows = new Map<string,VaultRow>(), blobs = new Map<string,string>();
 const handler = createVaultHandler(()=>({repository:{
  get:async name=>rows.get(name),create:async row=>{if(rows.has(row.username))return false;rows.set(row.username,row);return true;},
  update:async(before,after)=>{if(rows.get(before.username)?.version!==before.version)return false;rows.set(after.username,after);return true;},remove:async()=>false,
 },blobs:{get:async key=>blobs.get(key)??null,put:async(key,value)=>{blobs.set(key,value);},delete:async key=>{blobs.delete(key);}}}));
 const oldToken = await deriveWriteToken(password,'rekey');
 const wrapped = await wrapDataKey(crypto.getRandomValues(new Uint8Array(32)),password), access = await unlockDataKey(wrapped.envelope,password);
 const newToken = await dataKeyWriteToken(access.rawKey), modern = await sealCloud(notes,access,'rekey');
 const send=(method:string,path:string,body:unknown)=>handler(new Request('https://test.local'+path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
 assert.equal((await send('POST','/api/vault',{username:'rekey',writeToken:oldToken,expectedVersion:0,blob:await sealCloud(notes,password,'rekey')})).status,201);
 const before=JSON.stringify([...rows]);
 assert.equal((await send('PATCH','/api/vault/rekey',{username:'rekey',writeToken:'A'.repeat(43)+'=',newWriteToken:newToken,expectedVersion:1,blob:modern})).status,403);
 assert.equal(JSON.stringify([...rows]),before);
 assert.equal((await send('PATCH','/api/vault/rekey',{username:'rekey',writeToken:oldToken,newWriteToken:newToken,expectedVersion:2,blob:modern})).status,409);
 assert.equal((await send('PATCH','/api/vault/rekey',{username:'rekey',writeToken:oldToken,newWriteToken:newToken,expectedVersion:1,blob:modern})).status,200);
 assert.equal(rows.get('rekey')!.version,2); assert.equal(rows.get('rekey')!.writeTokenHash,await hashToken(newToken));
 assert.equal((await send('PUT','/api/vault',{username:'rekey',writeToken:oldToken,expectedVersion:2,blob:modern})).status,403);
 assert.equal((await send('PUT','/api/vault',{username:'rekey',writeToken:newToken,expectedVersion:2,blob:modern})).status,200);
});
