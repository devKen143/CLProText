'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LockKeyhole, ShieldCheck, Plus, Search, FileText, Download, Upload, Trash2, Moon, Sun, Leaf, Check, Cloud, ArrowRight, X, Pin, AlertCircle, Eye, EyeOff, RefreshCw, Copy, CircleCheck, Maximize, Minimize, Share2, ChevronDown } from 'lucide-react';
import { generatePassphrase } from './passphrase';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { encryptShare } from './share-crypto';
import { validShareId } from '../lib/share-contract';
import { sortNotes, sidebarSelection, shortcutAction } from './writing';
import { DEFAULT_KDF_ITERATIONS, encodeBase64, previewableImageTypes, type Note, type Envelope, type Attachment, type NoteShare, type Credential, unlockDataKey, rewrapPassword, rewrapRecovery } from './crypto';
import { createVault, exportVault, listAttachments, listNotes, mergeVaultExport, migrateLegacyLocalStorage, previewVaultExport, readHeader, unlockVaultAccess, migrateVaultKey, commitKeyEnvelope, updateHeader, type VaultExport, replaceNotebook, markSynced } from './storage';
import { deriveWriteToken, openCloud } from './sync-crypto';
import { normalizeUsername, validUsername } from '../lib/sync-contract';
import { findCloud, downloadCloud, writeCloud, sameNotebook, synchronizeNotebook, MergeError, publishKeyEnvelope, recoverLocalAccess } from './cloud-client';
import { saveHistory, restoreVersion, purgeNote, purgeExpiredNotes, restoreDeletedNote } from './note-lifecycle';
import { normalizeNotes } from './merge-notebooks';
import { installCloudNotebook, legacyLocalKey } from './storage';
export default function Home({ notebookUsername = '' }: { notebookUsername?: string }) {
 const [notes, setNotes] = useState<Note[]>([]), [active, setActive] = useState(''), [query, setQuery] = useState('');
 const [shareOpen, setShareOpen] = useState(false), [shareExpiry, setShareExpiry] = useState(86400), [burnShare, setBurnShare] = useState(false);
 const [focusMode, setFocusMode] = useState(false), [tagDraft, setTagDraft] = useState('');
 const focusButton = useRef<HTMLButtonElement>(null);
 const [tagFilter, setTagFilter] = useState(''), [previews, setPreviews] = useState<Record<string,boolean>>({});
 const searchInput = useRef<HTMLInputElement>(null), session = useRef(0), pendingLockSave = useRef<Promise<void> | null>(null);
 const shortcuts = useRef<(event: KeyboardEvent) => void>(() => {}), instantLock = useRef<() => void>(() => {});
 const [syncState, setSyncState] = useState<'local' | 'syncing' | 'synced' | 'conflict' | 'offline'>('local'), [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null), [displayNow, setDisplayNow] = useState(Date.now);
 const [loaded, setLoaded] = useState(false), [exists, setExists] = useState(false), [password, setPassword] = useState(''), [confirm, setConfirm] = useState('');
 const [showPassword, setShowPassword] = useState(false), [suggestion, setSuggestion] = useState(''), [copied, setCopied] = useState(false);
 const [publicUsername, setPublicUsername] = useState(normalizeUsername(notebookUsername));
 const [selectedUsername, setSelectedUsername] = useState(normalizeUsername(notebookUsername));
 const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState(''), [lastBackupAt, setLastBackupAt] = useState<string | null>(null), [dark, setDark] = useState(false), [changePasswordOpen, setChangePasswordOpen] = useState(false), [newPassword, setNewPassword] = useState(''), [newPasswordConfirm, setNewPasswordConfirm] = useState(''), [retryAfter, setRetryAfter] = useState(0);
 const key = useRef<CryptoKey | null>(null), currentPassword = useRef<Credential>(''), currentSalt = useRef(''), envelope = useRef<Envelope | null>(null), file = useRef<HTMLInputElement>(null), attachmentInput = useRef<HTMLInputElement>(null);
 const cloudVersion = useRef<number | null>(null), cloudIdentity = useRef('');
 const [recoveryMode, setRecoveryMode] = useState(false), [recoveryKey, setRecoveryKey] = useState(''), [recoveryConfirmation, setRecoveryConfirmation] = useState('');
 const [passwordScore, setPasswordScore] = useState<number | null>(null), [recoverySaved, setRecoverySaved] = useState<boolean | null>(null);
 const [lockSeconds, setLockSeconds] = useState<number | null>(null), [lockAnnouncement, setLockAnnouncement] = useState('');
 const resetInactivity = useRef<() => void>(() => {});
 const [trashOpen, setTrashOpen] = useState(false), [historyOpen, setHistoryOpen] = useState(false);
 const trashNotes = useMemo(() => notes.filter(n => n.deletedAt && !n.purgedAt), [notes]);
 const [mergeFailure, setMergeFailure] = useState<MergeError | null>(null);
 const failedUnlocks = useRef(0), blockedUntil = useRef(0);
 const unlocked = notes.length > 0;
 const suggestionKey = `${unlocked}|${loaded}|${exists}|${selectedUsername}`;
 const [seenSuggestionKey, setSeenSuggestionKey] = useState(suggestionKey);
 if (seenSuggestionKey !== suggestionKey) { setSeenSuggestionKey(suggestionKey); setShowPassword(false); setCopied(false); setSuggestion(!unlocked && loaded && !exists ? generatePassphrase() : ''); }
 useEffect(() => { if (!copied) return; const timer = window.setTimeout(() => setCopied(false),2000); return () => window.clearTimeout(timer); }, [copied]);
 async function copySuggestion() { try { await navigator.clipboard.writeText(suggestion); setCopied(true); } catch { setError('Could not copy. Select the suggested words to copy them.'); } }
 const note = notes.find(n => n.id === active && !n.deletedAt) || notes.find(n => !n.deletedAt);
 const [tagNoteId, setTagNoteId] = useState(note?.id);
 if (tagNoteId !== note?.id) { setTagNoteId(note?.id); setTagDraft(''); }
 function addTag() {
  if (!note || busy) return;
  const tag = tagDraft.trim().toLowerCase().slice(0,24), current = note.tags || [];
  if (tag && current.length < 8 && !current.includes(tag)) edit({tags:[...current,tag]});
  setTagDraft('');
 }
 function toggleTask(line: number) {
  if (!note || busy) return;
  const lines = note.text.split('\n'), original = lines[line-1];
  if (!original) return;
  lines[line-1] = original.replace(/^(\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[)([ xX])(\])/, (_,prefix,checked,suffix) => prefix+(checked === ' ' ? 'x' : ' ')+suffix);
  if (lines[line-1] !== original) edit({text:lines.join('\n')});
 }
 const [allNotesOpen, setAllNotesOpen] = useState(false), [allQuery, setAllQuery] = useState(''), [debouncedQuery, setDebouncedQuery] = useState(''), [visibleCount, setVisibleCount] = useState(200);
 useEffect(() => {
  if (!focusMode) return;
  const exit = (event: KeyboardEvent) => { if (event.key === 'Escape' && !allNotesOpen) { setFocusMode(false); focusButton.current?.focus(); } };
  window.addEventListener('keydown',exit); return () => window.removeEventListener('keydown',exit);
 }, [focusMode,allNotesOpen]);
 const allNotesTrigger = useRef<HTMLButtonElement>(null), allNotesDialog = useRef<HTMLDivElement>(null), allNotesSearch = useRef<HTMLInputElement>(null), allNotesList = useRef<HTMLDivElement>(null), editorInput = useRef<HTMLTextAreaElement>(null);
 const focusEditorOnClose = useRef(false), sidebarList = useRef<HTMLDivElement>(null);
 const sortedNotes = useMemo(() => sortNotes(notes), [notes]);
 const tags = useMemo(() => [...new Set(sortedNotes.flatMap(n => n.tags || []))].sort(), [sortedNotes]);
 const filteredNotes = useMemo(() => sortedNotes.filter(n => (!tagFilter || n.tags?.includes(tagFilter)) && (n.title+' '+n.text).toLowerCase().includes(query.toLowerCase())), [sortedNotes, query, tagFilter]);
 const sidebarNotes = useMemo(() => sidebarSelection(filteredNotes,note?.id || ''), [filteredNotes,note?.id]);
 useEffect(() => {
  const list = sidebarList.current, selected = list?.querySelector<HTMLElement>('.selected');
  if (!list || !selected) return;
  const listBounds = list.getBoundingClientRect(), selectedBounds = selected.getBoundingClientRect();
  const top = listBounds.top + list.clientTop, bottom = top + list.clientHeight;
  if (selectedBounds.top < top) list.scrollTop += selectedBounds.top - top;
  else if (selectedBounds.bottom > bottom) list.scrollTop += selectedBounds.bottom - bottom;
 }, [sidebarNotes]);
 const allMatchingNotes = useMemo(() => sortedNotes.filter(n => (!tagFilter || n.tags?.includes(tagFilter)) && (n.title+' '+n.text).toLowerCase().includes(debouncedQuery.toLowerCase())), [sortedNotes, debouncedQuery, tagFilter]);
 const [selecting, setSelecting] = useState(false), [picked, setPicked] = useState<string[]>([]);
 // Remembered per device. Reading storage can throw (private windows, server render), so default to open.
 const [healthOpen, setHealthOpen] = useState(() => { try { return window.localStorage.getItem('clprotext:vault-health') !== 'closed'; } catch { return true; } });
 function toggleHealth() { const next = !healthOpen; setHealthOpen(next); try { window.localStorage.setItem('clprotext:vault-health', next ? 'open' : 'closed'); } catch { /* preference only */ } }
 function closeAllNotes() { setAllNotesOpen(false); setAllQuery(''); setDebouncedQuery(''); setVisibleCount(200); setSelecting(false); setPicked([]); }
 function togglePicked(id: string) { setPicked(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]); }
 // Moves the selected notes to Trash, the same reversible delete as the single-note button.
 function trashPicked() {
  const ids = new Set(picked), count = notes.filter(n => ids.has(n.id) && !n.deletedAt).length;
  if (!count || busy) return;
  if (!window.confirm(`Move ${count} ${count === 1 ? 'note' : 'notes'} to Trash? You can restore them from Trash. Save the notebook to apply this change to the cloud.`)) return;
  const at = new Date().toISOString(), items = notes.map(n => ids.has(n.id) && !n.deletedAt ? { ...n, updatedAt: at, deletedAt: at } : n);
  if (!items.some(n => !n.deletedAt)) items.push({ id: crypto.randomUUID(), title: 'Untitled note', text: '', updatedAt: at });
  setNotes(items); if (!items.some(n => n.id === note?.id && !n.deletedAt)) setActive(items.find(n => !n.deletedAt)!.id);
  setDirty(true); setStatus('Unsaved changes'); setPicked([]); setSelecting(false);
 }
 function openAllNotes() { setAllQuery(query); setDebouncedQuery(query); setVisibleCount(200); setAllNotesOpen(true); }
 useEffect(() => {
  if (!allNotesOpen) return;
  const timer = window.setTimeout(() => { setDebouncedQuery(allQuery); setVisibleCount(200); allNotesList.current?.scrollTo(0, 0); }, 150);
  return () => window.clearTimeout(timer);
 }, [allQuery, allNotesOpen]);
 useEffect(() => {
  if (!allNotesOpen) return;
  const dialog = allNotesDialog.current, trigger = allNotesTrigger.current;
  if (!dialog) return;
  const previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  const background = Array.from(dialog.parentElement!.parentElement!.children).filter(element => element !== dialog.parentElement) as HTMLElement[];
  const previousInert = background.map(element => element.inert);
  background.forEach(element => { element.inert = true; });
  allNotesSearch.current?.focus();
  const onKeyDown = (event: KeyboardEvent) => {
   if (event.key === 'Escape') { event.preventDefault(); closeAllNotes(); }
   if (event.key !== 'Tab') return;
   const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]'));
   const first = focusable[0], last = focusable[focusable.length - 1];
   if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
   else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
  };
  const onFocus = (event: FocusEvent) => { if (!dialog.contains(event.target as Node)) allNotesSearch.current?.focus(); };
  document.addEventListener('keydown', onKeyDown); document.addEventListener('focusin', onFocus);
  return () => {
   document.removeEventListener('keydown', onKeyDown); document.removeEventListener('focusin', onFocus);
   document.body.style.overflow = previousOverflow;
   background.forEach((element, index) => { element.inert = previousInert[index]; });
   if (focusEditorOnClose.current) editorInput.current?.focus({ preventScroll: true }); else trigger?.focus({ preventScroll: true });
   focusEditorOnClose.current = false;
  };
 }, [allNotesOpen]);
 const [clockUnlocked, setClockUnlocked] = useState(unlocked);
 if (clockUnlocked !== unlocked) { setClockUnlocked(unlocked); if (unlocked) setDisplayNow(Date.now()); }
 useEffect(() => { if (!unlocked) return; const timer = window.setInterval(() => setDisplayNow(Date.now()),60000); return () => window.clearInterval(timer); }, [unlocked]);
 function relativeTime(value: Note['updatedAt']) {
  if (value === undefined) return '';
  const time = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(time) || time <= 0) return '';
  const minutes = Math.max(0,Math.floor((displayNow-time)/60000));
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes/60)}h ago` : `${Math.floor(minutes/1440)}d ago`;
 }
 function showSynced() { setSyncState('synced'); setLastSyncedAt(Date.now()); setDisplayNow(Date.now()); }
 async function trackNotebookSync(...args: Parameters<typeof synchronizeNotebook>) {
  const started = session.current; setSyncState('syncing');
  try { const result = await synchronizeNotebook(...args); if (started === session.current) showSynced(); return result; }
  catch (error) { if (started === session.current) setSyncState(error instanceof MergeError ? 'conflict' : 'offline'); throw error; }
 }
 const syncLabel = syncState === 'synced' && lastSyncedAt !== null ? `Encrypted \u00b7 Synced ${Math.max(0,Math.floor((displayNow-lastSyncedAt)/60000))} min ago` : syncState === 'syncing' ? 'Syncing\u2026' : syncState === 'conflict' ? 'Conflict' : syncState === 'offline' ? 'Offline' : 'Local only';
 const backupTime = lastBackupAt ? Date.parse(lastBackupAt) : NaN;
 const backupAgeDays = Number.isFinite(backupTime) && backupTime <= displayNow ? Math.floor((displayNow-backupTime)/(24*60*60*1000)) : null;
 const healthItems = [
  ...(passwordScore !== null ? [{label:'Strong password',done:passwordScore >= 3}] : []),
  ...(recoverySaved !== null ? [{label:'Recovery key saved',done:recoverySaved}] : []),
  ...(syncState !== 'local' || (cloudVersion.current ?? 0) > 0 ? [{label:'Cloud sync is up to date',done:syncState === 'synced' && !dirty}] : []),
  {label:'Backup',done:backupAgeDays !== null && displayNow-backupTime <= 30*24*60*60*1000},
 ];
 const healthDone = healthItems.filter(item => item.done).length;
 const wordCount = note?.text.trim() ? note.text.trim().split(/\s+/).length : 0;
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
 const [loadedUsername, setLoadedUsername] = useState(selectedUsername);
 if (loadedUsername !== selectedUsername) { setLoadedUsername(selectedUsername); setError(''); setLoaded(false); setExists(false); }
 const [reloadRequest, setReloadRequest] = useState(0);
 function load() { setError(''); setLoaded(false); setExists(false); cloudVersion.current = null; setReloadRequest(n => n + 1); }
 useEffect(() => {
  cloudVersion.current = null;
  if (!selectedUsername) return;
  // A slower lookup for a previous username must not report its result for the current one.
  let cancelled = false;
  void (async () => {
   try {
    if (!validUsername(selectedUsername)) throw new Error('Invalid username.');
    const header = await readHeader(selectedUsername);
    if (cancelled) return;
    const legacy = window.localStorage.getItem(legacyLocalKey(selectedUsername));
    envelope.current = legacy ? (JSON.parse(legacy) as { payload?: Envelope }).payload || null : null;
    const found = !!header || !!legacy || !!await findCloud(selectedUsername, true);
    if (cancelled) return;
    setExists(found); setLastBackupAt(header?.lastBackupAt || null); setLoaded(true);
   }
   catch (e) { if (!cancelled) setError((e as Error).message || 'Could not load this local notebook.'); }
  })();
  return () => { cancelled = true; };
 }, [selectedUsername,reloadRequest]);
 useEffect(() => { if (!retryAfter) return; const timer = window.setInterval(() => setRetryAfter(Math.max(0, blockedUntil.current - Date.now())), 250); return () => window.clearInterval(timer); }, [retryAfter]);
 useEffect(() => { const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
 async function readStoredNotes(username: string, password: Credential): Promise<Note[]> {
  const [stored, attachments] = await Promise.all([listNotes(username, password), listAttachments(username, password)]);
  const attachmentMap = new Map(attachments.map(attachment => [attachment.id, attachment]));
  return stored.map(item => ({
   id: item.id, title: item.title, text: item.text, payloadVersion: item.payloadVersion, updatedAt: item.updatedAt, deletedAt: item.deletedAt, history: item.history, purgedAt: item.purgedAt, pinned: item.pinned ?? false, tags: item.tags || [], shares: item.shares || [],
   attachments: item.attachmentIds.map(id => attachmentMap.get(id)).filter((a): a is NonNullable<typeof a> => !!a).map(a => ({
    id: a.id, name: a.name, type: a.type, size: a.size,
    dataUrl: `data:${a.type};base64,${encodeBase64(a.data)}`,
   })),
  }));
 }
 async function persist(items: Note[], password: Credential) {
  if (!selectedUsername) throw new Error('A username is required.');
  const started = session.current;
  await replaceNotebook(selectedUsername, password, normalizeNotes(items));
  if (started !== session.current) return;
  setExists(true); setDirty(false); setStatus('Saved on this device');
 }
 async function unlock(e: React.FormEvent) {
  e.preventDefault(); if (!loaded || busy) return; setBusy(true); setError('');
  try {
   await pendingLockSave.current;
   const wait = blockedUntil.current - Date.now();
   if (wait > 0) { setRetryAfter(wait); throw new Error(`Try again in ${Math.ceil(wait / 1000)} seconds.`); }
   if (!exists && recoveryMode) throw new Error('No notebook with recovery enabled was found.');
   if (!exists && (password.length < 12 || password !== confirm || strength.score < 3)) throw new Error('Use a strong password with at least 12 characters and matching confirmation.');
   let header = await readHeader(selectedUsername), credential: Credential = password;
   if (!header && envelope.current) {
    if (recoveryMode) throw new Error('Unlock once with your password to enable recovery.');
    await migrateLegacyLocalStorage(selectedUsername,password); header = await readHeader(selectedUsername);
   }
   if (!header) {
    const remote = await findCloud(selectedUsername);
    if (remote) {
     if (remote.blob.format === 3) credential = await unlockDataKey(remote.blob.keys!,password,recoveryMode);
     else if (recoveryMode) throw new Error('Unlock once with your password to enable recovery.');
     const items = await openCloud(remote.blob,credential,remote.cryptoUsername,remote.updatedAt);
     header = await installCloudNotebook(selectedUsername,credential,items,remote.blob);
     cloudVersion.current = remote.version; cloudIdentity.current = remote.cryptoUsername; showSynced();
    } else {
     if (exists) throw new Error('Cloud notebook was not found. Retry loading.');
     const initial = [{id:crypto.randomUUID(),title:'A fresh page',text:'',updatedAt:new Date().toISOString()}];
     cloudVersion.current = await writeCloud(selectedUsername,password,initial,0); cloudIdentity.current = selectedUsername;
     header = await createVault(selectedUsername,password); await persist(initial,password); await markSynced(selectedUsername,password,initial);
    }
   }
   if (header.keys) {
    try { credential = await unlockVaultAccess(selectedUsername,password,recoveryMode); }
    catch { credential = await recoverLocalAccess(selectedUsername,password,recoveryMode); }
   } else if (recoveryMode) throw new Error('Unlock once with your password to enable recovery.');
   let items = await readStoredNotes(selectedUsername,credential);
   if (!items.length) throw new Error('This notebook has no authenticated notes. Restore an encrypted backup.');
   failedUnlocks.current = 0;
   // Verify and merge before migrating, so devices adopt the same cloud data key.
   try {
    const remote = await findCloud(selectedUsername);
    if (remote) {
     if (remote.blob.format === 3) {
      let shared;
      if (typeof credential !== 'string') {
       try { await openCloud(remote.blob,credential,remote.cryptoUsername,remote.updatedAt); shared = {...credential,envelope:remote.blob.keys!}; }
       catch { shared = await unlockDataKey(remote.blob.keys!,password,recoveryMode); }
      } else shared = await unlockDataKey(remote.blob.keys!,password,recoveryMode);
      const migrated = await migrateVaultKey(selectedUsername,credential,undefined,shared,(done,total) => setStatus(`Upgrading encryption ${done}/${total}`));
      credential = migrated.access; header = (await readHeader(selectedUsername))!;
     }
     const cloudNotes = await openCloud(remote.blob,typeof credential !== 'string' && remote.blob.format !== 3 ? credential.legacyPassword || password : credential,remote.cryptoUsername,remote.updatedAt);
     if (sameNotebook(cloudNotes,items)) {
      await replaceNotebook(selectedUsername,credential,cloudNotes); await markSynced(selectedUsername,credential,cloudNotes); items = cloudNotes;
      cloudVersion.current = remote.version; cloudIdentity.current = remote.cryptoUsername; showSynced();
     } else {
      const merged = await trackNotebookSync(selectedUsername,credential,items,null,remote.cryptoUsername,next => { items = next; });
      items = merged.notes; cloudVersion.current = merged.version; cloudIdentity.current = merged.cryptoUsername; setStatus(merged.message);
     }
    } else { cloudVersion.current = 0; cloudIdentity.current = selectedUsername; }
   } catch (error) { cloudVersion.current = null; if (error instanceof MergeError) setMergeFailure(error); setSyncState(error instanceof MergeError ? 'conflict' : 'offline'); setError((error as Error).message); }
   setStatus('Preparing recovery protection...');
   const legacyToken = typeof credential === 'string' ? await deriveWriteToken(credential,cloudIdentity.current || selectedUsername) : undefined;
   const migrated = await migrateVaultKey(selectedUsername,credential,legacyToken,undefined,(done,total) => setStatus(`Upgrading encryption ${done}/${total}`));
   credential = migrated.access;
   let shownKey = migrated.recoveryKey;
   header = (await readHeader(selectedUsername))!;
   if (!shownKey && header.recoveryPending) {
    const next = await rewrapRecovery(credential), remote = await findCloud(selectedUsername);
    if (remote?.blob.format === 3) cloudVersion.current = await publishKeyEnvelope(selectedUsername,credential,next.envelope,true);
    else await commitKeyEnvelope(selectedUsername,credential,next.envelope,true);
    shownKey = next.recoveryKey;
   }
   const cleaned = purgeExpiredNotes(items,new Date().toISOString());
   if (cleaned.some((n,index) => n !== items[index])) await persist(cleaned,credential);
   currentPassword.current = credential; key.current = credential.key; currentSalt.current = credential.envelope.salt;
   setPasswordScore(recoveryMode ? null : passwordStrength(password).score); setRecoverySaved(shownKey ? false : !!header.keys && !header.recoveryPending);
   setNotes(cleaned); setActive(cleaned.find(n => !n.deletedAt)?.id || ''); setPassword(''); setConfirm(''); setRecoveryMode(false);
   setDirty(!!shownKey || cleaned.some((n,index) => n !== items[index]));
   setRecoveryKey(shownKey); setRecoveryConfirmation(''); setStatus(shownKey ? 'Save your recovery key to continue' : 'Notebook unlocked');
  } catch (e) {
   if (e instanceof DOMException && e.name === 'OperationError') { failedUnlocks.current++; blockedUntil.current = Date.now()+Math.min(15000,1000*2**Math.min(failedUnlocks.current-1,4)); setRetryAfter(blockedUntil.current-Date.now()); }
   setError(e instanceof DOMException ? 'Could not unlock. Check your password or recovery key.' : (e as Error).message);
  } finally { setBusy(false); }
 }
 async function confirmRecovery() { const started = session.current;
  if (busy || !recoveryKey || recoveryConfirmation.trim().toUpperCase() !== recoveryKey.split('-').at(-1)) return;
  const access = currentPassword.current; if (typeof access === 'string') return;
  setBusy(true); setError('');
  try {
   await commitKeyEnvelope(selectedUsername,access,access.envelope,false); setRecoverySaved(true); setRecoveryKey(''); setRecoveryConfirmation(''); setDirty(true);
   const result = await trackNotebookSync(selectedUsername,access,notes,cloudVersion.current,cloudIdentity.current,next => { if (started === session.current) setNotes(next); });
   cloudVersion.current=result.version; cloudIdentity.current=result.cryptoUsername; setDirty(false); setStatus(result.message);
  }
  catch (e) { if (started !== session.current) return; setError((e as Error).message); } finally { if (started === session.current) setBusy(false); }
 }
 async function regenerateRecovery() { const started = session.current;
  const access = currentPassword.current; if (typeof access === 'string' || busy) return;
  setBusy(true); setError('');
  try { const next = await rewrapRecovery(access); if (started !== session.current) return; cloudVersion.current = await publishKeyEnvelope(selectedUsername,access,next.envelope,true); if (started !== session.current) return; setRecoverySaved(false); setRecoveryKey(next.recoveryKey); setRecoveryConfirmation(''); }
  catch (e) { if (started !== session.current) return; setError((e as Error).message); } finally { if (started === session.current) setBusy(false); }
 }
 async function changePassword() { const started = session.current;
  if (!key.current || !notes.length) return;
  if (newPassword.length < 12 || newPassword !== newPasswordConfirm) { setError('Use at least 12 characters and make sure both new passwords match.'); return; }
  if (passwordStrength(newPassword).score < 3) { setError('Choose a stronger new password.'); return; }
  setBusy(true); setError('');
  try {
   const access = currentPassword.current;
   if (typeof access === 'string') throw new Error('Finish the recovery-key upgrade first.');
   const next = await rewrapPassword(access,newPassword); if (started !== session.current) return;
   cloudVersion.current = await publishKeyEnvelope(selectedUsername,access,next);
   if (started !== session.current) return;
   currentSalt.current = next.salt;
   setPasswordScore(passwordStrength(newPassword).score); setNewPassword(''); setNewPasswordConfirm(''); setChangePasswordOpen(false); setStatus('Password changed; encrypted notes and cloud access preserved');
  } catch (e) { if (started !== session.current) return; setError((e as Error).message || 'Could not change the password.'); } finally { if (started === session.current) setBusy(false); }
 }
 async function save(items = notes, historyPrepared = false) {
  if (!key.current || busy) return; setBusy(true); setError(''); setMergeFailure(null);
  const started = session.current, credential = currentPassword.current;
  try {
   const localWrite = (async () => {
    if (!historyPrepared) {
     const previous = new Map((await readStoredNotes(selectedUsername,credential)).map(n => [n.id,n]));
     const at = new Date().toISOString(); items = items.map(n => saveHistory(n,previous.get(n.id),at));
    }
    await replaceNotebook(selectedUsername,credential,normalizeNotes(items));
   })();
   pendingLockSave.current = localWrite.catch(() => {});
   await localWrite;
   if (started !== session.current) return;
   setNotes(items); setExists(true); setDirty(false); setStatus('Saved on this device');
   const result = await trackNotebookSync(selectedUsername,credential,items,cloudVersion.current,cloudIdentity.current,next => { if (started === session.current) setNotes(next); });
   if (started !== session.current) return;
   cloudVersion.current = result.version; cloudIdentity.current = result.cryptoUsername; setDirty(false); setStatus(result.message);
  } catch (e) { if (started !== session.current) return; cloudVersion.current = null; setDirty(true); if (e instanceof MergeError) setMergeFailure(e); setError((e as Error).message); } finally { if (started === session.current) setBusy(false); }
 }
 async function resolveMerge(choice: 'local' | 'cloud') { const started = session.current;
  if (!mergeFailure || busy || !key.current) return;
  if (!window.confirm(choice === 'local' ? 'Replace the cloud notebook with these local notes? Export a backup first.' : 'Replace local notes with the cloud notebook? Export a backup first.')) return;
  setBusy(true); setError('');
  try {
   const {notes: remote,snapshot} = await downloadCloud(selectedUsername,currentPassword.current);
   if (started !== session.current) return;
   const items = choice === 'cloud' ? remote : notes;
   // Compare-and-swap with the version shown when the fallback was offered.
   if (choice === 'local' && snapshot.version !== mergeFailure.snapshot.version) throw new Error('Cloud changed. Retry Save to merge the latest version first.');
   await replaceNotebook(selectedUsername,currentPassword.current,items); if (started !== session.current) return; setNotes(items);
   const version = choice === 'local' ? await writeCloud(selectedUsername,currentPassword.current,items,snapshot.version,snapshot.cryptoUsername) : snapshot.version;
   await markSynced(selectedUsername,currentPassword.current,items);
   cloudVersion.current = version; cloudIdentity.current = snapshot.cryptoUsername;
   setDirty(false); setMergeFailure(null); showSynced(); setStatus(choice === 'local' ? 'Saved local notebook to cloud' : 'Loaded cloud notebook');
  } catch (e) { if (started !== session.current) return; cloudVersion.current = null; setDirty(true); setError((e as Error).message); } finally { if (started === session.current) setBusy(false); }
 }
 function lock(force = false) {
  if (!force && dirty && !window.confirm('You have unsaved edits. Lock and discard them? Export a backup or save first to keep them.')) return;
  const credential = currentPassword.current, items = notes, username = selectedUsername;
  if (force && dirty && !busy && key.current) {
   pendingLockSave.current = (async () => {
    const previous = new Map((await readStoredNotes(username,credential)).map(n => [n.id,n]));
    const at = new Date().toISOString();
    await replaceNotebook(username,credential,items.map(n => saveHistory(n,previous.get(n.id),at)));
   })().catch(() => { setError('The notebook locked, but the last edits could not be saved on this device.'); });
  }
  session.current++; setFocusMode(false); setTagDraft(''); setPasswordScore(null); setRecoverySaved(null); setLockSeconds(null); setLockAnnouncement(''); setSyncState('local'); setLastSyncedAt(null);
  closeAllNotes(); setRecoveryKey(''); setRecoveryConfirmation(''); setTrashOpen(false); setHistoryOpen(false); setMergeFailure(null); setPreviews({}); setShareOpen(false); setTagFilter(''); setChangePasswordOpen(false); setNewPassword(''); setNewPasswordConfirm('');
  key.current = null; if (typeof credential !== 'string' && !busy) credential.rawKey.fill(0); currentPassword.current = ''; currentSalt.current = ''; setImportFile(null); setImportPassword(''); setNotes([]); setQuery(''); setDirty(false); setBusy(false); setStatus(''); void load();
 }
 useEffect(() => {
  instantLock.current = () => lock(true);
  shortcuts.current = event => {
   if (event.isComposing || event.repeat) return;
   const target = event.target as HTMLElement | null;
   const typing = !!target?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]');
   const action = shortcutAction(event.key,event.ctrlKey || event.metaKey,event.shiftKey,event.altKey,typing);
   if (action === 'lock') { event.preventDefault(); lock(true); return; }
   if (action === 'save') { event.preventDefault(); if (!recoveryKey) void save(); return; }
   if (busy || allNotesOpen || recoveryKey) return;
   if (action === 'new') { event.preventDefault(); add(); }
   if (action === 'search') { event.preventDefault(); searchInput.current?.focus(); }
  };
 });
 useEffect(() => {
  if (!unlocked) return;
  const handler = (event: KeyboardEvent) => shortcuts.current(event);
  window.addEventListener('keydown',handler); return () => window.removeEventListener('keydown',handler);
 }, [unlocked]);
 useEffect(() => {
  if (!unlocked) return;
  let hiddenAt: number | null = null, hiddenTimer: ReturnType<typeof setTimeout>;
  const visibility = () => {
   clearTimeout(hiddenTimer);
   if (document.hidden) { hiddenAt ??= Date.now(); hiddenTimer = setTimeout(() => instantLock.current(),Math.max(0,120000-(Date.now()-hiddenAt))); }
   else { if (hiddenAt !== null && Date.now()-hiddenAt >= 120000) instantLock.current(); hiddenAt = null; }
  };
  visibility(); document.addEventListener('visibilitychange',visibility);
  return () => { clearTimeout(hiddenTimer); document.removeEventListener('visibilitychange',visibility); };
 }, [unlocked]);
 useEffect(() => {
  if (!unlocked || recoveryKey) return;
  if (dirty || busy) return;
  let deadline = Date.now()+10*60*1000, announced = false;
  const reset = () => { deadline = Date.now()+10*60*1000; announced = false; setLockSeconds(null); setLockAnnouncement(''); };
  const tick = () => {
   const seconds = Math.max(0,Math.ceil((deadline-Date.now())/1000));
   if (!seconds) { instantLock.current(); return; }
   setLockSeconds(seconds <= 60 ? seconds : null);
   if (seconds <= 60 && !announced) { announced = true; setLockAnnouncement('Your notebook will lock in one minute. Stay unlocked to continue.'); }
  };
  resetInactivity.current = reset;
  const timer = window.setInterval(tick,1000);
  reset(); window.addEventListener('pointerdown',reset); window.addEventListener('keydown',reset);
  return () => { window.clearInterval(timer); resetInactivity.current = () => {}; window.removeEventListener('pointerdown',reset); window.removeEventListener('keydown',reset); };
 }, [unlocked,recoveryKey,dirty,busy]);
 function edit(patch: Partial<Note>) { if (!note) return; setNotes(notes.map(n => n.id === note.id ? { ...n, ...patch, updatedAt: new Date().toISOString() } : n)); setDirty(true); setStatus('Unsaved changes'); }
 function add() { setShareOpen(false); setTagFilter(''); setTrashOpen(false); setHistoryOpen(false); const n = { id: crypto.randomUUID(), title: 'Untitled note', text: '', updatedAt: new Date().toISOString() }; setNotes([...notes, n]); setActive(n.id); setQuery(''); setDirty(true); setStatus('Unsaved changes'); }
 function remove() {
  if (!note || !window.confirm('Delete this note? Save the notebook to apply this change to the cloud.')) return;
  const at = new Date().toISOString(), items = notes.map(n => n.id === note.id ? { ...n, updatedAt: at, deletedAt: at } : n);
  if (!items.some(n => !n.deletedAt)) items.push({ id: crypto.randomUUID(), title: 'Untitled note', text: '', updatedAt: at });
  setNotes(items); setActive(items.find(n => !n.deletedAt)!.id); setDirty(true); setStatus('Unsaved changes');
 }
 function shareLink(share: NoteShare) { return `${window.location.origin}/s/${share.id}#${share.key}`; }
 async function persistShareMetadata(items: Note[], credential: Credential) {
  const previous = new Map((await readStoredNotes(selectedUsername,credential)).map(n => [n.id,n]));
  const at = new Date().toISOString(), saved = items.map(n => saveHistory(n,previous.get(n.id),at));
  await replaceNotebook(selectedUsername,credential,normalizeNotes(saved));
  return saved;
 }
 async function createShare() {
  if (!note || busy || !key.current) return;
  const started=session.current, credential=currentPassword.current, selected=note;
  let created: NoteShare | undefined;
  setBusy(true);setError('');
  try {
   const encrypted=await encryptShare(selected);
   if(started!==session.current)return;
   const response=await fetch('/api/share',{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(20000),body:JSON.stringify({iv:encrypted.iv,data:encrypted.data,expiresIn:shareExpiry,burn:burnShare})});
   const data=await response.json() as {error?:string;id?:unknown;deleteToken?:unknown;expiresAt?:unknown;createdAt?:unknown};
   if(!response.ok)throw new Error(data?.error || 'Could not create share.');
   if(!data || typeof data.id!=='string' || !validShareId(data.id) || typeof data.deleteToken!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(data.deleteToken) || typeof data.expiresAt!=='number' || typeof data.createdAt!=='number')throw new Error('Invalid share response.');
   created={id:data.id,key:encrypted.key,deleteToken:data.deleteToken,expiresAt:data.expiresAt,createdAt:data.createdAt,burn:burnShare};
   if(started!==session.current) { await fetch(`/api/share/${created.id}`,{method:'DELETE',headers:{Authorization:`Bearer ${created.deleteToken}`}});return; }
   const items=notes.map(n=>n.id===selected.id ? {...n,updatedAt:new Date().toISOString(),shares:[...(n.shares || []),created!]} : n);
   const saving=persistShareMetadata(items,credential);pendingLockSave.current=saving.then(()=>{},()=>{});
   const saved=await saving;
   if(started!==session.current)return;
   setNotes(saved);setDirty(true);setStatus('Share created. Save changes to sync share management.');
  } catch(e) {
   if(created) {
    try { const revoked=await fetch(`/api/share/${created.id}`,{method:'DELETE',headers:{Authorization:`Bearer ${created.deleteToken}`}}); if(!revoked.ok)throw new Error(); }
    catch { if(started===session.current) { setNotes(notes.map(n=>n.id===selected.id ? {...n,shares:[...(n.shares || []),created!],updatedAt:new Date().toISOString()} : n));setDirty(true);setError('Share was created but could not be saved or revoked. Save changes to keep its management controls.');return; } }
   }
   if(started===session.current)setError((e as Error).message);
  } finally {if(started===session.current)setBusy(false);}
 }
 async function copyShare(share: NoteShare) {
  try {await navigator.clipboard.writeText(shareLink(share));setStatus('Share link copied');} catch {setError('Could not copy the link. Select and copy it from Manage share.');}
 }
 async function revokeShare(share: NoteShare) {
  if(busy || !note)return;
  const started=session.current,credential=currentPassword.current,id=note.id;
  setBusy(true);setError('');
  try {
   const response=await fetch(`/api/share/${share.id}`,{method:'DELETE',headers:{Authorization:`Bearer ${share.deleteToken}`},signal:AbortSignal.timeout(20000)});
   if(!response.ok && response.status!==404)throw new Error('Could not revoke the share. Retry.');
   const at=new Date().toISOString(),items=notes.map(n=>n.id===id ? {...n,updatedAt:at,shares:n.shares?.map(s=>s.id===share.id ? {...s,revokedAt:at} : s)} : n);
   const saving=persistShareMetadata(items,credential);pendingLockSave.current=saving.then(()=>{},()=>{});const saved=await saving;
   if(started!==session.current)return;
   setNotes(saved);setDirty(true);setStatus('Share revoked. Save changes to sync share management.');
  } catch(e) {if(started===session.current)setError((e as Error).message);} finally {if(started===session.current)setBusy(false);}
 }
 async function trashAction(id: string, forever: boolean) {
  const target = notes.find(n => n.id === id && n.deletedAt && !n.purgedAt);
  if (!target || busy) return;
  if (forever && !window.confirm('Delete this note and its history forever? This cannot be undone. Save will sync the deletion.')) return;
  const at = new Date().toISOString(), updated = forever ? purgeNote(target,at) : restoreDeletedNote(target,at);
  await save(notes.map(n => n.id === id ? updated : n));
  if (!forever) { setActive(id); setTrashOpen(false); }
 }
 async function restoreHistory(index: number) {
  if (!note || !note.history?.[index] || busy) return;
  const restored = restoreVersion(note,note.history[index],new Date().toISOString());
  await save(notes.map(n => n.id === note.id ? restored : n),true);
  setHistoryOpen(false);
 }
 async function attach(event: React.ChangeEvent<HTMLInputElement>) { const started = session.current;
  const selected = event.target.files?.[0];
  event.target.value = '';
  if (!selected || !note) return;
  if (selected.size > 5 * 1024 * 1024) { setError('Attachments must be 5 MB or smaller.'); return; }
  setBusy(true); setError('');
  try {
   const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read file.')); reader.onerror = () => reject(new Error('Could not read file.')); reader.readAsDataURL(selected); });
   if (started !== session.current) return;
   const type = selected.type || 'application/octet-stream';
   const attachment: Attachment = { id: crypto.randomUUID(), name: selected.name, type, size: selected.size, dataUrl };
   edit({ attachments: [...(note?.attachments || []), attachment] }); setStatus('Attachment added — save to keep it');
  } catch (e) { if (started !== session.current) return; setError((e as Error).message); } finally { if (started === session.current) setBusy(false); }
 }
 function removeAttachment(id: string) { edit({ attachments: (note?.attachments || []).filter(a => a.id !== id) }); }
 async function backup() { if (!key.current || !selectedUsername) return; setError(''); try { const p = await exportVault(selectedUsername, currentPassword.current); const url = URL.createObjectURL(new Blob([JSON.stringify(p)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'clprotext-' + new Date().toISOString().slice(0,10) + '.json'; a.click(); URL.revokeObjectURL(url); const backedUpAt = new Date().toISOString(); await updateHeader(selectedUsername, { lastBackupAt: backedUpAt }); setLastBackupAt(backedUpAt); setStatus('Encrypted backup downloaded'); } catch { setError('Backup failed. Please try again.'); } }
 const [importFile, setImportFile] = useState<File | null>(null), [importPassword, setImportPassword] = useState('');
 async function restore(e: React.FormEvent) { const started = session.current; e.preventDefault(); if (!importFile || !key.current || !selectedUsername) return; if (importFile.size > 10000000) { setError('Backup is too large.'); return; } setBusy(true); setError(''); try { const p = JSON.parse(await importFile.text()) as VaultExport; const preview = await previewVaultExport(p, importPassword); const choice = window.prompt(`Backup contains ${preview.notes.length} notes and ${preview.attachments.length} attachments. Type MERGE or REPLACE to apply.`); if (choice?.toLowerCase() !== 'merge' && choice?.toLowerCase() !== 'replace') throw new Error('Import cancelled. Type MERGE or REPLACE to continue.'); const result = await mergeVaultExport(selectedUsername, currentPassword.current, p, importPassword, choice.toLowerCase() === 'replace'); const refreshed = await readStoredNotes(selectedUsername, currentPassword.current); if (started !== session.current) return; setNotes(refreshed); setActive(refreshed[0]?.id || ''); setStatus(`Imported ${result.notes} notes and ${result.attachments} attachments (${choice.toLowerCase()})`); setImportFile(null); setImportPassword(''); } catch (e) { if (started !== session.current) return; setError((e as Error).message || 'Could not import this backup.'); } finally { if (started === session.current) setBusy(false); if(file.current) file.current.value = ''; } }
 if (recoveryKey) return <div className={dark ? 'app dark' : 'app'} style={{height:'100dvh',gridTemplateRows:'minmax(0,1fr)'}}><main className="welcome"><section className="unlock-card"><h2>Save your recovery key</h2><p>This key unlocks your notebook if you forget its password. Store it somewhere private. It is only shown here.</p><p style={{overflowWrap:'anywhere',fontFamily:'monospace',fontSize:18}}>{recoveryKey}</p><form onSubmit={e => { e.preventDefault(); void confirmRecovery(); }}><label htmlFor="recovery-confirm">Retype the last group to continue</label><input id="recovery-confirm" value={recoveryConfirmation} onChange={e => setRecoveryConfirmation(e.target.value)} autoComplete="off" autoFocus/><button type="submit" className="primary unlock" disabled={busy || recoveryConfirmation.trim().toUpperCase() !== recoveryKey.split('-').at(-1)}>I saved my recovery key</button></form>{error && <p role="alert" className="error">{error}</p>}</section></main></div>;
 // The logo must do a full page load: that is what clears the decrypted notebook from memory.
 // eslint-disable-next-line @next/next/no-html-link-for-pages
 return <div className={(dark ? 'app dark' : 'app')+(focusMode && unlocked ? ' focus-mode' : '')}><header className="top"><a href="/" className="brand"><span className="logo"><Leaf size={21}/></span>cl<span>protext</span><span className="brand-dot">.</span></a><div className="top-actions">{unlocked && <span className={`sync-pill sync-${syncState}`} role="status"><span className="sync-dot"/>{syncLabel}</span>}<button type="button" className="icon" aria-label="Toggle dark mode" onClick={() => setDark(!dark)}>{dark ? <Sun size={18}/> : <Moon size={18}/>}</button>{unlocked && <><button type="button" className="quiet" disabled={busy} onClick={() => setChangePasswordOpen(true)}>Change password</button><button type="button" className="outlined lock-button" disabled={busy} onClick={() => lock()}><LockKeyhole size={15}/> Lock</button></>}</div></header>
 {!unlocked ? <main className="welcome auth-stage"><section className="intro"><div className="eyebrow"><span/> A LITTLE SPACE, JUST FOR YOU</div><h1>Your thoughts.<br/>Your space.<br/><em>Your peace of mind.</em></h1><p className="lead">Notes are encrypted in your browser before they go anywhere. Only you hold the key.</p><h3 className="protection-label">HOW IT&apos;S PROTECTED</h3><div className="protection-card"><div><LockKeyhole size={22}/><strong>Your browser</strong><span>You write in plain text</span></div><div className="protection-arrow"><span>AES-256-GCM</span><ArrowRight size={22}/></div><div><Cloud size={22}/><strong>Cloud</strong><span>Stores only <code>9f3a&middot;c71e&middot;02bd</code></span></div></div></section><section className="unlock-card">{!selectedUsername && <form className="username-form" onSubmit={e => { e.preventDefault(); const name = normalizeUsername(publicUsername); if (validUsername(name)) { setSelectedUsername(name); setPublicUsername(name); } }}><h2>Your notebook starts here.</h2><label htmlFor="public-username">Username</label><div><input id="public-username" value={publicUsername} onChange={e => setPublicUsername(e.target.value)} placeholder="Choose a username" required/><button className="primary" type="submit">Continue</button></div></form>}{selectedUsername && <><div className="username-chip">@{selectedUsername}</div><h2>{!loaded ? 'Looking for your notebook…' : exists ? 'Welcome back.' : 'Make yourself at home.'}</h2><p>{loaded && !exists ? "Pick a password only you know. It can't be reset, so you'll get a recovery key next." : 'One password. A personal home for all your notes.'}</p>{loaded && <form onSubmit={unlock}><label htmlFor="password">{recoveryMode ? 'Recovery key' : exists ? 'Notebook password' : 'Create your notebook password'}</label><div className="password-field"><input id="password" type={showPassword ? 'text' : 'password'} autoComplete={recoveryMode ? 'off' : exists ? 'current-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)} placeholder={recoveryMode ? 'XXXX-XXXX-...' : exists ? 'Enter your password' : 'At least 12 characters'} required disabled={busy}/><button type="button" className="icon" disabled={busy} aria-pressed={showPassword} aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={18}/> : <Eye size={18}/>}</button></div>{!exists && <><div className={`strength strength-${strength.score}`} role="status"><span className="strength-bars">{[1,2,3,4].map(level => <i key={level}/>)}</span><span>{strength.label}</span></div><div className="passphrase-suggestion"><button type="button" className="icon" aria-label="New suggestion" disabled={busy} onClick={() => { setSuggestion(generatePassphrase()); setCopied(false); }}><RefreshCw size={17}/></button><code>{suggestion}</code><button type="button" className="quiet" disabled={busy || !suggestion} onClick={() => { setPassword(suggestion); setConfirm(suggestion); }}>Use</button><button type="button" className="icon" disabled={busy || !suggestion} aria-label="Copy suggested passphrase" onClick={copySuggestion}>{copied ? <Check size={17}/> : <Copy size={17}/>}</button><span className="sr-only" role="status">{copied ? 'Copied' : ''}</span></div><label htmlFor="confirm">Confirm password</label><input id="confirm" type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="One more time" required disabled={busy}/></>}<button type="submit" className="primary unlock" aria-busy={busy} disabled={busy || !loaded}>{busy ? <><span className="busy-ring" aria-hidden="true"/>{exists ? 'Unlocking…' : 'Deriving your key…'}</> : <>{exists ? 'Unlock my notebook' : 'Create my notebook'}<ArrowRight size={18}/></>}</button></form>}{exists && <button type="button" className="quiet" disabled={busy} onClick={() => { setRecoveryMode(!recoveryMode); setPassword(''); setShowPassword(false); }}>{recoveryMode ? 'Unlock with password' : 'Unlock with recovery key'}</button>}{busy && <p role="status">{status || 'Opening notebook...'}</p>}{loaded && !exists && <p className="password-hint">{DEFAULT_KDF_ITERATIONS.toLocaleString('en-US')} rounds of hashing, running on your device.</p>}<p className="password-hint"><ShieldCheck size={15}/>Your password stays on this device.</p>{error && <div role="alert" className="error"><AlertCircle size={18}/><div>{error}{!loaded && <button type="button" onClick={load}>Retry loading</button>}</div></div>}</>}</section></main> : <main className="workspace"><aside><div className="sidebar-heading"><div> <div className="username-chip">@{selectedUsername}</div><h2>My notebook</h2></div><span className="count">{sortedNotes.length}</span></div><button type="button" className="primary new" disabled={busy} onClick={add}><Plus size={17}/>New note</button><div className="search"><Search size={16}/><input ref={searchInput} aria-label="Search notes" placeholder="Search your notes" value={query} onChange={e => setQuery(e.target.value)}/><kbd aria-hidden="true">/</kbd></div><div style={{display:'flex',alignItems:'center',gap:6,marginTop:8}}><select id="tag-filter" aria-label="Filter by tag" value={tagFilter} onChange={e => setTagFilter(e.target.value)} style={{background:'var(--surface)',color:'var(--text)',border:'1px solid var(--line)',padding:6,borderRadius:6,minWidth:0,flex:1}}><option value="">All tags</option>{tags.map(tag => <option key={tag} value={tag}>{tag}</option>)}</select><button type="button" className="quiet" aria-pressed={trashOpen} onClick={() => setTrashOpen(!trashOpen)}>{trashOpen ? 'Back to notes' : `Trash (${trashNotes.length})`}</button></div><div className="recent-label">{trashOpen ? 'TRASH' : 'PINNED & RECENT'}</div>{trashOpen ? <div className="note-list">{trashNotes.map(n => <div className="note-row" key={n.id}><div><strong>{n.pinned && <Pin size={12} aria-label="Pinned"/>} {n.title || 'Untitled note'}</strong><span>{n.text.slice(0,65)}</span><button type="button" className="quiet" disabled={busy} onClick={() => trashAction(n.id,false)}>Restore</button><button type="button" className="quiet" disabled={busy} onClick={() => trashAction(n.id,true)}>Delete forever</button></div></div>)}{!trashNotes.length && <p className="no-results">Trash is empty.</p>}</div> : <div ref={sidebarList} className="note-list">{sidebarNotes.map(n => <button type="button" disabled={busy} key={n.id} onClick={() => setActive(n.id)} className={'note-row '+(n.id === note?.id ? 'selected' : '')}><span className="note-icon"><FileText size={17}/></span><div className="note-copy"><strong>{n.pinned && <Pin size={12} aria-label="Pinned"/>} {n.title || 'Untitled note'}</strong><span>{n.text.slice(0,65) || 'A little room for a new thought.'}</span></div>{relativeTime(n.updatedAt) && <time className="note-time" dateTime={new Date(n.updatedAt!).toISOString()}>{relativeTime(n.updatedAt)}</time>}</button>)}{!filteredNotes.length && <p className="no-results">No matching notes.</p>}</div>}{!trashOpen && ((query || tagFilter) ? filteredNotes.length : sortedNotes.length) > 0 && <button type="button" ref={allNotesTrigger} className="quiet view-all" onClick={openAllNotes}>{(query || tagFilter) ? `View all results (${filteredNotes.length})` : `View all (${sortedNotes.length})`}<ArrowRight size={16}/></button>}<section className="vault-health" aria-labelledby="vault-health-title"><div className="health-heading"><h3 id="vault-health-title"><button type="button" className="health-toggle" aria-expanded={healthOpen} aria-controls="vault-health-list" onClick={toggleHealth}>Vault health<ChevronDown size={16} aria-hidden="true"/></button></h3><span className="count">{healthDone} of {healthItems.length}</span></div><div className="health-progress" role="progressbar" aria-label="Vault health" aria-valuemin={0} aria-valuemax={healthItems.length} aria-valuenow={healthDone}><span style={{width:`${healthDone/healthItems.length*100}%`}}/></div><ul id="vault-health-list" hidden={!healthOpen}>{healthItems.map(item => <li key={item.label} className={item.done ? 'health-done' : 'health-todo'}>{item.done ? <CircleCheck size={18} aria-hidden="true"/> : <AlertCircle size={18} aria-hidden="true"/>}<span><span className="sr-only">{item.done ? 'Done: ' : 'To do: '}</span>{item.label === 'Backup' && !item.done ? !lastBackupAt ? 'No backup yet' : backupAgeDays !== null ? `Last backup ${backupAgeDays}d ago` : 'Backup' : item.label}</span>{item.label === 'Backup' && !item.done && <button type="button" className="quiet" disabled={busy} onClick={backup}>Export now</button>}</li>)}</ul></section><div className="backup-tools">{mergeFailure && <div role="alert"><p>Automatic merge failed. Export a backup before choosing.</p><button type="button" disabled={busy} onClick={() => resolveMerge('local')}>Keep local</button><button type="button" disabled={busy} onClick={() => resolveMerge('cloud')}>Load cloud</button></div>}<button type="button" disabled={busy} onClick={backup}><Download size={16}/>Export encrypted backup</button><button type="button" disabled={busy} onClick={() => file.current?.click()}><Upload size={16}/>Import encrypted backup</button><input ref={file} type="file" accept=".json" hidden onChange={e => { setImportFile(e.target.files?.[0] || null); setImportPassword(''); }}/><p className="privacy-line"><ShieldCheck size={14}/>Only encrypted notes leave your browser.</p></div></aside>{note && <section className="editor"><div className="editor-bar"><span className={'save-status '+(dirty ? 'is-dirty' : '')} role="status">{dirty ? <><span className="unsaved-dot"/>Unsaved changes<small> &middot; Encrypted on this device</small></> : <><CircleCheck size={18}/>{syncState === 'synced' ? 'Saved \u00b7 Synced' : 'Saved on this device'}</>}</span><div><button type="button" ref={focusButton} className="quiet" aria-pressed={focusMode} onClick={() => setFocusMode(!focusMode)}>{focusMode ? <Minimize size={16}/> : <Maximize size={16}/>}{focusMode ? 'Exit focus' : 'Focus'}</button><button type="button" className="outlined" aria-expanded={shareOpen} disabled={busy} onClick={() => setShareOpen(!shareOpen)}><Share2 size={16}/>{note.shares?.length ? 'Manage share' : 'Share'}</button><button type="button" className="icon" disabled={busy} aria-label="Delete current note" onClick={remove}><Trash2 size={18}/></button>{dirty && <button type="button" className="primary save" disabled={busy} onClick={() => save()}>Save changes<Cloud size={16}/></button>}</div></div>{status && <span className="sr-only" role="status">{status}</span>}{error && <div role="alert" className="error">{error}</div>}{importFile && <form className="import-form" onSubmit={restore}><label htmlFor="import-password">Password for {importFile.name}</label><input id="import-password" type="password" autoComplete="off" value={importPassword} onChange={e => setImportPassword(e.target.value)} required/><button type="submit" className="primary" disabled={busy}>Import notes</button><button type="button" className="quiet" disabled={busy} onClick={() => {setImportFile(null);setImportPassword('');}}>Cancel</button></form>} {changePasswordOpen && <form className="change-password" onSubmit={e => { e.preventDefault(); void changePassword(); }}><label htmlFor="new-password">New notebook password</label><input id="new-password" type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} autoComplete="new-password" required/><label htmlFor="new-password-confirm">Confirm new password</label><input id="new-password-confirm" type="password" value={newPasswordConfirm} onChange={e => setNewPasswordConfirm(e.target.value)} autoComplete="new-password" required/><div className="change-actions"><button type="button" className="quiet" disabled={busy} onClick={regenerateRecovery}>Regenerate recovery key</button><button type="submit" className="primary" disabled={busy}>Change password</button><button type="button" className="quiet" disabled={busy} onClick={() => { setChangePasswordOpen(false); setNewPassword(''); setNewPasswordConfirm(''); }}>Cancel</button></div></form>} {shareOpen && <section className="change-password" aria-label="Manage share"><h3>Share this note</h3><p className="no-results">Shares contain the current title and text only. Attachments are excluded.</p><label htmlFor="share-expiry">Expires after</label><select id="share-expiry" value={shareExpiry} onChange={e => setShareExpiry(Number(e.target.value))} disabled={busy} style={{background:'var(--surface)',color:'var(--text)',padding:8,border:'1px solid var(--line)'}}><option value={3600}>1 hour</option><option value={86400}>1 day</option><option value={604800}>7 days</option></select><label style={{display:'flex',alignItems:'center',gap:8}}><input type="checkbox" style={{width:'auto'}} checked={burnShare} disabled={busy} onChange={e => setBurnShare(e.target.checked)}/>Burn after reading</label><button type="button" className="primary" disabled={busy} onClick={createShare}>Create encrypted link</button>{note.shares?.map(share => <div key={share.id} style={{marginTop:16,borderTop:'1px solid var(--line)',paddingTop:12}}><p className="no-results">{share.revokedAt ? 'Revoked' : share.expiresAt<=Date.now() ? 'Expired' : `Expires ${new Date(share.expiresAt).toLocaleString()}`}{share.burn ? ' \u00b7 One-time link' : ''}</p>{!share.revokedAt && share.expiresAt>Date.now() && <><input aria-label="Share link" readOnly value={shareLink(share)} onFocus={e => e.currentTarget.select()}/><button type="button" className="quiet" disabled={busy} onClick={() => copyShare(share)}>Copy link</button><button type="button" className="quiet" disabled={busy} onClick={() => revokeShare(share)}>Revoke</button></>}</div>)}</section>} {historyOpen && <section className="change-password" aria-label="Note history"><h3>History</h3>{!note.history?.length && <p className="no-results">No saved versions yet.</p>}{note.history?.map((version,index) => <details key={`${version.at}-${index}`}><summary>{new Date(version.at).toLocaleString()} &middot; {version.title || 'Untitled note'}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 200, overflowY: 'auto' }}>{version.text}</pre><button type="button" className="quiet" disabled={busy} onClick={() => restoreHistory(index)}>Restore this version</button></details>)}</section>} <div className="paper"><input className="note-title" aria-label="Note title" value={note.title} disabled={busy} onChange={e => edit({title:e.target.value})} placeholder="Untitled note"/><div className="note-meta">{relativeTime(note.updatedAt) && <>Edited {relativeTime(note.updatedAt)} &middot; </>}{wordCount} words</div><div className="note-header-controls"><button type="button" className={note.pinned ? 'pinned-chip pin-toggle' : 'quiet pin-toggle'} aria-label={note.pinned ? 'Unpin note' : 'Pin note'} aria-pressed={!!note.pinned} disabled={busy} onClick={() => edit({pinned:!note.pinned})}><Pin size={14}/>{note.pinned ? 'Pinned' : 'Pin'}</button>{note.tags?.map(tag => <span className="tag-chip" key={tag}>#{tag}<button type="button" className="icon" aria-label={`Remove tag ${tag}`} disabled={busy} onClick={() => edit({tags:note.tags?.filter(value => value !== tag)})}><X size={12}/></button></span>)}<input className="tag-input" aria-label="Add tag" placeholder="+ tag" maxLength={24} value={tagDraft} disabled={busy || (note.tags?.length || 0) >= 8} onChange={e => setTagDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); addTag(); } }}/><div className="preview-switch" role="tablist" aria-label="Editor view"><button id="note-edit-tab" type="button" role="tab" aria-selected={!previews[note.id]} aria-controls="note-edit-panel" className="quiet" onClick={() => setPreviews({...previews,[note.id]:false})}>Edit</button><button id="note-preview-tab" type="button" role="tab" aria-selected={!!previews[note.id]} aria-controls="note-preview-panel" className="quiet" onClick={() => setPreviews({...previews,[note.id]:true})}>Preview</button></div></div><button type="button" className="quiet note-history" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>History</button>{previews[note.id] && <div id="note-preview-panel" role="tabpanel" aria-labelledby="note-preview-tab" aria-label="Markdown preview" style={{flex:1,overflowWrap:'anywhere'}}><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{a:({node,...props}) => <a {...props} target="_blank" rel="noopener noreferrer"/>,input:() => null,li:({node,children,...props}) => { const line = node?.position?.start.line; const source = line ? note.text.split('\n')[line-1] : ''; const task = source?.match(/^\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+\[([ xX])\]/); return <li {...props}>{task && line && <input type="checkbox" aria-label={`Toggle task on line ${line}`} checked={task[1] !== ' '} disabled={busy} onChange={() => toggleTask(line)}/>} {children}</li>; }}}>{note.text}</ReactMarkdown></div>}<textarea id="note-edit-panel" role="tabpanel" aria-labelledby="note-edit-tab" hidden={!!previews[note.id]} ref={editorInput} aria-label="Note content" value={note.text} disabled={busy} onChange={e => edit({text:e.target.value})} placeholder="Start anywhere. This space is yours." spellCheck={false}/> <div className="attachment-tools"><div><strong>Attach a file or image. Encrypted before it is saved.</strong><span>Max 5 MB</span></div><button type="button" className="outlined" disabled={busy} onClick={() => attachmentInput.current?.click()}><Upload size={16}/>Upload file</button><input ref={attachmentInput} type="file" hidden onChange={attach}/></div>{note.attachments?.length ? <div className="attachments">{note.attachments.map(a => <div className="attachment" key={a.id}>{previewableImageTypes.has(a.type) ? <img src={a.dataUrl} alt={a.name}/> : <FileText size={18}/>}<a href={a.dataUrl} download={a.name} rel="noreferrer">{a.name}</a><span>{Math.ceil(a.size / 1024)} KB</span><button type="button" className="quiet" aria-label={`Remove ${a.name}`} onClick={() => removeAttachment(a.id)}>Remove</button></div>)}</div> : null}</div><div className="editor-footer"><span>{note.text.trim() ? note.text.trim().split(/\s+/).length : 0} words · {note.text.length} characters</span><span className={'lock-status'+(lockSeconds !== null && !dirty && !busy ? ' lock-countdown' : '')}>{lockSeconds !== null && !dirty && !busy ? <><svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><circle className="countdown-track" cx="13" cy="13" r="10"/><circle className="countdown-arc" cx="13" cy="13" r="10" pathLength="60" strokeDasharray={`${lockSeconds} 60`} transform="rotate(-90 13 13)"/></svg>Locks in {Math.floor(lockSeconds/60)}:{String(lockSeconds%60).padStart(2,'0')}<button type="button" className="outlined" onClick={() => resetInactivity.current()}>Stay unlocked</button></> : <><LockKeyhole size={13}/>{dirty ? 'Save before leaving or locking' : 'Locks after 10 minutes of inactivity'}</>}</span><span className="sr-only" aria-live="polite">{dirty || busy ? '' : lockAnnouncement}</span></div></section>}{!note && <section className="editor"><div className="editor-bar"><span className="save-status" role="status">{status}</span><button type="button" className="primary" disabled={busy} onClick={add}>New note</button><button type="button" className="quiet" disabled={busy} onClick={() => save()}>Retry sync</button></div>{error && <div role="alert" className="error">{error}</div>}</section>}</main>}
 {unlocked && allNotesOpen && <div className="notes-backdrop" onClick={e => { if (e.target === e.currentTarget) closeAllNotes(); }}><div ref={allNotesDialog} className="notes-dialog" role="dialog" aria-modal="true" aria-labelledby="all-notes-title"><div className="notes-dialog-header"><div><h2 id="all-notes-title">All notes ({sortedNotes.length})</h2><button type="button" className="icon" aria-label="Close" onClick={closeAllNotes}><X size={22}/></button></div><div className="search"><Search size={16}/><input ref={allNotesSearch} autoFocus aria-label="Search all notes" placeholder="Search all notes" value={allQuery} onChange={e => setAllQuery(e.target.value)}/></div><div className="notes-actions">{selecting ? <><span className="notes-picked" role="status">{picked.length} selected</span><button type="button" className="quiet" disabled={!allMatchingNotes.length} onClick={() => setPicked(allMatchingNotes.every(n => picked.includes(n.id)) ? [] : allMatchingNotes.map(n => n.id))}>{allMatchingNotes.length > 0 && allMatchingNotes.every(n => picked.includes(n.id)) ? 'Clear selection' : `Select all (${allMatchingNotes.length})`}</button><button type="button" className="outlined danger" disabled={busy || !picked.length} onClick={trashPicked}><Trash2 size={15}/>Move to trash</button><button type="button" className="quiet" onClick={() => { setSelecting(false); setPicked([]); }}>Cancel</button></> : <button type="button" className="quiet" disabled={busy} onClick={() => setSelecting(true)}>Select notes</button>}</div></div><div ref={allNotesList} className="notes-dialog-body" onScroll={e => { const list = e.currentTarget; if (list.scrollHeight - list.scrollTop - list.clientHeight < 200) setVisibleCount(count => Math.min(count + 200, allMatchingNotes.length)); }}><div className="notes-grid">{allMatchingNotes.slice(0, visibleCount).map(n => <button type="button" disabled={busy} className={'note-row '+(selecting ? (picked.includes(n.id) ? 'picked' : '') : n.id === note?.id ? 'selected' : '')} key={n.id} aria-pressed={selecting ? picked.includes(n.id) : undefined} onClick={() => { if (selecting) { togglePicked(n.id); return; } setTagFilter(''); setActive(n.id); setPreviews(current => ({...current,[n.id]:false})); setQuery(''); focusEditorOnClose.current = true; closeAllNotes(); }}>{selecting ? <span className="pick-box" aria-hidden="true">{picked.includes(n.id) && <Check size={13}/>}</span> : <FileText size={17}/>}<div><strong>{n.pinned && <Pin size={12} aria-label="Pinned"/>} {n.title || 'Untitled note'}</strong><span>{n.text.slice(0,150) || 'A little room for a new thought.'}</span></div></button>)}</div>{!allMatchingNotes.length && <p className="no-results" role="status">No matching notes.</p>}{visibleCount < allMatchingNotes.length && <button type="button" className="quiet" onClick={() => setVisibleCount(count => count + 200)}>Load more notes</button>}</div></div></div>}
 <footer className="footer"><span>clprotext. <span>A little more peace of mind.</span></span><span><LockKeyhole size={12}/>Personal by design.</span></footer></div>;
}
