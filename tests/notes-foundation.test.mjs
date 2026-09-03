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

assert.match(storeSource, /DB_VERSION = 14[\s\S]*STORE_NOTES = 'notes'/, 'notes keep an isolated database store');
assert.match(storeSource, /STORE_NOTES.*recoverable: false/, 'pinned notes must not enter safe cleanup');
assert.match(source, /id: 'notes', label: '便笺'[\s\S]*qm-regular-note-pencil/, 'the hive owns a local bundled note icon');
assert.match(source, /function bindNotesHiveDetachDrag[\s\S]*noteSettings\.detached = true/, 'dragging the hive cell out detaches the entry itself');
assert.match(source, /noteSettings\.appearance = \{[\s\S]*hiveTone[\s\S]*hiveEdgeIndex/, 'detaching must preserve the source hive cell tone and edge choice');
assert.match(source, /sd-detached-notes-entry[\s\S]*noteSettings\.detached = false/, 'dropping the detached entry into Qianmu returns it to the hive');
assert.match(source, /notesPanelOpen\) return[\s\S]*sd-detached-notes-entry/, 'the detached entry stays hidden while its page is open');
assert.match(source, /sd-detached-notes-entry[\s\S]*QUICK_HEX_BORDER_SVG/, 'the detached entry must retain the complete hive-cell shape');
assert.doesNotMatch(source, /sd-notes-global-entry|sd-note-title|sd-note-float/, 'the obsolete permanent entry, title field, and per-note floating control must stay removed');
assert.match(source, /sd-note-tools-toggle[\s\S]*sd-note-copy[\s\S]*sd-note-pin[\s\S]*sd-note-delete/, 'row actions belong to the compact more menu');
assert.match(source, /sd-notes-search-row[\s\S]*sd-notes-search[\s\S]*sd-note-new/, 'new note belongs beside search on the list page');
assert.match(source, /is-editor[\s\S]*sd-note-new[\s\S]*sd-notes-list/, 'new note must sit before the list control in the editor');
assert.match(source, /function detachedNotesGeometry\(\)[\s\S]*getFloatSize\(\)/, 'detached notes must follow the configured hive size');
assert.match(source, /closeNoteTools[\s\S]*sd-notes-stage[\s\S]*addEventListener\('click'/, 'clicking outside the more toggle closes row actions');
assert.match(source, /function openNotesPanel\(\)[\s\S]*notesPanelOpen = true;[\s\S]*renderNotesPanelPortal\(\)/, 'opening notes must mount its own page layer');
const openNotesPanel = source.slice(source.indexOf('function openNotesPanel()'), source.indexOf('function closeNotesPanel()'));
assert.doesNotMatch(openNotesPanel, /openModal|renderModal/, 'opening notes must not open or rebuild the Qianmu main panel');
assert.match(source, /function renderNotesPanel\(\)[\s\S]*aria-modal="false"/, 'the notes workspace must remain non-modal so ST stays usable');
assert.match(source, /function renderNotesPanelPortal\(\)[\s\S]*document\.body\.appendChild\(layer\)/, 'notes must live in an independent body portal');
assert.match(source, /function qianmuDockingSurfaceBusy\(\)[\s\S]*\[role="dialog"\]\[aria-modal="true"\][\s\S]*function detachedNoteCanReturnHome/, 'docking must be disabled while another modal or panel is active');
assert.match(source, /function detachedNoteCanReturnHome[\s\S]*getElementById\(FLOAT_ID\)[\s\S]*noteRect\.left >= logoRect\.left[\s\S]*noteRect\.right <= logoRect\.right/, 'a detached note must be fully placed over the real Qianmu logo before returning home');
assert.match(source, /pinned \? '便笺已保存'/, 'pinning a note confirms durable storage');
assert.match(styles, /\.sd-notes-panel[\s\S]*background: var\(--sd-notes-surface\)/, 'the notes page must use an opaque theme surface');
assert.match(styles, /#qianmu-notes-panel-layer \.sd-notes-panel \{[\s\S]*width: min\(60vw,[\s\S]*height: min\(60vh,/, 'desktop notes use the compact sixty-percent workspace');
assert.match(styles, /\.sd-note-pinned-mark,[\s\S]*\.sd-note-tools-toggle,[\s\S]*width: 28px; height: 28px/, 'pin state and more control must occupy the same visual slot');
assert.match(styles, /\.sd-note-item-tools \{[\s\S]*border: 0;[\s\S]*background: transparent/, 'the expanded more menu remains visually unboxed');
assert.match(source, /layer\.onpointerdown = isolateFromHostMenus;[\s\S]*layer\.onclick = isolateFromHostMenus;/, 'the independent notes page must not bubble clicks into ST menu dismiss handlers');
assert.match(source, /entry\.addEventListener\('pointerdown',[\s\S]*event\.stopPropagation\(\)[\s\S]*entry\.addEventListener\('click',[\s\S]*event\.stopPropagation\(\)/, 'the detached note entry must remain usable above an open ST menu');
assert.match(styles, /#qianmu-notes-panel-layer \{[\s\S]*position: fixed !important;[\s\S]*height: 100dvh !important;[\s\S]*transform: none !important;/, 'the note workspace must anchor to the mobile viewport instead of an ST container');
assert.match(styles, /@media \(max-width: 620px\)[\s\S]*#qianmu-notes-panel-layer \.sd-notes-stage \{[\s\S]*place-items: center !important;/, 'narrow notes remain centered');
assert.match(styles, /#qianmu-notes-float-layer[\s\S]*z-index: 2147483002/, 'the detached hive cell must sit above the Qianmu panel but below critical overlays');
assert.match(styles, /\.sd-detached-notes-entry[\s\S]*clip-path: polygon\(50% 0,[\s\S]*sd-hive-hex-outline/, 'the detached entry must keep the hive hexagon silhouette and edge');
assert.doesNotMatch(styles, /\.sd-floating-note\b/, 'individual notes must never become top-level floating windows');
assert.doesNotMatch(source, /QianmuNote[\s\S]{0,120}applyDirectorInjection/, 'notes must never enter director prompt injection');

console.log('Notes foundation contract OK');
