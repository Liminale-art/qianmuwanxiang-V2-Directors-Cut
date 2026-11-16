import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { quickDialGeometry, quickDialCyclic, quickDialDelta, quickDialOffset, quickDialAngle, quickDialSelected, quickDialTone } from '../qianmu-quick-dial.js';

const phone = side => quickDialGeometry({ centerX: side === 'right' ? 340 : 20, centerY: 400, width: 360, height: 780, size: 44 });
const point = (geo, offset) => { const angle = quickDialAngle(offset, geo); return [geo.sign * geo.ringX * Math.cos(angle), geo.ringY * Math.sin(angle)]; };

test('the arc is a tall half ellipse bulging away from the edge the logo sits on, and fits narrow screens', () => {
  const right = phone('right'), left = phone('left');
  assert.equal(right.side, 'right'); assert.equal(right.sign, -1, 'logo on the right: the arc bulges to the left');
  assert.equal(left.side, 'left'); assert.equal(left.sign, 1);
  for (const geo of [right, left]) {
    assert.ok(geo.rx >= 100 && geo.rx <= 164);
    assert.ok(geo.ry > geo.rx * 1.25, 'the arc is stretched vertically, not a circle');
    assert.ok(geo.ringX < geo.rx && geo.ringY < geo.ry, 'entries sit inside the arc');
    assert.ok(geo.rx + 96 <= 360, 'room is left outside the arc for the name box');
  }
  const wide = quickDialGeometry({ centerX: 1880, centerY: 500, width: 1920, height: 1000, size: 80 });
  assert.equal(wide.rx, 164, 'the horizontal radius grows with the logo size up to its cap');
  const short = quickDialGeometry({ centerX: 340, centerY: 30, width: 360, height: 300, size: 44 });
  assert.ok(short.ry <= 300 * 0.47 + 1 || short.ry === short.rx, 'a short viewport limits the vertical stretch');
});

test('the pointer dot sits between the arc and the pointed entry with the same gap on both sides', () => {
  const geo = phone('right'), grownHalf = geo.chip * 1.5 / 2, dotRadius = 3.5;
  const arcToDot = geo.rx - (geo.dot + dotRadius), dotToEntry = (geo.dot - dotRadius) - (geo.ringX + grownHalf);
  assert.ok(Math.abs(arcToDot - dotToEntry) < 1e-9, 'equal spacing: arc — dot — entry');
  assert.ok(arcToDot >= 7 && arcToDot <= 12);
});

test('neighbouring entries keep the same edge-to-edge gap while the pointed one grows, all the way round the arc', () => {
  const geo = phone('right'), size = delta => geo.chip * (1 + 0.5 * Math.max(0, 1 - Math.abs(delta)));
  for (const position of [0, 0.25, 0.5, 0.8]) {
    const gaps = [];
    for (let index = -2; index < 2; index++) {   // the entries nearest the pointer, all inside the visible arc
      const a = index - position, b = index + 1 - position;
      const [ax, ay] = point(geo, quickDialOffset(a, geo)), [bx, by] = point(geo, quickDialOffset(b, geo));
      gaps.push(Math.hypot(bx - ax, by - ay) - (size(a) + size(b)) / 2);
    }
    assert.ok(Math.max(...gaps) - Math.min(...gaps) < 2.5, `gaps stay even at position ${position}: ${gaps.map(gap => gap.toFixed(1)).join(', ')}`);
    assert.ok(Math.min(...gaps) > 8, 'entries never crowd each other');
  }
});

test('positions along the ellipse: symmetric, monotonic, and hidden once past the visible quarter', () => {
  const geo = phone('left');
  assert.equal(quickDialAngle(0, geo), 0);
  assert.ok(Math.abs(quickDialAngle(60, geo) + quickDialAngle(-60, geo)) < 1e-12);
  let last = -1;
  for (let offset = 0; offset <= 200; offset += 20) { const angle = quickDialAngle(offset, geo); assert.ok(angle > last); last = angle; }
  assert.ok(quickDialAngle(5000, geo) > Math.PI / 2, 'far entries resolve beyond the visible range');
});

