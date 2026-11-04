import { mergeNotebooks, normalizeNotes } from './merge-notebooks';
import { markSynced, readSyncedSnapshot, replaceNotebook, readHeader, commitKeyEnvelope } from './storage';
import { normalizeUsername, validUsername, type CloudBlob } from '../lib/sync-contract';
import { deriveWriteToken, openCloud, sealCloud } from './sync-crypto';
import { dataKeyWriteToken, unlockDataKey, type Credential, type VaultAccess, type KeyEnvelope, type Note } from './crypto';

export type CloudSnapshot = { blob: CloudBlob; version: number; cryptoUsername: string; updatedAt?: number };
export function sameNotebook(a: Note[], b: Note[]) {
  const stable = (notes: Note[]) => JSON.stringify(notes.map(n => ({id:n.id,title:n.title,text:n.text,pinned:n.pinned || false,tags:n.tags || [],shares:n.shares || [],deletedAt:n.deletedAt,purgedAt:n.purgedAt,history:n.history || [],attachments:(n.attachments || []).map(a=>({id:a.id,name:a.name,type:a.type,size:a.size,dataUrl:a.dataUrl})).sort((a,b)=>a.id.localeCompare(b.id))})).sort((a,b)=>a.id.localeCompare(b.id)));
  return stable(a) === stable(b);
}
export async function findCloud(username: string, existenceOnly = false): Promise<CloudSnapshot | null> {
  username = normalizeUsername(username);
  if (!validUsername(username)) throw new Error('Invalid username.');
  let response: Response;
  try { response = await fetch(`/api/vault?username=${encodeURIComponent(username)}${existenceOnly ? '&exists=1' : ''}`, {cache:'no-store',signal:AbortSignal.timeout(20000)}); }
  catch { throw new Error('Could not reach the cloud. Retry.'); }
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Could not reach the cloud. Retry.');
  const data = await response.json() as CloudSnapshot & {exists?:boolean};
  if (!Number.isSafeInteger(data.version) || data.version < 1 || (existenceOnly ? data.exists !== true : !data.blob)) throw new Error('Could not reach the cloud. Retry.');
  return {...data,cryptoUsername:data.cryptoUsername || username};
}
export async function downloadCloud(username: string, password: Credential) {
  const snapshot = await findCloud(username);
  if (!snapshot) throw new Error('Cloud notebook was not found. Retry loading.');
  const notes = await openCloud(snapshot.blob, password, snapshot.cryptoUsername, snapshot.updatedAt);
  return {snapshot,notes};
}
export async function writeCloud(username: string, password: Credential, notes: Note[], version: number, cryptoUsername = username) {
  let credential = password;
  let oldToken: string | undefined;
  if (typeof password !== 'string') {
   const remote = await findCloud(username);
   if (remote && remote.version !== version) throw new CloudConflictError();
   const header = await readHeader(username);
   credential = {...password,envelope:header?.keys || password.envelope};
   if (remote?.blob.format === 3) {
    await openCloud(remote.blob,password,remote.cryptoUsername,remote.updatedAt);
    credential.envelope = remote.blob.keys!;
    await commitKeyEnvelope(username,password,remote.blob.keys!,header?.recoveryPending);
   } else if (remote) {
    oldToken = password.legacyWriteToken;
    if (!oldToken) throw new Error('Unlock with the original password to finish cloud migration.');
   }
  }
  const writeToken = typeof credential === 'string' ? await deriveWriteToken(credential,cryptoUsername) : await dataKeyWriteToken(credential.rawKey);
  const blob = await sealCloud(notes,credential,cryptoUsername);
  if (oldToken) { const next = await postRekey(username,oldToken,writeToken,blob,version); if (typeof password !== 'string') { delete password.legacyPassword; delete password.legacyWriteToken; } return next; }
  const response = await fetch('/api/vault', {method:version === 0 ? 'POST' : 'PUT',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(20000),body:JSON.stringify({username:normalizeUsername(username),writeToken,expectedVersion:version,blob})});
  if (response.status === 409) throw new CloudConflictError();
  if (!response.ok) throw new Error('Could not save to the cloud. Your local notes are safe. Retry.');
  const data = await response.json() as {version:number};
  if (typeof password !== 'string') { delete password.legacyPassword; delete password.legacyWriteToken; }
  return data.version as number;
}

