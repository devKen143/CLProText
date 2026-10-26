import { normalizeUsername, validUsername, type CloudBlob } from '../lib/sync-contract';
import { deriveWriteToken, openCloud, sealCloud } from './sync-crypto';
import type { Note } from './crypto';

export type CloudSnapshot = { blob: CloudBlob; version: number; cryptoUsername: string };
export function sameNotebook(a: Note[], b: Note[]) {
  const stable = (notes: Note[]) => JSON.stringify(notes.map(n => ({id:n.id,title:n.title,text:n.text,attachments:(n.attachments || []).map(a=>({id:a.id,name:a.name,type:a.type,size:a.size,dataUrl:a.dataUrl})).sort((a,b)=>a.id.localeCompare(b.id))})).sort((a,b)=>a.id.localeCompare(b.id)));
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
export async function downloadCloud(username: string, password: string) {
  const snapshot = await findCloud(username);
  if (!snapshot) throw new Error('Cloud notebook was not found. Retry loading.');
  const notes = await openCloud(snapshot.blob, password, snapshot.cryptoUsername);
  return {snapshot,notes};
}
export async function writeCloud(username: string, password: string, notes: Note[], version: number, cryptoUsername = username) {
  const writeToken = await deriveWriteToken(password,cryptoUsername);
  const blob = await sealCloud(notes,password,cryptoUsername);
  const response = await fetch('/api/vault', {method:version === 0 ? 'POST' : 'PUT',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(20000),body:JSON.stringify({username:normalizeUsername(username),writeToken,expectedVersion:version,blob})});
  if (response.status === 409) throw new Error('A newer version exists in the cloud. Lock and unlock to check it before saving.');
  if (!response.ok) throw new Error('Could not save to the cloud. Your local notes are safe. Retry.');
  const data = await response.json() as {version:number};
  return data.version as number;
}
