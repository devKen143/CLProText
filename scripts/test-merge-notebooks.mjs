import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeNotebooks, normalizeNotes, lastSyncedSnapshot, noteTimestamp } from '../app/merge-notebooks.ts';

const t0 = '2026-01-01T00:00:00.000Z', t1 = '2026-01-02T00:00:00.000Z', t2 = '2026-01-03T00:00:00.000Z';
const original = { id: 'one', title: 'Note', text: 'Original', updatedAt: t0 };
const base = { one: t0 };
const changed = (text, at = t1) => ({ ...original, text, updatedAt: at });

test('one-sided edits take the changed side', () => {
 for (const [local, cloud] of [[[changed('Local')], [original]], [[original], [changed('Cloud')]]]) {
  const result = mergeNotebooks(local, cloud, base);
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0].text, local[0].text === 'Original' ? 'Cloud' : 'Local');
  assert.equal(result.conflictCopies, 0);
 }
});
test('both edited: local stays and cloud becomes a conflict copy without mutating inputs', () => {
 const local = Object.freeze([Object.freeze(changed('Local'))]), cloud = Object.freeze([Object.freeze(changed('Cloud', t2))]);
 const result = mergeNotebooks(local, cloud, base);
 assert.equal(result.conflictCopies, 1);
 assert.equal(result.notes[0].id, 'one'); assert.equal(result.notes[0].text, 'Local');
 assert.equal(result.notes[1].title, 'Note (conflict copy)'); assert.equal(result.notes[1].text, 'Cloud');
 assert.notEqual(result.notes[1].id, 'one');
 assert.deepEqual(mergeNotebooks(local, cloud, base), result);
});
test('newer deletion wins against unchanged note on either side', () => {
 const deleted = { ...original, updatedAt: t1, deletedAt: t1 };
 for (const [local, cloud] of [[[deleted], [original]], [[original], [deleted]]]) {
  const result = mergeNotebooks(local, cloud, base);
  assert.equal(result.notes.length, 1); assert.equal(result.notes[0].deletedAt, t1);
 }
});
test('delete versus edit preserves the edit in either direction', () => {
 const deleted = { ...original, updatedAt: t1, deletedAt: t1 };
 const edited = changed('Concurrent edit', t2);
 for (const [local, cloud] of [[[deleted], [edited]], [[edited], [deleted]]]) {
  const result = mergeNotebooks(local, cloud, base);
  assert.equal(result.conflictCopies, 1); assert.equal(result.notes.length, 2);
  assert(result.notes.some(n => !n.deletedAt && n.text === 'Concurrent edit'));
  assert.equal(result.notes[1].title, 'Note (conflict copy)');
 }
});
test('stale tombstone cannot delete a newer unchanged note', () => {
 const result = mergeNotebooks([{ ...original, deletedAt: t0 }], [changed('Current', t2)], { one: t2 });
 assert.equal(result.notes[0].text, 'Current'); assert.equal(result.notes[0].deletedAt, undefined);
});
test('new on both: different IDs are combined, same ID keeps both differing notes', () => {
 assert.equal(mergeNotebooks([original], [{ ...original, id: 'two' }], {}).notes.length, 2);
 assert.equal(mergeNotebooks([changed('Local')], [changed('Cloud')], {}).conflictCopies, 1);
 assert.equal(mergeNotebooks([original], [original], {}).notes.length, 1);
});
test('legacy missing records are not interpreted as deletions', () => {
 assert.equal(mergeNotebooks([], [original], base).notes.length, 1);
 assert.equal(mergeNotebooks([original], [], base).notes.length, 1);
});
test('timestamps upgrade from numeric or missing using notebook updatedAt', () => {
 const notes = normalizeNotes([{ id: 'old', title: '', text: '' }, { ...original, updatedAt: Date.parse(t1) }], t0);
 assert.equal(notes[0].updatedAt, t0); assert.equal(notes[1].updatedAt, t1);
 assert.equal(notes[0].payloadVersion, 5);
 assert.deepEqual(lastSyncedSnapshot(notes), { old: t0, one: t1 });
 assert.equal(noteTimestamp(0, t0), t0);
 assert.throws(() => normalizeNotes([{ ...original, updatedAt: 'invalid' }]));
 assert.throws(() => normalizeNotes([original, original]));
 assert.throws(() => normalizeNotes([{ ...original, payloadVersion: 99 }]));
});
test('conflict attachments have separate IDs and a retry does not duplicate copies', () => {
 const attachment = { id: 'file', name: 'file.txt', type: 'text/plain', size: 1, dataUrl: 'data:text/plain;base64,YQ==' };
 const local = [{ ...changed('Local'), attachments: [attachment] }];
 const cloud = [{ ...changed('Cloud', t2), attachments: [{ ...attachment, dataUrl: 'data:text/plain;base64,Yg==' }] }];
 const result = mergeNotebooks(local, cloud, base);
 assert.notEqual(result.notes[0].attachments[0].id, result.notes[1].attachments[0].id);
 const retried = mergeNotebooks(result.notes, cloud, base);
 assert.equal(retried.notes.length, 2); assert.equal(retried.conflictCopies, 0);
});
test('timestamp collisions and missing baselines preserve different content', () => {
 assert.equal(mergeNotebooks([original], [{ ...original, text: 'Different' }], base).conflictCopies, 1);
 assert.equal(mergeNotebooks([original], [changed('Remote')], {}).conflictCopies, 1);
});
