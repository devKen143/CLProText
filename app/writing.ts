import type { Note } from './crypto';

export function parseTags(value: string): string[] {
 return [...new Set(value.split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean))];
}
export function sortNotes(notes: Note[]): Note[] {
 const time = (value: Note['updatedAt']) => typeof value === 'number' ? value : value ? Date.parse(value) : 0;
 return notes.filter(note => !note.deletedAt).sort((a,b) => Number(!!b.pinned) - Number(!!a.pinned) || time(b.updatedAt) - time(a.updatedAt));
}
export function sidebarSelection(notes: Note[], active: string): Note[] {
 const selected = notes.find(n => n.id === active), visible = notes.slice(0,20);
 if (selected && !visible.includes(selected)) visible.splice(19,1,selected);
 return visible;
}
export function shortcutAction(key: string, command: boolean, shift: boolean, alt: boolean, typing: boolean) {
 if (alt) return null;
 const value = key.toLowerCase();
 if (command) return value === 's' && !shift ? 'save' : value === 'l' && shift ? 'lock' : null;
 if (typing || shift) return null;
 return value === 'n' ? 'new' : value === '/' ? 'search' : null;
}
