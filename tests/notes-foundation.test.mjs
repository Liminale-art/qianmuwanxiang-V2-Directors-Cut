import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  clearTemporaryQianmuNotes,
  createQianmuNote,
  deleteQianmuNote,
  listQianmuNotes,
  normalizeQianmuNote,
  saveQianmuNote,
} from '../qianmu-notes.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const storeSource = await readFile(new URL('../qianmu-blobstore.js', import.meta.url), 'utf8');

const clipped = normalizeQianmuNote({ id: 'n', title: 'a'.repeat(150), body: 'b'.repeat(21000), width: 10, height: 900 });
assert.equal(clipped.title.length, 120, 'legacy note titles remain bounded during migration');
assert.equal(clipped.body.length, 20000, 'note bodies must remain bounded');

clearTemporaryQianmuNotes();
const temporary = createQianmuNote({ body: 'temporary ST note', pinned: false });
await saveQianmuNote(temporary);
assert.ok((await listQianmuNotes()).some((note) => note.id === temporary.id));
await deleteQianmuNote(temporary.id);
assert.ok(!(await listQianmuNotes()).some((note) => note.id === temporary.id));

assert.match(storeSource, /DB_VERSION = 6[\s\S]*STORE_NOTES = 'notes'/, 'notes keep an isolated database store');
assert.match(storeSource, /STORE_NOTES.*recoverable: false/, 'pinned notes must not enter safe cleanup');
assert.match(source, /id: 'notes', label: '便笺'[\s\S]*qm-regular-note-pencil/, 'the hive owns a local bundled note icon');
assert.match(source, /function bindNotesHiveDetachDrag[\s\S]*noteSettings\.detached = true/, 'dragging the hive cell out detaches the entry itself');
assert.match(source, /noteSettings\.appearance = \{[\s\S]*hiveTone[\s\S]*hiveEdgeIndex/, 'detaching must preserve the source hive cell tone and edge choice');
assert.match(source, /sd-detached-notes-entry[\s\S]*noteSettings\.detached = false/, 'dropping the detached entry into Qianmu returns it to the hive');
assert.match(source, /notesPanelOpen\) return[\s\S]*sd-detached-notes-entry/, 'the detached entry stays hidden while its page is open');
assert.match(source, /sd-detached-notes-entry[\s\S]*QUICK_HEX_BORDER_SVG/, 'the detached entry must retain the complete hive-cell shape');
assert.doesNotMatch(source, /sd-notes-global-entry|sd-note-title|sd-note-float/, 'the obsolete permanent entry, title field, and per-note floating control must stay removed');
assert.match(source, /sd-note-tools-toggle[\s\S]*sd-note-copy[\s\S]*sd-note-pin[\s\S]*sd-note-delete/, 'row actions belong to the compact more menu');
assert.match(styles, /\.sd-notes-panel[\s\S]*background: var\(--sd-notes-surface\)/, 'the notes page must use an opaque theme surface');
assert.match(styles, /#qianmu-notes-float-layer[\s\S]*z-index: 2147483002/, 'the detached hive cell must sit above the Qianmu panel but below critical overlays');
assert.match(styles, /\.sd-detached-notes-entry[\s\S]*clip-path: polygon\(50% 0,[\s\S]*sd-hive-hex-outline/, 'the detached entry must keep the hive hexagon silhouette and edge');
assert.doesNotMatch(styles, /\.sd-floating-note\b/, 'individual notes must never become top-level floating windows');
assert.doesNotMatch(source, /QianmuNote[\s\S]{0,120}applyDirectorInjection/, 'notes must never enter director prompt injection');

console.log('Notes foundation contract OK');
