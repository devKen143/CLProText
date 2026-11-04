import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTags, sortNotes, sidebarSelection, shortcutAction } from '../app/writing.ts';
import { mergeNotebooks, normalizeNotes } from '../app/merge-notebooks.ts';

test('comma separated tags are trimmed, case normalized, and deduplicated', () => {
 assert.deepEqual(parseTags(' Work, ideas, work, ,IDEAS, home '),['work','ideas','home']);
});
test('pinned notes sort first, then by edit time, excluding trash', () => {
 const notes=[{id:'new',title:'',text:'',updatedAt:20},{id:'pin',title:'',text:'',pinned:true,updatedAt:1},{id:'old',title:'',text:'',updatedAt:2},{id:'trash',title:'',text:'',pinned:true,deletedAt:'2026-01-01'}];
 assert.deepEqual(sortNotes(notes).map(n=>n.id),['pin','new','old']);assert.equal(notes[0].id,'new');
});
test('sidebar remains capped at 20 and retains selected matching result', () => {
 const notes=Array.from({length:35},(_,i)=>({id:String(i),title:'',text:''}));
 assert.equal(sidebarSelection(notes,'34').length,20);assert.equal(sidebarSelection(notes,'34').at(-1).id,'34');
 assert.equal(sidebarSelection(notes.slice(0,5),'34').length,5);
});
test('shortcuts respect typing, modifier keys, and save/lock exceptions', () => {
 assert.equal(shortcutAction('n',false,false,false,false),'new');
 assert.equal(shortcutAction('/',false,false,false,false),'search');
 assert.equal(shortcutAction('n',false,false,false,true),null);
 assert.equal(shortcutAction('/',false,false,false,true),null);
 assert.equal(shortcutAction('s',true,false,false,true),'save');
 assert.equal(shortcutAction('L',true,true,false,true),'lock');
 assert.equal(shortcutAction('n',true,false,false,false),null);
 assert.equal(shortcutAction('n',false,false,true,false),null);
});
test('pin and tag fields default safely and survive conflict copies', () => {
 const note={id:'one',title:'Title',text:'Text',updatedAt:'2026-01-01T00:00:00.000Z'};
 const normalized=normalizeNotes([note])[0];assert.equal(normalized.pinned,false);assert.deepEqual(normalized.tags,[]);
 const result=mergeNotebooks([{...note,pinned:true,updatedAt:'2026-01-02T00:00:00.000Z'}],[{...note,tags:['work'],updatedAt:'2026-01-02T00:00:00.000Z'}],{one:note.updatedAt});
 assert.equal(result.conflictCopies,1);assert.equal(result.notes[0].pinned,true);assert.deepEqual(result.notes[1].tags,['work']);
});
