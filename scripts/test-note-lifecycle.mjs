import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saveHistory, restoreVersion, purgeNote, purgeExpiredNotes, restoreDeletedNote } from '../app/note-lifecycle.ts';
import { mergeNotebooks, normalizeNotes } from '../app/merge-notebooks.ts';
const at = '2026-02-01T00:00:00.000Z';
const note = { id:'one', title:'Title', text:'Before', updatedAt:'2026-01-01T00:00:00.000Z' };
test('save records previous content only when title or text changes', () => {
 assert.equal(saveHistory(note,note,at),note);
 assert.equal(saveHistory({...note,attachments:[]},note,at).history,undefined);
 assert.deepEqual(saveHistory({...note,text:'After'},note,at).history,[{title:'Title',text:'Before',at}]);
 assert.equal(saveHistory({...note,title:'New'},note,at).history.length,1);
});
test('history is limited to five and throttled to more than five minutes', () => {
 const history=Array.from({length:5},(_,i)=>({title:'Old',text:String(i),at:`2026-01-01T00:0${i}:00.000Z`}));
 const current={...note,history,text:'After'};
 assert.equal(saveHistory(current,note,'2026-01-01T00:09:00.000Z').history.length,5);
 const next=saveHistory(current,note,at);
 assert.equal(next.history.length,5);assert.equal(next.history[0].text,'1');assert.equal(next.history[4].text,'Before');
 const recent={...note,history:[{title:'Old',text:'Previous',at}]};
 assert.equal(saveHistory({...recent,text:'Edited'},recent,'2026-02-01T00:04:00.000Z').history.length,1);
});
test('restore always captures current content, including unsaved text and recent history', () => {
 const current={...note,text:'Unsaved',history:[{title:'Old',text:'Older',at}]};
 const restored=restoreVersion(current,current.history[0],at);
 assert.equal(restored.text,'Older');assert.equal(restored.history.at(-1).text,'Unsaved');assert.equal(restored.updatedAt,at);
 assert.equal(restoreVersion(current,{title:current.title,text:current.text,at},at).history.length,2);
});
test('trash restores content, while permanent deletion scrubs it and prevents restore', () => {
 const deleted={...note,deletedAt:'2026-01-02T00:00:00.000Z',history:[{title:'Old',text:'Secret',at}],attachments:[{id:'file'}]};
 assert.equal(restoreDeletedNote(deleted,at).deletedAt,undefined);
 assert.equal(restoreDeletedNote(deleted,at).text,'Before');
 const purged=purgeNote(deleted,at);
 assert.equal(purged.text,'');assert.equal(purged.title,'');assert.equal(purged.history,undefined);assert.equal(purged.attachments,undefined);
 assert.equal(purged.purgedAt,at);assert.throws(()=>restoreDeletedNote(purged,at));assert.equal(deleted.text,'Before');
});
test('unlock cleanup purges only trash older than 30 days', () => {
 const old={...note,deletedAt:'2026-01-01T00:00:00.000Z'};
 const boundary={...note,id:'boundary',deletedAt:'2026-01-02T00:00:00.000Z'};
 const [first,second,third]=purgeExpiredNotes([old,boundary,note],at);
 assert.equal(first.purgedAt,at);assert.equal(second,boundary);assert.equal(third,note);
 assert.equal(purgeExpiredNotes([first],at)[0],first);
});
test('purged markers prevent stale cloud resurrection; history survives concurrent edits', () => {
 const deleted={...note,deletedAt:'2026-01-02T00:00:00.000Z'};
 const purged=purgeNote(deleted,at);
 assert.equal(mergeNotebooks([purged],[note],{}).notes[0].purgedAt,at);
 assert.equal(mergeNotebooks([note],[purged],{}).notes[0].purgedAt,at);
 const local=saveHistory({...note,text:'Local',updatedAt:at},note,at);
 const cloud=saveHistory({...note,text:'Cloud',updatedAt:at},note,at);
 const merged=mergeNotebooks([local],[cloud],{one:note.updatedAt});
 assert.equal(merged.conflictCopies,1);assert.equal(merged.notes[0].history[0].text,'Before');assert.equal(merged.notes[1].history[0].text,'Before');
});
test('version 3 payload validation preserves history and rejects invalid entries', () => {
 const result=normalizeNotes([{...note,history:[{title:'Previous',text:'Text',at}]}]);
 assert.equal(result[0].payloadVersion,5);assert.equal(result[0].history.length,1);
 assert.throws(()=>normalizeNotes([{...note,history:[{title:'Previous',text:'Text',at:'bad'}]}]));
});