test('entries wrap around only when there are enough to fill the visible arc', () => {
  const geo = phone('right');
  assert.equal(quickDialCyclic(4, geo), false); assert.equal(quickDialCyclic(17, geo), true);
  assert.equal(quickDialDelta(3, 1, 4, false), 2); assert.equal(quickDialDelta(0, 3, 4, false), -3);
  assert.equal(quickDialDelta(16, 0, 17, true), -1, 'the last entry sits just before the first');
  assert.equal(quickDialDelta(0, 16, 17, true), 1);
  assert.equal(quickDialDelta(2, 19, 17, true), 0, 'positions beyond one full turn still resolve');
  assert.equal(quickDialSelected(1.4, 5, false), 1); assert.equal(quickDialSelected(1.6, 5, false), 2);
  assert.equal(quickDialSelected(-0.8, 5, false), 0); assert.equal(quickDialSelected(7.2, 5, false), 4);
  assert.equal(quickDialSelected(-1, 17, true), 16); assert.equal(quickDialSelected(17.2, 17, true), 0); assert.equal(quickDialSelected(35, 17, true), 1);
});

test('entry tint blends the two theme colours and falls back quietly on unknown formats', () => {
  assert.equal(quickDialTone('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(quickDialTone('#fff', '#000', 0), '#ffffff');
  assert.equal(quickDialTone('#102030', '#302010', 4), '#302010', 'ratio is clamped');
  assert.equal(quickDialTone('rgb(1, 2, 3)', '#ffffff', 0.5), '');
  assert.equal(quickDialTone(undefined, '#ffffff', 0.5), '');
});

test('wiring: same gestures as the hive (tap opens the panel, long press opens the dial), bare arc, round frames', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8'), css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  const module = readFileSync(new URL('../qianmu-quick-dial.js', import.meta.url), 'utf8');
  assert.match(source, /const quickDial = createQuickDial\(\{\s*id: QUICK_WHEEL_ID,/, 'one launcher layer: closing the hive closes the dial too');
  assert.match(source, /if \(open\?\._qmCleanup\) open\._qmCleanup\(\); else open\?\.remove\(\);/);
  assert.match(source, /function openQuickWheel\(btn\) \{\s*closeQuickWheel\(\);\s*closeFloorNavigator\(\);\s*if \(settings\.quickLauncher === 'dial'\) return void quickDial\.open\(btn\);/, 'the long press that opens the hive opens the dial instead');
  assert.match(source, /openQuickWheelFromLongPress\(btn\);[\s\S]{0,160}if \(settings\.quickLauncher === 'dial'\) dial = quickDial\.grab\(btn,/, 'the same press continues as a slide');
  assert.doesNotMatch(source, /quickDial\.press|sd-float-lifted/, 'no press-to-open gesture: a tap opens the main panel as with the hive');
  assert.match(source, /run: \(id\) => id \? runQuickWheelCommand\(id\) : openModal\(\)/, 'the first entry opens the main panel');
  assert.match(module, /prefers-reduced-motion: reduce/);
  assert.match(module, /chip\.animate\(\[\{ transform: 'scale\(1\)' \}, \{ transform: 'scale\(\.8\)'/, 'the entry dips and springs back before its panel opens');
  assert.doesNotMatch(module + css, /qm-dial-drop|qm-dial-scrim/, 'no bump on the arc and no backing disc');
  assert.match(css, /\.qm-dial-chip \{[^}]*border-radius: 50%;[^}]*inset 0 0 0 calc\(1\.2px \/ var\(--qd-grow, 1\)\)/, 'round frames with the same 1.2px line as the hive outline');
  assert.match(css, /\.qm-dial-chip > img \{ width: 74%; height: 74%; object-fit: contain;/, 'the logo fits inside its round frame uncropped');
  assert.match(css, /html\[data-qm-launcher="dial"\] \.sd-detached-notes-entry \{[^}]*clip-path: circle\(50%\)/, 'dragged-out entries are round in dial mode');
  assert.match(source, /setAttribute\('data-qm-launcher', settings\.quickLauncher === 'dial' \? 'dial' : 'hive'\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ #story-director-quick-wheel\.qm-dial \.qm-dial-stage \{ animation: none; \} \}/);
  assert.match(css, /#story-director-quick-wheel\.qm-dial\.qm-dial-right \.qm-dial-label \{ right: calc\(var\(--qd-r\) \+ 12px\); \}/, 'the name box sits outside the arc');
  assert.ok(JSON.parse(readFileSync(new URL('../release-files.json', import.meta.url), 'utf8')).files.includes('qianmu-quick-dial.js'));
});
