import test from 'node:test';
import assert from 'node:assert/strict';
import { captureNotesRefresh, mergeNotesRefresh } from '../qianmu-notes-panel-sync.js';

const note = (id, body = 'before', localRevision = 1) => ({ id, body, title: '', pinned: false, localRevision, revision: 1, _notesAccount: 'st-user:fixture' });

test('late read cannot roll back an acknowledged edit after the editor loses focus', () => {
  const local = note('a'), baseline = captureNotesRefresh([local]);
  Object.assign(local, { body: 'last acknowledged input', localRevision: 2 });
  const merged = mergeNotesRefresh([local], [note('a')], baseline);
  assert.equal(merged[0], local); assert.equal(local.body, 'last acknowledged input'); assert.equal(local.localRevision, 2);
});

test('older stored revision is rejected even when local write completed before read began', () => {
  const local = note('a', 'newer', 4);
  const merged = mergeNotesRefresh([local], [note('a', 'older', 3)], captureNotesRefresh([local]));
  assert.equal(merged[0], local); assert.equal(local.body, 'newer');
});

test('creation and deletion during a read are preserved while unrelated incoming changes merge', () => {
  const removed = note('removed'), unchanged = note('unchanged');
  const baseline = captureNotesRefresh([removed, unchanged]);
  const added = note('new-local', 'created during read');
  const merged = mergeNotesRefresh([unchanged, added], [note('removed'), note('unchanged', 'remote edit', 2), note('new-remote')], baseline);
  assert.deepEqual(merged.map(item => item.id).sort(), ['new-local', 'new-remote', 'unchanged']);
  assert.equal(merged.find(item => item.id === 'new-local'), added);
  assert.equal(merged.find(item => item.id === 'unchanged'), unchanged);
  assert.equal(unchanged.body, 'remote edit');
});

test('unchanged remote deletion is applied but pending or focused text is retained', () => {
  const removed = note('removed'), pending = note('pending'), focused = note('focused');
  const before = [removed, pending, focused];
  const merged = mergeNotesRefresh(before, [], captureNotesRefresh(before), new Set(['pending', 'focused']));
  assert.deepEqual(merged, [pending, focused]);
});

test('unsaved edits without a new revision are not overwritten or removed by late reads', () => {
  const edited = note('edited'), missing = note('missing'), baseline = captureNotesRefresh([edited, missing]);
  edited.body = 'pending'; missing.pinned = true;
  const merged = mergeNotesRefresh([edited, missing], [note('edited', 'remote', 8)], baseline);
  assert.equal(merged[0], edited); assert.equal(edited.body, 'pending'); assert.equal(merged[1], missing);
});