export class CloudConflictError extends Error {
 constructor() { super('Cloud changed again. Retry saving; your local notes are safe.'); }
}
export class MergeError extends Error {
 constructor(public remote: Note[], public snapshot: CloudSnapshot) { super('Automatic merge failed. Export a backup, then choose Keep local or Load cloud.'); }
}
export async function synchronizeNotebook(username: string, password: Credential, local: Note[], version: number | null, cryptoUsername: string, apply: (notes: Note[]) => void | Promise<void>) {
 const original = normalizeNotes(local);
 let items = original, observed = version, identity = cryptoUsername || username, summary = '';
 for (let attempt = 0; attempt < 3; attempt++) {
  if (observed === null) {
   const found = await findCloud(username);
   if (!found) { observed = 0; identity = username; }
   else {
    const remote = await openCloud(found.blob,typeof password !== 'string' && found.blob.format !== 3 ? password.legacyPassword || password : password,found.cryptoUsername,found.updatedAt);
    identity = found.cryptoUsername; observed = found.version;
    try {
     const result = mergeNotebooks(original, remote, await readSyncedSnapshot(username, password));
     items = result.notes;
     await replaceNotebook(username, password, items);
     await apply(items);
     summary = `Merged ${result.merged} notes, ${result.conflictCopies} conflict copies`;
    } catch { throw new MergeError(remote, found); }
   }
  }
  try {
   const nextVersion = await writeCloud(username, password, items, observed, identity);
   await markSynced(username, password, items);
   return { notes: items, version: nextVersion, cryptoUsername: identity, message: summary || 'Saved on this device and in the cloud' };
  } catch (error) {
   if (!(error instanceof CloudConflictError)) throw error;
   observed = null;
  }
 }
 throw new CloudConflictError();
}

async function postRekey(username: string, oldToken: string, newWriteToken: string, blob: CloudBlob, expectedVersion: number) {
 const response = await fetch('/api/vault/rekey',{method:'PATCH',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(20000),body:JSON.stringify({username:normalizeUsername(username),writeToken:oldToken,newWriteToken,blob,expectedVersion})});
 if (response.status === 409) throw new CloudConflictError();
 if (!response.ok) throw new Error('Could not upgrade cloud access. Local notebook is safe; retry syncing.');
 return (await response.json() as {version:number}).version;
}
export async function publishKeyEnvelope(username: string, access: VaultAccess, keys: KeyEnvelope, recoveryPending = false) {
 const remote = await findCloud(username);
 let version = 0;
 if (remote) {
  if (remote.blob.format !== 3) throw new Error('Save and sync the notebook before changing its password or recovery key.');
  await openCloud(remote.blob,access,remote.cryptoUsername,remote.updatedAt);
  if (JSON.stringify(remote.blob.keys) !== JSON.stringify(access.envelope)) throw new Error('Notebook credentials changed on another device. Lock and unlock before changing them again.');
  // Reuse ciphertext verbatim: only the wrapped data key changes.
  const writeToken = await dataKeyWriteToken(access.rawKey);
  version = await postRekey(username,writeToken,writeToken,{...remote.blob,keys,salt:keys.salt},remote.version);
 }
 await commitKeyEnvelope(username,access,keys,recoveryPending);
 return version;
}
export async function recoverLocalAccess(username: string, secret: string, recovery: boolean): Promise<VaultAccess> {
 const remote = await findCloud(username);
 if (!remote || remote.blob.format !== 3) throw new Error('Recovery is not available for this notebook yet.');
 const access = await unlockDataKey(remote.blob.keys!,secret,recovery);
 await openCloud(remote.blob,access,remote.cryptoUsername,remote.updatedAt);
 // commitKeyEnvelope verifies the local key-check before writing anything.
 await commitKeyEnvelope(username,access,remote.blob.keys!);
 return access;
}
