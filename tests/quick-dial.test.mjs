import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { quickDialGeometry, quickDialCyclic, quickDialAngle, quickDialSelected, quickDialTone } from '../qianmu-quick-dial.js';

const STEP = 23 * Math.PI / 180;

test('the arc bulges away from the edge the logo sits on, and the radius fits narrow screens', () => {
  const right = quickDialGeometry({ centerX: 340, centerY: 400, width: 360, height: 780, size: 44 });
  assert.equal(right.side, 'right'); assert.equal(right.sign, -1, 'logo on the right: the arc bulges to the left');
  const left = quickDialGeometry({ centerX: 20, centerY: 400, width: 360, height: 780, size: 44 });
  assert.equal(left.side, 'left'); assert.equal(left.sign, 1);
  for (const geo of [right, left]) {
    assert.ok(geo.radius >= 104 && geo.radius <= 176);
    assert.ok(geo.focus < geo.ring && geo.ring < geo.radius, 'the pointed entry sits further in than the ring, both inside the arc');
    assert.ok(geo.radius + 96 <= 360, 'room is left outside the arc for the name box');
  }
  const wide = quickDialGeometry({ centerX: 1880, centerY: 500, width: 1920, height: 1000, size: 80 });
  assert.equal(wide.radius, 175, 'radius grows with the logo size up to its cap');
});

test('near the top or bottom edge the dial centre is nudged so at least two entries stay visible on each side', () => {
  const low = quickDialGeometry({ centerX: 340, centerY: 770, width: 360, height: 780, size: 44 });
  assert.ok(low.y < 770 && 780 - low.y >= low.radius * 0.62);
  const high = quickDialGeometry({ centerX: 340, centerY: 10, width: 360, height: 780, size: 44 });
  assert.ok(high.y > 10 && high.y >= high.radius * 0.62);
  const short = quickDialGeometry({ centerX: 340, centerY: 30, width: 360, height: 120, size: 44 });
  assert.equal(short.y, 60, 'a very short viewport centres the dial');
});

test('entries wrap around only when there are enough to fill the half circle', () => {
  assert.equal(quickDialCyclic(4), false); assert.equal(quickDialCyclic(8), false);
  assert.equal(quickDialCyclic(9), true); assert.equal(quickDialCyclic(17), true);
  // open-ended list: plain offsets
  assert.ok(Math.abs(quickDialAngle(3, 1, 4) - 2 * STEP) < 1e-9);
  assert.ok(Math.abs(quickDialAngle(0, 3, 4) + 3 * STEP) < 1e-9);
  // cyclic list: the shortest way round
  assert.ok(Math.abs(quickDialAngle(16, 0, 17) + STEP) < 1e-9, 'the last entry sits just before the first');
  assert.ok(Math.abs(quickDialAngle(0, 16, 17) - STEP) < 1e-9);
  assert.ok(Math.abs(quickDialAngle(2, 19, 17)) < 1e-9, 'positions beyond one full turn still resolve');
});

test('the pointed entry is the nearest one; open-ended lists clamp, cyclic lists wrap', () => {
  assert.equal(quickDialSelected(1.4, 5), 1); assert.equal(quickDialSelected(1.6, 5), 2);
  assert.equal(quickDialSelected(-0.8, 5), 0); assert.equal(quickDialSelected(7.2, 5), 4);
  assert.equal(quickDialSelected(-1, 17), 16); assert.equal(quickDialSelected(17.2, 17), 0); assert.equal(quickDialSelected(35, 17), 1);
});

test('entry tint blends the two theme colours and falls back quietly on unknown formats', () => {
  assert.equal(quickDialTone('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(quickDialTone('#fff', '#000', 0), '#ffffff');
  assert.equal(quickDialTone('#102030', '#302010', 1), '#302010');
  assert.equal(quickDialTone('#102030', '#302010', 4), '#302010', 'ratio is clamped');
  assert.equal(quickDialTone('rgb(1, 2, 3)', '#ffffff', 0.5), '');
  assert.equal(quickDialTone(undefined, '#ffffff', 0.5), '');
});

test('wiring: the dial shares the quick-launcher layer, respects reduced motion and is shipped', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8'), css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  const module = readFileSync(new URL('../qianmu-quick-dial.js', import.meta.url), 'utf8');
  assert.match(source, /const quickDial = createQuickDial\(\{\s*id: QUICK_WHEEL_ID,/, 'one launcher layer: closing the hive closes the dial too');
  assert.match(source, /if \(open\?\._qmCleanup\) open\._qmCleanup\(\); else open\?\.remove\(\);/);
  assert.match(source, /if \(settings\.quickLauncher === 'dial'\) \{[\s\S]*?dial = quickDial\.press\(btn, event, \{ onLift:/, 'pressing the logo opens the dial at once');
  assert.match(source, /run: \(id\) => id \? runQuickWheelCommand\(id\) : openModal\(\)/, 'the first entry opens the main panel');
  assert.match(module, /prefers-reduced-motion: reduce/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ #story-director-quick-wheel\.qm-dial \.qm-dial-stage \{ animation: none; \} \}/);
  assert.match(css, /#story-director-quick-wheel\.qm-dial\.qm-dial-right \.qm-dial-label \{ right: calc\(var\(--qd-r\) \+ 12px\); \}/, 'the name box sits outside the arc');
  assert.ok(JSON.parse(readFileSync(new URL('../release-files.json', import.meta.url), 'utf8')).files.includes('qianmu-quick-dial.js'));
});
