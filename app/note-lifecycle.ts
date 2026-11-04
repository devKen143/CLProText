import type { Note, NoteVersion } from './crypto';

export function saveHistory(note: Note, previous: Note | undefined, at: string, force = false): Note {
 if (!previous || note.deletedAt || (!force && note.title === previous.title && note.text === previous.text)) return note;
 const history = note.history || [], last = history[history.length - 1];
 if (!force && last && Date.parse(at) - Date.parse(last.at) <= 5 * 60 * 1000) return note;
 return { ...note, history: [...history, { title: previous.title, text: previous.text, at }].slice(-5) };
}
export function restoreVersion(note: Note, version: NoteVersion, at: string): Note {
 return saveHistory({ ...note, title: version.title, text: version.text, updatedAt: at }, note, at, true);
}
export function purgeNote(note: Note, at: string): Note {
 if (!note.deletedAt || note.purgedAt) return note;
 // Retain only the deletion marker so an offline device cannot resurrect the content.
 return { id: note.id, title: '', text: '', updatedAt: at, deletedAt: note.deletedAt, purgedAt: at, payloadVersion: 3 };
}
export function purgeExpiredNotes(notes: Note[], at: string): Note[] {
 return notes.map(note => note.deletedAt && Date.parse(at) - Date.parse(note.deletedAt) > 30 * 86400000 ? purgeNote(note, at) : note);
}
export function restoreDeletedNote(note: Note, at: string): Note {
 if (note.purgedAt) throw new Error('This note was permanently deleted.');
 const { deletedAt, ...rest } = note;
 void deletedAt;
 return { ...rest, updatedAt: at };
}
