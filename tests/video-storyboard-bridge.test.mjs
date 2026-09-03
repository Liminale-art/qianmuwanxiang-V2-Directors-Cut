import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { adaptStoryboardShotToVideoShotSpec } from '../qianmu-video-contract.js';
import { compileVideoDraftSelection, createVideoDraftFromStoryboardFrame, reviseVideoDraft } from '../qianmu-video-draft.js';

const storyboardShot = {
  id: 'plan-shot-1',
  narrativePurpose: 'A enters while B continues cooking.',
  scene: 'A warm kitchen at night.',
  shotScale: 'medium_close_up',
  characters: [
    {
      id: 'a', name: 'A', identity: ['red hair'], outfit: ['coat removed', 'white shirt'],
      temporaryState: ['rain on shoulders'], expression: ['alert'], pose: ['one hand on door'],
      action: ['opens the door'], gaze: ['toward B'], spatial: { region: 'left', crop: 'waist' },
    },
    {
      id: 'b', name: 'B', identity: ['black hair'], outfit: ['blue apron'],
      temporaryState: ['flour on hands'], expression: ['calm'], pose: ['back half turned'],
      action: ['stirs the soup'], gaze: ['toward pot'], spatial: { region: 'right', crop: 'waist' },
    },
  ],
  composition: { ratioId: '2:3', angle: 'eye level', framing: ['A left, B right'], focus: 'rack from A to B' },
  promptAtoms: { camera: ['slow dolly in'], quality: ['soft cinematic light'], global: ['quiet domestic realism'] },
  continuityUpdates: {
    axis: 'camera stays on the hall side',
    actionState: { b: 'still stirring' },
    facts: [
      { subject: 'A', key: 'coat', value: 'removed', status: 'active' },
      { subject: 'B', key: 'old_pose', value: 'standing', status: 'superseded' },
    ],
  },
  apiKey: 'must-not-survive',
  imageUrl: 'https://example.invalid/secret.png',
};

test('a still storyboard shot becomes a bounded motion semantic base', () => {
  const spec = adaptStoryboardShotToVideoShotSpec(storyboardShot, { durationSeconds: 8, resolution: '768p' });
  assert.equal(spec.sourceShotId, 'plan-shot-1');
  assert.equal(spec.durationSeconds, 8);
  assert.equal(spec.aspectRatio, 'adaptive', 'unsupported still ratios should not be invented for H3');
  assert.equal(spec.camera.shotSize, 'MCU');
  assert.equal(spec.camera.axis, 'camera stays on the hall side');
  assert.deepEqual(spec.characters[0].appearance.identity, ['red hair']);
  assert.deepEqual(spec.characters[0].appearance.wardrobe, ['coat removed', 'white shirt']);
  assert.deepEqual(spec.characters[1].appearance.physicalState, ['flour on hands']);
  assert.equal(spec.characters[0].performance.action, 'opens the door');
  assert.equal(spec.characters[1].performance.action, 'stirs the soup');
  assert.match(spec.characters[0].performance.blocking, /left; waist; one hand on door/);
  assert.ok(spec.continuityLedger.requiredFacts.includes('A:coat:removed'));
  assert.ok(!spec.continuityLedger.requiredFacts.some((item) => item.includes('old_pose')));
  assert.doesNotMatch(JSON.stringify(spec), /must-not-survive|example\.invalid/);
});

test('dynamic drafts retain the originating plan shot id and hydrate its semantics only at compile time', () => {
  const record = {
    id: 'frame-1', planId: 'plan-1', planShotId: 'plan-shot-1', chatKey: 'chat-a', floor: 4,
    url: 'https://example.invalid/frame.png', shotSpec: storyboardShot,
  };
  const draft = createVideoDraftFromStoryboardFrame(record, { now: 100, clientNonce: 'bridge' });
  assert.equal(draft.source.sourceShotId, 'plan-shot-1');
  assert.equal(JSON.stringify(draft).includes('red hair'), false, 'heavy shot semantics must not be copied into draft storage');

  const revised = reviseVideoDraft(draft, { direction: 'A pauses before fully opening the door.' }, { now: 200 }).draft;
  const compiled = compileVideoDraftSelection(revised, [record], { sourceShot: record.shotSpec });
  assert.equal(compiled.ok, true);
  assert.equal(compiled.spec.intent.summary, 'A pauses before fully opening the door.');
  assert.equal(compiled.spec.intent.scene, 'A warm kitchen at night.');
  assert.equal(compiled.spec.characters.length, 2);
  assert.equal(compiled.spec.characters[0].appearance.wardrobe[0], 'coat removed');
  assert.equal(compiled.spec.characters[1].performance.action, 'stirs the soup');
  assert.equal(compiled.readyForSubmission, false);
  assert.doesNotMatch(JSON.stringify(compiled), /https:\/\/example\.invalid/);
});

test('legacy drafts without a source ShotSpec keep the original safe fallback', () => {
  const record = { id: 'legacy-frame', chatKey: 'chat-a', url: 'https://example.invalid/legacy.png' };
  const draft = createVideoDraftFromStoryboardFrame(record, { now: 300, clientNonce: 'legacy' });
  const compiled = compileVideoDraftSelection(draft, [record]);
  assert.equal(compiled.ok, true);
  assert.equal(compiled.spec.characters.length, 0);
  assert.equal(compiled.spec.route.mode, 'i2va');
  assert.equal(compiled.readyForSubmission, false);
});

test('the visible draft editor passes its source ShotSpec through the semantic bridge', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(source, /function storyboardVideoDraftSourceShot\([\s\S]*record\?\.shotSpec[\s\S]*return record\.shotSpec/);
  assert.match(source, /const sourceShot = storyboardVideoDraftSourceShot\(storyboardVideoDraftEditor\)/);
  assert.match(source, /compileVideoDraftSelection\(candidate, candidates, \{ sourceShot \}\)/);
});
