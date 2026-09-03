import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  QIANMU_VIDEO_DRAFT_SCHEMA,
  compileVideoDraftSelection,
  createVideoDraftFromStoryboardFrame,
  normalizeVideoDraft,
  reviseVideoDraft,
  validateVideoDraft,
} from '../qianmu-video-draft.js';

const frame = (id = 'frame-a', extra = {}) => ({
  id,
  chatKey: 'chat-a',
  floor: 7,
  messageId: 'message-a',
  shotId: 'shot-a',
  url: 'data:image/png;base64,MUST_NOT_PERSIST',
  finalPrompt: 'MUST_NOT_PERSIST',
  ...extra,
});

test('a storyboard frame becomes a stable, media-free I2VA draft', () => {
  const draft = createVideoDraftFromStoryboardFrame(frame(), { now: 1000 });
  assert.equal(draft.schema, QIANMU_VIDEO_DRAFT_SCHEMA);
  assert.equal(draft.source.recordId, 'frame-a');
  assert.equal(draft.selection.firstRecordId, 'frame-a');
  assert.equal(draft.selection.lastRecordId, '');
  assert.equal(draft.settings.aspectRatio, 'adaptive');
  const compiled = compileVideoDraftSelection(draft, [frame()]);
  assert.equal(compiled.ok, true);
  assert.equal(compiled.readyForPrompt, true);
  assert.equal(compiled.readyForSubmission, false);
  assert.equal(compiled.spec.route.mode, 'i2va');
  assert.doesNotMatch(JSON.stringify(compiled), /MUST_NOT_PERSIST|data:image|finalPrompt|url/);
});

test('loop drafts reuse one frame for both endpoints without copying it', () => {
  const draft = createVideoDraftFromStoryboardFrame(frame(), { now: 1000, loop: true });
  const compiled = compileVideoDraftSelection(draft, [frame()]);
  assert.equal(compiled.spec.route.mode, 'fl2va');
  assert.equal(compiled.spec.route.ready, true);
  assert.equal(compiled.manifest.assets.length, 1);
  assert.deepEqual(compiled.manifest.assets[0].roles, ['first_frame', 'last_frame']);
});

test('reference selections route to Ref2VA while owner mismatches fail closed', () => {
  const base = createVideoDraftFromStoryboardFrame(frame(), { now: 1000 });
  const revised = reviseVideoDraft(base, {
    selection: {
      firstRecordId: '',
      referenceRecordIds: ['frame-b'],
      referenceRoles: { 'frame-b': ['style_reference'] },
      subjectLabels: { 'frame-b': '<Subject 1>' },
    },
    settings: { requestedMode: 'ref2va' },
  }, { now: 2000 });
  assert.equal(revised.ok, true);
  const missingSource = compileVideoDraftSelection(revised.draft, [frame('frame-b')]);
  assert.equal(missingSource.ok, false);
  assert.ok(missingSource.issues.includes('source_record_not_selected'));

  const draft = normalizeVideoDraft({
    ...revised.draft,
    source: { kind: 'blank', track: 'main_camera', recordId: '' },
  });
  const mismatched = compileVideoDraftSelection(draft, [frame('frame-b', { chatKey: 'chat-b' })]);
  assert.equal(mismatched.ok, false);
  assert.ok(mismatched.issues.includes('record_owner_mismatch:frame-b'));
  const compiled = compileVideoDraftSelection(draft, [frame('frame-b')]);
  assert.equal(compiled.ok, true);
  assert.equal(compiled.spec.route.mode, 'ref2va');
  assert.deepEqual(compiled.manifest.assets[0].roles, ['style_reference']);
});

test('draft revision keeps ownership immutable and strips unstable fields', () => {
  const draft = normalizeVideoDraft({
    owner: { chatKey: 'chat-a', floor: null },
    source: { kind: 'blank' },
    apiKey: 'private-key',
    prompt: 'hidden prompt',
    quote: { amount: 9 },
    media: new Uint8Array([1, 2, 3]),
  });
  assert.equal(draft.owner.floor, null);
  assert.equal(normalizeVideoDraft({ ...draft, owner: { ...draft.owner, floor: 0 } }).owner.floor, 0);
  assert.doesNotMatch(JSON.stringify(draft), /private-key|hidden prompt|quote|Uint8Array|apiKey/);
  const blocked = reviseVideoDraft(draft, { owner: { chatKey: 'chat-b' } }, { now: 2000 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.issue, 'draft_owner_immutable');
  assert.equal(blocked.draft.owner.chatKey, 'chat-a');
});

test('blank drafts stay valid for future text planning but never become submission-ready', () => {
  const draft = normalizeVideoDraft({
    owner: { chatKey: 'chat-a' },
    source: { kind: 'blank' },
    settings: { requestedMode: 't2va', durationSeconds: 6, resolution: '768p', aspectRatio: '16:9' },
  });
  assert.equal(validateVideoDraft(draft).ok, true);
  const compiled = compileVideoDraftSelection(draft, []);
  assert.equal(compiled.ok, true);
  assert.equal(compiled.spec.route.mode, 't2va');
  assert.equal(compiled.readyForSubmission, false);
});

test('the draft contract is an idle release chunk', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const release = JSON.parse(await readFile(new URL('../release-files.json', import.meta.url), 'utf8'));
  assert.match(source, /videoDraft:\s*\{[\s\S]*import\('\.\/qianmu-video-draft\.js\?v=1\.58\.69'\)/);
  assert.ok(release.files.includes('qianmu-video-draft.js'));
  const initSource = source.slice(source.indexOf('function init()'), source.indexOf('function destroy()'));
  assert.doesNotMatch(initSource, /featureRuntime\.load\('videoDraft'\)/);
});
