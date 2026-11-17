import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

test('reader memory no longer mirrors slices into a world book', () => {
  for (const removed of ['coreadSyncSliceMirror', 'worldSyncMode', '同步世界书']) {
    assert.equal(source.includes(removed), false, removed);
  }
});

test('the mainline selection summary is gone', () => {
  assert.equal(source.includes('coreadDistillMainline'), false);
});

test('existing mainline slices keep their read-only label and coverage text', () => {
  assert.match(source, /function coreadSliceSourceLabel[\s\S]*?source === 'mainline'\) return '正文回响'/);
  assert.match(source, /function coreadSliceSourceClass[\s\S]*?source === 'mainline'\) return 'src-mainline'/);
  assert.match(source, /source === 'mainline' && provenance\.mainlineFloors\?\.length[\s\S]*?正文楼层/);
});
