import test from 'node:test';
import assert from 'node:assert/strict';
import { fitCoverFrame, selectCoverComposition } from '../qianmu-cover-layout.js';

function approximately(actual, expected) {
  const tolerance = Math.max(1, Math.abs(expected)) * Number.EPSILON * 8;
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should equal ${expected}`);
}

function assertContained(frame, width, height) {
  for (const key of ['designWidth', 'designHeight', 'width', 'height', 'scale', 'x', 'y']) {
    assert.ok(Number.isFinite(frame[key]), `${key} must be finite`);
    assert.ok(frame[key] >= 0, `${key} must not be negative`);
  }
  approximately(frame.width, frame.designWidth * frame.scale);
  approximately(frame.height, frame.designHeight * frame.scale);
  approximately(frame.x, (width - frame.width) / 2);
  approximately(frame.y, (height - frame.height) / 2);
  assert.ok(frame.width <= width + Math.max(1, width) * Number.EPSILON * 8);
  assert.ok(frame.height <= height + Math.max(1, height) * Number.EPSILON * 8);
}

test('landscape master fits exactly at its design size', () => {
  assert.deepEqual(fitCoverFrame({ width: 1120, height: 700 }), {
    orientation: 'landscape', designWidth: 1120, designHeight: 700,
    width: 1120, height: 700, scale: 1, x: 0, y: 0,
  });
});

test('portrait master fits exactly at its design size', () => {
  assert.deepEqual(fitCoverFrame({ width: 390, height: 640 }), {
    orientation: 'portrait', designWidth: 390, designHeight: 640,
    width: 390, height: 640, scale: 1, x: 0, y: 0,
  });
});

test('fractional-axis floating point rounding never yields a negative offset', () => {
  const width = 1799.1560667976737;
  const height = 436.2903163526207;
  const frame = fitCoverFrame({ width, height, orientation: 'landscape' });
  assert.ok(frame.x >= 0 && frame.y >= 0);
  approximately(frame.height, height);
  approximately(frame.height, frame.designHeight * frame.scale);
});

test('both available axes constrain the frame and leave symmetric free space', () => {
  assert.deepEqual(fitCoverFrame({ width: 1400, height: 350 }), {
    orientation: 'landscape', designWidth: 1120, designHeight: 700,
    width: 560, height: 350, scale: 0.5, x: 420, y: 0,
  });
  assert.deepEqual(fitCoverFrame({ width: 195, height: 900 }), {
    orientation: 'portrait', designWidth: 390, designHeight: 640,
    width: 195, height: 320, scale: 0.5, x: 0, y: 290,
  });
});

test('auto orientation follows available panel width, including a narrow desktop panel', () => {
  for (const height of [1, 300, 640, 2400]) {
    assert.equal(fitCoverFrame({ width: 639.999, height }).orientation, 'portrait');
    assert.equal(fitCoverFrame({ width: 640, height }).orientation, 'landscape');
    assert.equal(fitCoverFrame({ width: 1200, height }).orientation, 'landscape');
  }
});

test('explicit orientation is stable even when available space has the opposite aspect', () => {
  const landscape = fitCoverFrame({ width: 320, height: 1200, orientation: 'landscape' });
  assert.equal(landscape.orientation, 'landscape');
  assert.equal(landscape.designWidth, 1120);
  assert.equal(landscape.designHeight, 700);
  assertContained(landscape, 320, 1200);
  const portrait = fitCoverFrame({ width: 1600, height: 240, orientation: 'portrait' });
  assert.equal(portrait.orientation, 'portrait');
  assert.equal(portrait.designWidth, 390);
  assert.equal(portrait.designHeight, 640);
  assertContained(portrait, 1600, 240);
});

test('default scale is capped at one and a positive custom cap is honored', () => {
  const native = fitCoverFrame({ width: 2240, height: 1400 });
  assert.equal(native.scale, 1);
  assert.equal(native.x, 560);
  assert.equal(native.y, 350);
  const smaller = fitCoverFrame({ width: 2240, height: 1400, maxScale: 0.25 });
  assert.equal(smaller.scale, 0.25);
  assertContained(smaller, 2240, 1400);
  const larger = fitCoverFrame({ width: 2240, height: 1400, maxScale: 3 });
  assert.equal(larger.scale, 2);
  assertContained(larger, 2240, 1400);
});

test('zero width or height safely collapses the frame without NaN', () => {
  for (const [width, height] of [[0, 0], [0, 800], [1200, 0], [-0, 700]]) {
    const frame = fitCoverFrame({ width, height });
    assert.equal(frame.scale, 0);
    assert.equal(frame.width, 0);
    assert.equal(frame.height, 0);
    assertContained(frame, width, height);
  }
});

test('extreme wide, tall, fractional, tiny, and huge panels preserve the master ratio', () => {
  for (const orientation of ['auto', 'landscape', 'portrait']) {
    for (const [width, height] of [
      [100000, 1], [1, 100000], [813.25, 419.75], [0.125, 0.25],
      [Number.MIN_VALUE, Number.MIN_VALUE], [Number.MAX_VALUE, Number.MAX_VALUE],
    ]) {
      const frame = fitCoverFrame({ width, height, orientation });
      assertContained(frame, width, height);
      if (frame.scale > 0) approximately(frame.width / frame.height, frame.designWidth / frame.designHeight);
    }
  }
});

test('theme, device, and source-image shape cannot change the cover frame or composition', () => {
  const available = { width: 600, height: 420 };
  const expected = fitCoverFrame(available);
  for (const theme of ['minimal', 'dream']) {
    assert.deepEqual(fitCoverFrame({
      ...available, theme, device: 'desktop', images: [{ width: 10000, height: 1 }],
    }), expected);
    assert.equal(selectCoverComposition({ count: 2, theme, imageAspectRatio: 0.001 }), 'diptych');
  }
});

test('geometry returns fresh data and neither helper mutates caller input', () => {
  const options = Object.freeze({ width: 1000, height: 800, orientation: 'auto', maxScale: 0.75 });
  const before = { ...options };
  const first = fitCoverFrame(options);
  const second = fitCoverFrame(options);
  assert.notEqual(first, second);
  assert.deepEqual(first, second);
  first.width = -1;
  assert.deepEqual(fitCoverFrame(options), second);
  assert.deepEqual(options, before);
  const composition = Object.freeze({ count: 1, variant: 'left' });
  assert.equal(selectCoverComposition(composition), 'solo-left');
  assert.deepEqual(composition, { count: 1, variant: 'left' });
});

test('zero through three images map to a finite editorial composition vocabulary', () => {
  for (const variant of ['auto', 'left', 'right', 'center']) {
    assert.equal(selectCoverComposition({ count: 0, variant }), 'typographic');
    assert.equal(selectCoverComposition({ count: 2, variant }), 'diptych');
    assert.equal(selectCoverComposition({ count: 3, variant }), 'triptych');
  }
  assert.equal(selectCoverComposition({ count: 1 }), 'solo-right');
  assert.equal(selectCoverComposition({ count: 1, variant: 'auto' }), 'solo-right');
  assert.equal(selectCoverComposition({ count: 1, variant: 'left' }), 'solo-left');
  assert.equal(selectCoverComposition({ count: 1, variant: 'right' }), 'solo-right');
  assert.equal(selectCoverComposition({ count: 1, variant: 'center' }), 'solo-center');
});

test('dimensions reject negative, nonfinite, missing, and nonnumeric inputs without coercion', () => {
  for (const name of ['width', 'height']) {
    for (const value of [NaN, Infinity, -Infinity, undefined, null, '600', true, {}, []]) {
      assert.throws(() => fitCoverFrame({ width: 1000, height: 800, [name]: value }), TypeError);
    }
    assert.throws(() => fitCoverFrame({ width: 1000, height: 800, [name]: -1 }), RangeError);
  }
  assert.throws(() => fitCoverFrame(), TypeError);
  assert.throws(() => fitCoverFrame(null), TypeError);
});

test('scale cap rejects nonpositive, nonfinite, and nonnumeric inputs', () => {
  for (const maxScale of [0, -0, -1]) {
    assert.throws(() => fitCoverFrame({ width: 1000, height: 800, maxScale }), RangeError);
  }
  for (const maxScale of [NaN, Infinity, -Infinity, null, '1', true, {}, []]) {
    assert.throws(() => fitCoverFrame({ width: 1000, height: 800, maxScale }), TypeError);
  }
});

test('orientation and variant reject values outside their enumerations', () => {
  for (const orientation of ['', 'mobile', 'Landscape', null, 1, {}, []]) {
    assert.throws(() => fitCoverFrame({ width: 1000, height: 800, orientation }), RangeError);
  }
  for (const variant of ['', 'random', 'solo-left', null, 1, {}, []]) {
    for (const count of [0, 1, 2, 3]) {
      assert.throws(() => selectCoverComposition({ count, variant }), RangeError);
    }
  }
});

test('composition rejects counts outside zero through three and does not coerce input', () => {
  for (const count of [-1, 4, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => selectCoverComposition({ count }), RangeError);
  }
  for (const count of [0.5, NaN, Infinity, -Infinity, undefined, null, '1', true, {}, []]) {
    assert.throws(() => selectCoverComposition({ count }), TypeError);
  }
  assert.throws(() => selectCoverComposition(), TypeError);
  assert.throws(() => selectCoverComposition(null), TypeError);
});
