import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

test('ordinary prose media bypasses the director runtime without loading it', () => {
  const helper = source.slice(
    source.indexOf('async function storyboardDirectorWorkOrderForRecord'),
    source.indexOf('function storyboardVideoDraftSourceShot'),
  );
  assert.match(helper, /if \(!production\.packetId && !production\.eventId\) return null/);
  assert.ok(helper.indexOf('return null') < helper.indexOf("featureRuntime.load('directorWorkOrders')"));
});

test('world-side media must keep an approved and matching decision chain', () => {
  const helper = source.slice(
    source.indexOf('async function storyboardDirectorWorkOrderForRecord'),
    source.indexOf('function storyboardVideoDraftSourceShot'),
  );
  assert.match(helper, /recordChatKey !== chatKey/);
  assert.match(helper, /production\.decisionId !== decision\.decisionId/);
  assert.match(helper, /production\.packetId !== decision\.source\?\.packetId/);
  assert.match(helper, /production\.eventId !== decision\.source\?\.eventId/);
  assert.match(helper, /createDirectorWorkOrder\(decision, consumer, chatKey/);
  assert.match(helper, /canConsumeDirectorWorkOrder\(result\.workOrder, consumer, chatKey\)/);
});

test('dynamic draft rechecks its film work order both on open and before paid submission', () => {
  const editor = source.slice(
    source.indexOf('async function storyboardOpenVideoDraftEditor'),
    source.indexOf('function renderStoryboardVideoDraftShelf'),
  );
  const checks = [...editor.matchAll(/storyboardDirectorWorkOrderForRecord\([^\n]+, 'film'\)/g)];
  assert.equal(checks.length, 2);
  assert.ok(checks[0].index < editor.indexOf('storyboardCloseVideoDraftEditor();'));
  assert.ok(checks[1].index < editor.indexOf('storyboardEnsureVideoCoordinator()', checks[1].index));
});

test('film timeline validates world-side still and motion sources on add and save', () => {
  const save = source.slice(
    source.indexOf('async function storyboardSaveFilmEditor'),
    source.indexOf('async function storyboardDeleteFilmTimeline'),
  );
  assert.match(save, /for \(const selection of storyboardFilmEditor\.selections\)/);
  assert.match(save, /await storyboardDirectorWorkOrderForRecord\(sourceRecord, 'film'\)/);
  assert.ok(save.indexOf("storyboardDirectorWorkOrderForRecord(sourceRecord, 'film')") < save.indexOf('buildVideoTimeline'));

  const binding = source.slice(
    source.indexOf("root.querySelectorAll('[data-storyboard-film-add-kind]')"),
    source.indexOf("root.querySelectorAll('[data-storyboard-film-clip]')"),
  );
  assert.match(binding, /addEventListener\('click', async \(\) =>/);
  assert.equal([...binding.matchAll(/storyboardDirectorWorkOrderForRecord\([^\n]+, 'film'\)/g)].length, 2);
});
