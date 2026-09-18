import assert from 'node:assert/strict';
import test from 'node:test';
import { createQianmuPhase1Fixture, installQianmuMemoryFixture } from './helpers/qianmu-memory-fixture.mjs';

test('phase 1 fixture is deterministic and contains ordered floors and a sequence collection', () => {
  const fixture = createQianmuPhase1Fixture({ id: 'phase1-contract' });
  assert.equal(fixture.id, 'phase1-contract');
  assert.deepEqual(fixture.floors.map(row => row.floor), [0, 1, 2]);
  assert.deepEqual(fixture.entries.map(row => row.extra.floor), [0, 1, 2]);
  assert.deepEqual(fixture.layer.storyboardImages.map(row => row.floor), [0, 1, 2]);
  assert.deepEqual(fixture.layer.storyboardCollections[0].imageIds, [
    'phase1-contract-image-1',
    'phase1-contract-image-2',
    'phase1-contract-image-3',
  ]);
  assert.equal(fixture.layer.temporary, true);
});

test('memory fixture appends one temporary floor and restores original references exactly', () => {
  const originalChat = [{ mes: 'existing', name: 'narrator' }];
  const originalMetadata = { unrelated: { keep: true } };
  const context = { chat: originalChat, chatMetadata: originalMetadata };
  const fixture = installQianmuMemoryFixture(context, { id: 'test-fixture' });

  assert.equal(context.chat.length, 2);
  assert.equal(context.chat[0], originalChat[0]);
  assert.equal(context.chat[1].extra.qianmuTemporaryFixture, true);
  assert.equal(context.chatMetadata.unrelated, originalMetadata.unrelated);
  assert.equal(context.chatMetadata.story_director_liminale.fixtureId, 'test-fixture');
  assert.equal(context.chatMetadata.story_director_liminale.storyboardImages.length, 1);
  assert.equal(fixture.isRestored(), false);
  assert.equal(fixture.restore(), true);
  assert.equal(context.chat, originalChat);
  assert.equal(context.chatMetadata, originalMetadata);
  assert.equal(fixture.isRestored(), true);
  assert.equal(fixture.restore(), false);
});

test('memory fixture preserves absent host fields and does not manufacture empty metadata on cleanup', () => {
  const context = {};
  const fixture = installQianmuMemoryFixture(context, { id: 'absent-fields' });
  assert.equal(Array.isArray(context.chat), true);
  assert.equal(typeof context.chatMetadata.story_director_liminale, 'object');
  fixture.restore();
  assert.equal(Object.hasOwn(context, 'chat'), false);
  assert.equal(Object.hasOwn(context, 'chatMetadata'), false);
});

test('memory fixture clones caller input and never invokes host writers', () => {
  const calls = [];
  const entry = { mes: 'caller text', extra: { nested: true } };
  const layer = { schemaVersion: 8, storyboardImages: [{ id: 'caller-image' }] };
  const context = { chat: [], chatMetadata: {}, saveMetadata: () => calls.push('metadata'), saveSettings: () => calls.push('settings') };
  const fixture = installQianmuMemoryFixture(context, { id: 'clone-input', entry, layer });
  context.chat[0].extra.nested = false;
  context.chatMetadata.story_director_liminale.storyboardImages[0].id = 'mutated-in-place';
  assert.equal(entry.extra.nested, true);
  assert.equal(layer.storyboardImages[0].id, 'caller-image');
  assert.equal(fixture.entry.extra.nested, true);
  assert.deepEqual(fixture.metadata.story_director_liminale.storyboardImages, [{ id: 'caller-image' }]);
  fixture.restore();
  assert.deepEqual(calls, []);
});

test('memory fixture rejects invalid contexts and malformed storyboard arrays before mutation', () => {
  assert.throws(() => installQianmuMemoryFixture(null), /context must be an object/);
  const context = { chat: [] };
  assert.throws(() => installQianmuMemoryFixture(context, { storyboardImages: null }), /storyboardImages must be an array/);
  assert.deepEqual(context, { chat: [] });
});

test('memory fixture can install the ordered phase 1 sample without invoking writers', () => {
  const sample = createQianmuPhase1Fixture({ id: 'phase1-install' });
  const calls = [];
  const originalChat = [{ mes: 'existing' }];
  const context = {
    chat: originalChat,
    chatMetadata: {},
    saveMetadata: () => calls.push('metadata'),
  };
  const fixture = installQianmuMemoryFixture(context, {
    id: sample.id,
    entries: sample.entries,
    layer: sample.layer,
  });
  assert.equal(context.chat.length, 4);
  assert.deepEqual(context.chat.slice(1).map(row => row.extra.floor), [0, 1, 2]);
  assert.deepEqual(context.chatMetadata.story_director_liminale.storyboardImages.map(row => row.id), [
    'phase1-install-image-1',
    'phase1-install-image-2',
    'phase1-install-image-3',
  ]);
  fixture.restore();
  assert.equal(context.chat, originalChat);
  assert.deepEqual(calls, []);
});
