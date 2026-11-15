'use client';
import {useEffect,useRef,useState} from 'react';
import NoteMarkdown from '../../note-markdown';
import {decodeShareKey,decryptShare} from '../../share-crypto';
import {validShareId,validShareCiphertext} from '../../../lib/share-contract';
export default function ShareViewer({id}:{id:string}) {
 const [note,setNote]=useState<{title:string;text:string}|null>(null), [error,setError]=useState(''), [dark,setDark]=useState(false);
 const pending=useRef<{id:string;promise:Promise<{title:string;text:string}>}|null>(null);
 useEffect(()=> {
  let cancelled=false;
  // Reuse the request across StrictMode effect replay: never burn a link twice.
  if(pending.current?.id!==id) pending.current={id,promise:(async()=> {
   if(!validShareId(id))throw new Error('Invalid share link.');
   const key=window.location.hash.slice(1);decodeShareKey(key);
   const response=await fetch(`/api/share/${id}`,{cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(20000)});
   const data=await response.json();
   if(!response.ok)throw new Error(data && typeof data==='object' && 'error' in data && typeof data.error==='string' ? data.error : 'Could not open this share.');
   if(!validShareCiphertext(data))throw new Error('Invalid shared note.');
   try { return await decryptShare(data,key); } catch { throw new Error('The share key is wrong, or this shared note is damaged.'); }
  })()};
  pending.current.promise.then(value=>{if(!cancelled)setNote(value);},failure=>{if(!cancelled)setError(failure instanceof Error ? failure.message : 'Could not open this share.');});
  return()=>{cancelled=true;};
 },[id]);
 return <div className={dark ? 'app dark' : 'app'} style={{display:'block',minHeight:'100dvh',padding:'max(24px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left))'}}><main style={{maxWidth:850,margin:'0 auto'}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><p className="eyebrow">CLPROTEXT · SHARED NOTE</p><button type="button" className="quiet" onClick={()=>setDark(!dark)} aria-label="Toggle dark mode">{dark ? 'Light mode' : 'Dark mode'}</button></div>{error ? <p className="error" role="alert">{error}</p> : note ? <article style={{background:'var(--surface)',border:'1px solid var(--line)',borderRadius:12,padding:24,overflowWrap:'anywhere'}}><h1 style={{fontSize:32,letterSpacing:-1}}>{note.title || 'Untitled note'}</h1><NoteMarkdown text={note.text}/></article> : <p role="status">Opening encrypted note...</p>}</main></div>;
}
