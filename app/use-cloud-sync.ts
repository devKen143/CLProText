'use client';
import { useEffect, useRef, useState } from 'react';
import type { Note } from './crypto';
import { deriveWriteToken, openCloud, sealCloud } from './sync-crypto';
import type { CloudBlob } from '../lib/sync-contract';
type Remote = { blob: CloudBlob; version: number };
type Status = 'local only' | 'synced' | 'syncing' | 'conflict' | 'offline error';
export function useCloudSync(options: { username: string; notes: Note[]; password: () => string; unlocked: boolean; dirty: boolean; busy: boolean; replace: (notes: Note[]) => Promise<void> }) {
 const [enabled,setEnabled] = useState(false), [status,setStatus] = useState<Status>('local only'), [message,setMessage] = useState(''), [working,setWorking] = useState(false);
 const latest = useRef(options);
 const baseline = useRef<number | null>(null), remote = useRef<Remote | null>(null), lastContent = useRef(''), token = useRef(''), inFlight = useRef(false), controller = useRef<AbortController | null>(null);
 const [retry,setRetry] = useState(0);
 const preference = `clprotext:sync:${options.username}`;
 useEffect(() => { latest.current = options; }, [options]);
 function preferenceEnabled(value: boolean) { try { localStorage.setItem(preference, value ? 'true' : 'false'); } catch { /* Storage preference is optional; vault writes report their own errors. */ } setEnabled(value); }
 /* eslint-disable react-hooks/set-state-in-effect */
 useEffect(() => {
  try { setEnabled(localStorage.getItem(preference) === 'true'); } catch { setEnabled(false); }
  baseline.current=null; remote.current=null; lastContent.current=''; token.current=''; setStatus('local only'); setMessage('');
  return () => { controller.current?.abort(); token.current=''; };
 },[preference,options.unlocked]);
 /* eslint-enable react-hooks/set-state-in-effect */
 async function request(method: string, body?: unknown) {
  controller.current = new AbortController();
  const timeout = setTimeout(()=>controller.current?.abort(),20000);
  try {
   const response = await fetch(method === 'GET' ? `/api/vault?username=${encodeURIComponent(latest.current.username)}` : '/api/vault', {method,cache:'no-store',signal:controller.current.signal,headers:body ? {'Content-Type':'application/json'} : undefined,body:body ? JSON.stringify(body) : undefined});
   const data = await response.json() as Remote & {error?:string};
   return {response,data};
  } finally { clearTimeout(timeout); }
 }
 async function pull() { const {response,data} = await request('GET'); if(response.status === 404) return null; if(!response.ok) throw new Error(data.error || 'Cloud unavailable. Retry later.'); return data as Remote; }
 async function push(version: number) {
  const {notes,password,username} = latest.current;
  const pass=password(); if(!pass) throw new Error('Unlock your notebook first.');
  token.current ||= await deriveWriteToken(pass,username);
  const blob=await sealCloud(notes,pass,username);
  const {response,data}=await request('PUT',{username,writeToken:token.current,expectedVersion:version,blob});
  if(response.status === 409) { remote.current=await pull(); baseline.current=data.version; setStatus('conflict'); setMessage('Cloud changed. Export a backup, then choose which version to keep.'); return; }
  if(!response.ok) throw new Error(data.error || 'Sync failed. Local notes are safe.');
  baseline.current=data.version; lastContent.current=JSON.stringify(notes); remote.current=null; setStatus('synced'); setMessage('Encrypted snapshot saved to cloud.');
 }
 async function run(task:()=>Promise<void>) {
  if(inFlight.current) return;
  inFlight.current=true; setWorking(true); setStatus('syncing'); setMessage('');
  try { await task(); } catch(e) { setStatus('offline error'); setMessage((e as Error).message || 'Connection failed. Local notes are safe.'); }
  finally { inFlight.current=false; setWorking(false); }
 }
 async function synchronize() {
  await run(async()=> {
   const o=latest.current; if(!o.unlocked || o.dirty || o.busy) { setStatus('local only'); return; }
   if(baseline.current === null) {
    const found=await pull(); remote.current=found;
    if(found) {
     // Never replace a local working copy during an automatic pull.
     const cloudNotes=await openCloud(found.blob,o.password(),o.username);
     baseline.current=found.version;
     if(JSON.stringify(cloudNotes) !== JSON.stringify(o.notes)) { setStatus('conflict'); setMessage('Local and cloud notebooks differ. Back up first; choose which complete notebook to keep.'); return; }
     lastContent.current=JSON.stringify(o.notes); setStatus('synced'); setMessage('Local and cloud copies match.'); return;
    }
    baseline.current=0;
   }
   await push(baseline.current);
  });
 }
 /* eslint-disable react-hooks/exhaustive-deps */
 useEffect(()=> {
  if(!enabled || !options.unlocked || options.dirty || options.busy || working || status==='conflict' || status==='offline error') return;
  if(baseline.current !== null && lastContent.current === JSON.stringify(options.notes)) return;
  const timer=setTimeout(()=>void synchronize(),900); return ()=>clearTimeout(timer);
 },[enabled,options.unlocked,options.notes,options.dirty,options.busy,working,status,retry]); // synchronize reads latest.current
 /* eslint-enable react-hooks/exhaustive-deps */
 useEffect(()=> {
  if(!enabled || !options.unlocked) return;
  const retryLater=()=> { if(!inFlight.current && status!=='conflict') { setStatus('local only'); setRetry(n=>n+1); } };
  window.addEventListener('online',retryLater); const timer=setInterval(retryLater,30000);
  return()=> {window.removeEventListener('online',retryLater); clearInterval(timer);};
 },[enabled,options.unlocked,status]);
 async function resolve(choice:'local'|'cloud') {
  if(latest.current.dirty || latest.current.busy) { setMessage('Save your local changes before resolving this conflict.'); return; }
  if(!window.confirm(choice==='local' ? 'Replace the cloud notebook with this local notebook? Export a backup first.' : 'Replace all local notes and attachments with the cloud notebook? Export a backup first.')) return;
  await run(async()=> {
   if(choice==='local') { if(baseline.current===null) throw new Error('Retry sync first.'); await push(baseline.current); }
   else {
    const found=await pull(); if(!found) throw new Error('Cloud notebook no longer exists. Local notes were kept.');
    const notes=await openCloud(found.blob,latest.current.password(),latest.current.username);
    await latest.current.replace(notes); baseline.current=found.version; lastContent.current=JSON.stringify(notes); remote.current=null; setStatus('synced'); setMessage('Loaded cloud snapshot.');
   }
  });
 }
 async function download(password: string) {
  const found=await pull(); if(!found) throw new Error('No cloud notebook exists at this username.');
  const notes=await openCloud(found.blob,password,latest.current.username);
  preferenceEnabled(true); return notes;
 }
 async function removeCloud() {
  if(!window.confirm('Delete the cloud copy permanently? Your saved local notebook remains. Export a backup first.')) return;
  await run(async()=> {
   const found=await pull(); if(!found) throw new Error('Cloud notebook was not found.');
   token.current ||= await deriveWriteToken(latest.current.password(),latest.current.username);
   const {response,data}=await request('DELETE',{username:latest.current.username,writeToken:token.current,expectedVersion:found.version});
   if(!response.ok) throw new Error(data.error || 'Could not delete cloud copy.');
   preferenceEnabled(false); baseline.current=null; token.current=''; setStatus('local only'); setMessage('Cloud copy deleted. Local notebook kept.');
  });
 }
 return {enabled,status,message,working,resolve,download,removeCloud,
  toggle:()=> { preferenceEnabled(!enabled); baseline.current=null; lastContent.current=''; token.current=''; setStatus('local only'); setMessage(''); },
  retry:()=> { baseline.current=null; setStatus('local only'); setRetry(n=>n+1); },
 };
}
