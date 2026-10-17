'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { LockKeyhole, ShieldCheck, Plus, Search, FileText, Download, Upload, Trash2, Moon, Sun, Leaf, Check, Cloud, ArrowRight } from 'lucide-react';
import { derive, encodeBase64, previewableImageTypes, type Note, type Envelope, type Attachment } from './crypto';
import { createVault, exportVault, listAttachments, listNotes, mergeVaultExport, migrateLegacyLocalStorage, previewVaultExport, readHeader, rotateVaultPassword, updateHeader, type VaultExport } from './storage';
import { normalizeUsername } from '../lib/sync-contract';
import { useCloudSync } from './use-cloud-sync';
import { replaceNotebook } from './storage';
export default function Home({ notebookUsername = '' }: { notebookUsername?: string }) {
 const [notes, setNotes] = useState<Note[]>([]), [active, setActive] = useState(''), [query, setQuery] = useState('');
 const [loaded, setLoaded] = useState(false), [exists, setExists] = useState(false), [password, setPassword] = useState(''), [confirm, setConfirm] = useState('');
 const [publicUsername, setPublicUsername] = useState(normalizeUsername(notebookUsername));
 const [selectedUsername, setSelectedUsername] = useState(normalizeUsername(notebookUsername));
 const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState(''), [lastBackupAt, setLastBackupAt] = useState<string | null>(null), [backupLabel, setBackupLabel] = useState('No backup yet'), [dark, setDark] = useState(false), [changePasswordOpen, setChangePasswordOpen] = useState(false), [newPassword, setNewPassword] = useState(''), [newPasswordConfirm, setNewPasswordConfirm] = useState(''), [retryAfter, setRetryAfter] = useState(0);
 const [importFile, setImportFile] = useState<File | null>(null), [importPassword, setImportPassword] = useState('');
 const key = useRef<CryptoKey | null>(null), currentPassword = useRef(''), currentSalt = useRef(''), envelope = useRef<Envelope | null>(null), file = useRef<HTMLInputElement>(null), attachmentInput = useRef<HTMLInputElement>(null);
 useEffect(()=> { if(import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(()=>{}); },[]);
 const failedUnlocks = useRef(0), blockedUntil = useRef(0);
 const unlocked = notes.length > 0;
 const note = notes.find(n => n.id === active) || notes[0];
 const cloud = useCloudSync({username:selectedUsername,notes,password:()=>currentPassword.current,unlocked,dirty,busy,
  replace:async(items)=> { await persist(items,currentPassword.current); setNotes(items); setActive(items[0].id); }
 });
 async function openFromCloud() {
  if(!password || !selectedUsername) {setError('Enter the username and cloud notebook password first.');return;}
  if(exists && !window.confirm('Replace this device notebook with the cloud copy? Unlock and export a backup first to keep local notes.')) return;
  setBusy(true);setError('');
  try {
   const items=await cloud.download(password);
   let header=await readHeader(selectedUsername);
   if(!header) header=await createVault(selectedUsername,password);
   else {
    // Verify the existing local password before replacing any records.
    await listNotes(selectedUsername,password);
   }
   await persist(items,password);
   currentPassword.current=password;currentSalt.current=header.salt;key.current=await derive(password,header.salt);
   setNotes(items);setActive(items[0].id);setPassword('');setConfirm('');
  } catch(e) {setError((e as Error).message || 'Could not open cloud notebook. Check the password.');} finally {setBusy(false);}
 }
 const passwordStrength = (value: string) => {
  if (!value) return { score: 0, label: 'Enter a password' };
  const common = ['password', '12345678', 'qwerty', 'letmein', 'welcome', 'admin', 'notebook'];
  let score = Math.min(4, Math.floor(value.length / 4));
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score++;
  if (/\d/.test(value)) score++;
  if (/[^A-Za-z0-9]/.test(value)) score++;
  if (common.some(word => value.toLowerCase().includes(word))) score = Math.min(score, 1);
  score = Math.min(4, score);
  return { score, label: score < 2 ? 'Weak' : score < 3 ? 'Fair' : score < 4 ? 'Good' : 'Strong' };
 };
 const strength = passwordStrength(password);
 async function load() {
  setError(''); setLoaded(false);
  if (!selectedUsername) return;
  try {
   const header = await readHeader(selectedUsername);
   const legacy = window.localStorage.getItem(`clprotext:vault:${selectedUsername}`);
   envelope.current = legacy ? (JSON.parse(legacy) as { payload?: Envelope }).payload || null : null;
   const backupAt = header?.lastBackupAt || null;
   setExists(!!header || !!legacy); setLastBackupAt(backupAt);
   setBackupLabel(!backupAt ? 'No backup yet' : Math.floor((Date.now() - Date.parse(backupAt)) / 86400000) > 0 ? `Last backup ${Math.floor((Date.now() - Date.parse(backupAt)) / 86400000)}d ago` : 'Backed up today');
   setLoaded(true);
  }
  catch (e) { setError((e as Error).message || 'Could not load this local notebook.'); }
 }
 // Loading the encrypted vault is an external IndexedDB/localStorage synchronization.
 /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
 useEffect(() => { void load(); }, [selectedUsername]);
 /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
 useEffect(() => { if (!retryAfter) return; const timer = window.setInterval(() => setRetryAfter(Math.max(0, blockedUntil.current - Date.now())), 250); return () => window.clearInterval(timer); }, [retryAfter]);
 useEffect(() => { const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
 async function readStoredNotes(username: string, password: string): Promise<Note[]> {
  const [stored, attachments] = await Promise.all([listNotes(username, password), listAttachments(username, password)]);
  const attachmentMap = new Map(attachments.map(attachment => [attachment.id, attachment]));
  return stored.map(item => ({
   id: item.id, title: item.title, text: item.text,
   attachments: item.attachmentIds.map(id => attachmentMap.get(id)).filter((a): a is NonNullable<typeof a> => !!a).map(a => ({
    id: a.id, name: a.name, type: a.type, size: a.size,
    dataUrl: `data:${a.type};base64,${encodeBase64(a.data)}`,
   })),
  }));
 }
 const persist = useCallback(async (items: Note[], password: string) => {
  if (!selectedUsername) throw new Error('A username is required.');
  await replaceNotebook(selectedUsername,password,items);
  setExists(true); setDirty(false); setStatus('Saved on this device');
 }, [selectedUsername]);
 async function unlock(e: React.FormEvent) {
  e.preventDefault(); setBusy(true); setError('');
  try {
   const wait = blockedUntil.current - Date.now();
   if (wait > 0) { setRetryAfter(wait); throw new Error(`Try again in ${Math.ceil(wait / 1000)} seconds.`); }
   if (!exists && (password.length < 12 || password !== confirm)) throw new Error('Use at least 12 characters and make sure both passwords match.');
   if (!exists && strength.score < 3) throw new Error('Choose a stronger password before creating this notebook.');
   if (!selectedUsername) throw new Error('A username is required.');
   let header = await readHeader(selectedUsername);
   if (!header && envelope.current) {
    await migrateLegacyLocalStorage(selectedUsername, password);
    header = await readHeader(selectedUsername);
   }
   if (!header) {
    header = await createVault(selectedUsername, password);
   }
   const s = header.salt, k = await derive(password, s, header.iterations);
   let items: Note[];
   try { items = await readStoredNotes(selectedUsername, password); failedUnlocks.current = 0; }
   catch {
    if (!envelope.current && !exists) throw new Error('Could not create this notebook.');
    failedUnlocks.current += 1; const delay = Math.min(15000, 1000 * 2 ** Math.min(failedUnlocks.current - 1, 4)); blockedUntil.current = Date.now() + delay; setRetryAfter(delay); throw new Error('Could not unlock. Check your password and try again.');
   }
   if (!items.length) { items = [{ id: crypto.randomUUID(), title: 'A fresh page', text: '' }]; await persist(items, password); }
   key.current = k; currentSalt.current = s; setNotes(items); setActive(items[0].id); setPassword(''); setConfirm(''); setStatus('Saved on this device');
   currentPassword.current = password;
  } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
 }
 async function changePassword() {
  if (!key.current || !notes.length) return;
  if(cloud.enabled) {setError('Delete the cloud copy before changing its password, or turn sync off to change only this device. The existing cloud copy keeps its old password.');return;}
  if(!window.confirm('Change this device password? Any cloud copy retains its existing password unless you delete it first.')) return;
  if (newPassword.length < 12 || newPassword !== newPasswordConfirm) { setError('Use at least 12 characters and make sure both new passwords match.'); return; }
  if (passwordStrength(newPassword).score < 3) { setError('Choose a stronger new password.'); return; }
  setBusy(true); setError('');
  try {
   const header = await rotateVaultPassword(selectedUsername, currentPassword.current, newPassword);
   const nextKey = await derive(newPassword, header.salt, header.iterations);
   key.current = nextKey; currentSalt.current = header.salt;
   currentPassword.current = newPassword;
   setNewPassword(''); setNewPasswordConfirm(''); setChangePasswordOpen(false); setStatus('Password changed on this device');
  } catch (e) { setError((e as Error).message || 'Could not change the password.'); } finally { setBusy(false); }
 }
 const save = useCallback(async () => { if (!key.current || busy || cloud.working) return; setBusy(true); setError(''); try { await persist(notes, currentPassword.current); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }, [busy, cloud.working, notes, persist]);
 useEffect(() => {
  if (!cloud.enabled || !unlocked || !dirty || busy || cloud.working || cloud.status === 'conflict') return;
  const timer = setTimeout(() => void save(), 1200);
  return () => clearTimeout(timer);
 }, [cloud.enabled, unlocked, dirty, busy, cloud.working, cloud.status, notes, save]);
 function lock() { if (dirty && !window.confirm('You have unsaved edits. Lock and discard them? Export a backup or save first to keep them.')) return; key.current = null; currentPassword.current = ''; currentSalt.current = ''; setImportFile(null); setImportPassword(''); setNotes([]); setQuery(''); setDirty(false); setStatus(''); void load(); }
 /* eslint-disable react-hooks/exhaustive-deps */
 useEffect(() => { if (!unlocked || dirty || busy || cloud.working) return; let timer: ReturnType<typeof setTimeout>; const reset = () => { clearTimeout(timer); timer = setTimeout(lock, 10 * 60 * 1000); }; reset(); window.addEventListener('pointerdown', reset); window.addEventListener('keydown', reset); return () => { clearTimeout(timer); window.removeEventListener('pointerdown', reset); window.removeEventListener('keydown', reset); }; }, [unlocked, dirty, busy, cloud.working]);
 /* eslint-enable react-hooks/exhaustive-deps */
 function edit(patch: Partial<Note>) { setNotes(notes.map(n => n.id === note.id ? { ...n, ...patch } : n)); setDirty(true); setStatus('Unsaved changes'); }
 function add() { const n = { id: crypto.randomUUID(), title: 'Untitled note', text: '' }; setNotes([...notes, n]); setActive(n.id); setQuery(''); setDirty(true); setStatus('Unsaved changes'); }
 function remove() { if (!window.confirm('Delete this note? Save the notebook to apply this change locally.')) return; const items = notes.filter(n => n.id !== note.id); if (!items.length) items.push({ id: crypto.randomUUID(), title: 'Untitled note', text: '' }); setNotes(items); setActive(items[0].id); setDirty(true); setStatus('Unsaved changes'); }
 async function attach(event: React.ChangeEvent<HTMLInputElement>) {
  const selected = event.target.files?.[0];
  event.target.value = '';
  if (!selected || !note) return;
  if (selected.size > 5 * 1024 * 1024) { setError('Attachments must be 5 MB or smaller.'); return; }
  setBusy(true); setError('');
  try {
   const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read file.')); reader.onerror = () => reject(new Error('Could not read file.')); reader.readAsDataURL(selected); });
   const type = selected.type || 'application/octet-stream';
   const attachment: Attachment = { id: crypto.randomUUID(), name: selected.name, type, size: selected.size, dataUrl };
   edit({ attachments: [...(note.attachments || []), attachment] }); setStatus('Attachment added â€” save to keep it');
  } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
 }
 function removeAttachment(id: string) { edit({ attachments: (note.attachments || []).filter(a => a.id !== id) }); }
 async function backup() { if (!key.current || !selectedUsername) return; setError(''); setBusy(true); try { if(dirty) await persist(notes,currentPassword.current); const p = await exportVault(selectedUsername, currentPassword.current); const url = URL.createObjectURL(new Blob([JSON.stringify(p)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'clprotext-' + new Date().toISOString().slice(0,10) + '.json'; a.click(); URL.revokeObjectURL(url); const backedUpAt = new Date().toISOString(); await updateHeader(selectedUsername, { lastBackupAt: backedUpAt }); setLastBackupAt(backedUpAt); setBackupLabel('Backed up today'); setStatus('Encrypted backup downloaded'); } catch { setError('Backup failed. Please try again.'); } finally {setBusy(false);} }
 async function restore(e: React.FormEvent) { e.preventDefault(); if (!importFile || !key.current || !selectedUsername) return; if (importFile.size > 10000000) { setError('Backup is too large.'); return; } setBusy(true); setError(''); try { const p = JSON.parse(await importFile.text()) as VaultExport; const preview = await previewVaultExport(p, importPassword); const choice = window.prompt(`Backup contains ${preview.notes.length} notes and ${preview.attachments.length} attachments. Type MERGE or REPLACE to apply.`); if (choice?.toLowerCase() !== 'merge' && choice?.toLowerCase() !== 'replace') throw new Error('Import cancelled. Type MERGE or REPLACE to continue.'); const result = await mergeVaultExport(selectedUsername, currentPassword.current, p, importPassword, choice.toLowerCase() === 'replace'); const refreshed = await readStoredNotes(selectedUsername, currentPassword.current); setNotes(refreshed); setDirty(false); setActive(refreshed[0]?.id || ''); setStatus(`Imported ${result.notes} notes and ${result.attachments} attachments (${choice.toLowerCase()})`); setImportFile(null); setImportPassword(''); } catch (e) { setError((e as Error).message || 'Could not import this backup.'); } finally { setBusy(false); if(file.current) file.current.value = ''; } }
 return <div className={dark ? 'app dark' : 'app'}><header className="top"><Link href="/" className="brand"><span className="logo"><Leaf size={21}/></span>cl<span>protext</span><span className="brand-dot">.</span></Link><span className="header-label">YOUR PERSONAL NOTEBOOK</span><div className="top-actions"><button className="icon" aria-label="Toggle dark mode" onClick={() => setDark(!dark)}>{dark ? <Sun size={18}/> : <Moon size={18}/>}</button>{unlocked && <><button className="quiet" disabled={busy || cloud.working} onClick={() => setChangePasswordOpen(true)}>Change password</button><button className="quiet" disabled={busy || cloud.working} onClick={lock}><LockKeyhole size={15}/> Lock</button></>}</div></header>
 {!unlocked ? <main className="welcome"><section className="intro"><div className="eyebrow"><span/> A LITTLE SPACE, JUST FOR YOU</div><h1>Your thoughts.<br/>Your space.<br/><em>Your peace of mind.</em></h1><p className="lead">A quiet home for the things on your mind.<br/>Write freely. Keep them close. Open them anywhere.</p><div className="promises"><span><ShieldCheck size={17}/>Encrypted in your browser</span><span><Cloud size={17}/>Optional encrypted cloud sync</span></div><div className="scribble">Less noise. More room to think. <span>â†—</span></div></section>   <section className="unlock-card">{!selectedUsername && <form className="username-form" onSubmit={e => { e.preventDefault(); const name = publicUsername.trim().toLowerCase(); if (/^[a-z0-9](?:[a-z0-9_-]{1,30}[a-z0-9])?$/.test(name)) { setSelectedUsername(name); setPublicUsername(name); } }}><label htmlFor="public-username">Choose a username</label><div><input id="public-username" value={publicUsername} onChange={e => setPublicUsername(e.target.value)} placeholder="Choose a username"  required /><button className="primary" type="submit">Continue</button></div></form>} {selectedUsername && <><h2>{exists ? 'Welcome back.' : 'Make yourself at home.'}</h2><p>One password. A personal home for all your notes.</p><form onSubmit={unlock}><label htmlFor="password">{exists ? 'Notebook password' : 'Create your notebook password'}</label><input id="password" type="password" autoComplete={exists ? 'current-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)} placeholder={exists ? 'Enter your password' : 'At least 12 characters'} required disabled={busy || cloud.working}/>{!exists && <><label htmlFor="confirm">Confirm password</label><input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="One more time" required disabled={busy || cloud.working}/><div className={`strength strength-${strength.score}`} role="status"><span className="strength-bars">{[1,2,3,4].map(level => <i key={level}/>)}</span><span>{strength.label}</span></div></>}<button className="primary unlock" disabled={busy || cloud.working || !loaded}> {busy ? 'Opening your spaceâ€¦' : !loaded ? 'Loading this notebookâ€¦' : exists ? 'Unlock my notebook' : 'Create my notebook'}<ArrowRight size={18}/></button></form><button type="button" className="quiet" disabled={busy || cloud.working || !loaded} onClick={openFromCloud}>Open cloud notebook with this password</button><p className="password-hint"><ShieldCheck size={15}/>Your password stays on this device. Keep it safe â€” it cannot be recovered.</p>{error && <div role="alert" className="error">{error} {!loaded && <button onClick={load}>Retry loading</button>}</div>} <div className="card-foot"><span className="tiny-dot"/> A private notebook. No distractions.</div></>}</section><div className="features"><div><span>01</span><h3>Write without the noise</h3><p>Ideas, lists, little reminders. Just you and the page.</p></div><div><span>02</span><h3>Keep your words yours</h3><p>Local by default. Cloud sync sends only encrypted snapshots.</p></div><div><span>03</span><h3>Take your space with you</h3><p>The same notebook, wherever you choose to open it.</p></div></div></main> : <main className="workspace"><aside><div className="sidebar-heading"><div> <div className="eyebrow">{selectedUsername}</div><h2>My notebook</h2></div><span className="count">{notes.length}</span></div><button className="primary new" disabled={busy || cloud.working} onClick={add}><Plus size={17}/>New note</button><div className="search"><Search size={16}/><input aria-label="Search notes" placeholder="Search your notes" value={query} onChange={e => setQuery(e.target.value)}/></div><div className="note-list">{notes.filter(n => (n.title+' '+n.text).toLowerCase().includes(query.toLowerCase())).map(n => <button disabled={busy || cloud.working} key={n.id} onClick={() => setActive(n.id)} className={'note-row '+(n.id === note.id ? 'selected' : '')}><FileText size={17}/><div><strong>{n.title || 'Untitled note'}</strong><span>{n.text.slice(0,65) || 'A little room for a new thought.'}</span></div></button>)}{!notes.some(n => (n.title+' '+n.text).toLowerCase().includes(query.toLowerCase())) && <p className="no-results">No matching notes.</p>}</div><div className="cloud-sync">
 <label><input type="checkbox" checked={cloud.enabled} disabled={busy || cloud.working} onChange={cloud.toggle}/> Sync to cloud</label>
 <p role="status">{cloud.enabled ? cloud.status : 'local only'}</p>
 {cloud.message && <p>{cloud.message}</p>}
 {cloud.enabled && cloud.status==='offline error' && <button type="button" className="quiet" disabled={busy || cloud.working} onClick={cloud.retry}>Retry sync</button>}
 {cloud.enabled && cloud.status==='conflict' && <div>
  <p>The other copy will be replaced. Export a backup before choosing.</p>
  <button className="quiet" disabled={busy || cloud.working} onClick={backup}>Export local backup first</button>
  <button className="quiet" disabled={busy || cloud.working || dirty} onClick={()=>void cloud.resolve('local')}>Keep local; replace cloud</button>
  <button className="quiet" disabled={busy || cloud.working || dirty} onClick={()=>void cloud.resolve('cloud')}>Load cloud; replace local</button>
 </div>}
 {cloud.enabled && <button className="quiet" disabled={busy || cloud.working || dirty} onClick={()=>void cloud.removeCloud()}>Delete cloud copy</button>}
</div><div className="backup-tools"><button disabled={busy || cloud.working} onClick={backup}><Download size={16}/>Export encrypted backup</button><button disabled={busy || cloud.working} onClick={() => file.current?.click()}><Upload size={16}/>Import encrypted backup</button><input ref={file} type="file" accept=".json" hidden onChange={e => { setImportFile(e.target.files?.[0] || null); setImportPassword(''); }}/><p><ShieldCheck size={14}/>Only encrypted notes leave your browser.</p><p className="backup-age">{backupLabel}{!lastBackupAt && ' · Create a backup soon'}</p></div></aside><section className="editor"><div className="editor-bar"><span className="save-status" role="status">{dirty ? <span className="unsaved-dot"/> : <Check size={15}/>} {busy ? 'Workingâ€¦' : status}</span><div><button className="icon" disabled={busy || cloud.working} aria-label="Delete current note" onClick={remove}><Trash2 size={17}/></button><button className="primary save" disabled={busy || cloud.working || !dirty} onClick={save}>Save changes<Cloud size={15}/></button></div></div>{error && <div role="alert" className="error">{error}</div>}{importFile && <form className="import-form" onSubmit={restore}><label htmlFor="import-password">Password for {importFile.name}</label><input id="import-password" type="password" autoComplete="off" value={importPassword} onChange={e => setImportPassword(e.target.value)} required/><button className="primary" disabled={busy || cloud.working}>Import notes</button><button type="button" className="quiet" disabled={busy || cloud.working} onClick={() => {setImportFile(null);setImportPassword('');}}>Cancel</button></form>} {changePasswordOpen && <form className="change-password" onSubmit={e => { e.preventDefault(); void changePassword(); }}><label htmlFor="new-password">New notebook password</label><input id="new-password" type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} autoComplete="new-password" required/><label htmlFor="new-password-confirm">Confirm new password</label><input id="new-password-confirm" type="password" value={newPasswordConfirm} onChange={e => setNewPasswordConfirm(e.target.value)} autoComplete="new-password" required/><div className="change-actions"><button className="primary" disabled={busy || cloud.working}>Change password</button><button type="button" className="quiet" disabled={busy || cloud.working} onClick={() => { setChangePasswordOpen(false); setNewPassword(''); setNewPasswordConfirm(''); }}>Cancel</button></div></form>} <div className="paper"><input className="note-title" aria-label="Note title" value={note.title} disabled={busy || cloud.working} onChange={e => edit({title:e.target.value})} placeholder="Untitled note"/><textarea aria-label="Note content" value={note.text} disabled={busy || cloud.working} onChange={e => edit({text:e.target.value})} placeholder="Start anywhere. This space is yours." spellCheck={false}/> <div className="attachment-tools"><button type="button" className="quiet" disabled={busy || cloud.working} onClick={() => attachmentInput.current?.click()}><Upload size={15}/>Upload File</button><input ref={attachmentInput} type="file" hidden onChange={attach}/><span>Max 5 MB</span></div>{note.attachments?.length ? <div className="attachments">{note.attachments.map(a => <div className="attachment" key={a.id}>{previewableImageTypes.has(a.type) ? <img src={a.dataUrl} alt={a.name}/> : <FileText size={18}/>}<a href={a.dataUrl} download={a.name} rel="noreferrer">{a.name}</a><span>{Math.ceil(a.size / 1024)} KB</span><button type="button" className="quiet" aria-label={`Remove ${a.name}`} disabled={busy || cloud.working} onClick={() => removeAttachment(a.id)}>Remove</button></div>)}</div> : null}</div><div className="editor-footer"><span>{note.text.trim() ? note.text.trim().split(/\s+/).length : 0} words Â· {note.text.length} characters</span><span>{dirty ? 'Save before leaving or locking' : 'Locks after 10 minutes of inactivity'}</span></div></section></main>}
 <footer className="footer"><span>clprotext. <span>A little more peace of mind.</span></span><span><LockKeyhole size={12}/>Personal by design.</span></footer></div>;
}
