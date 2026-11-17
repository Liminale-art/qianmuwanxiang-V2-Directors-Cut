import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { quickDialGeometry, quickDialCyclic, quickDialDelta, quickDialOffset, quickDialAngle, quickDialSelected, quickDialOpacity, quickDialTone } from '../qianmu-quick-dial.js';

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
  assert.equal(right.x, 340 + 40, 'the dial is pulled toward the edge the logo sits on: its centre may pass the edge by 20px');
  assert.equal(left.x, 20 - 40);
  assert.equal(wide.x, 1880 + 50, 'never by more than 50px');
  const short = quickDialGeometry({ centerX: 340, centerY: 30, width: 360, height: 300, size: 44 });
  assert.ok(short.ry <= 300 * 0.47 + 1 || short.ry === short.rx, 'a short viewport limits the vertical stretch');
});

test('the pointer dot sits between the arc and the pointed entry with the same gap on both sides', () => {
  const geo = phone('right'), grownHalf = geo.chip * 1.3 / 2, dotRadius = 3.5;
  const arcToDot = geo.rx - (geo.dot + dotRadius), dotToEntry = (geo.dot - dotRadius) - (geo.ringX + grownHalf);
  assert.ok(Math.abs(arcToDot - dotToEntry) < 1e-9, 'equal spacing: arc — dot — entry');
  assert.ok(arcToDot >= 7 && arcToDot <= 12);
});

test('neighbouring entries keep the same edge-to-edge gap while the pointed one grows, all the way round the arc', () => {
  const geo = phone('right'), size = delta => geo.chip * (1 + 0.3 * Math.max(0, 1 - Math.abs(delta)));
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
  for (let offset = 0; offset <= 140; offset += 20) { const angle = quickDialAngle(offset, geo); assert.ok(angle > last); last = angle; }
  assert.ok(quickDialAngle(5000, geo) > Math.PI / 2, 'far entries resolve beyond the visible range');
});

test('five slots: two entries on each side of the pointer fill the visible arc, the next one is out of sight', () => {
  for (const geo of [phone('right'), quickDialGeometry({ centerX: 1880, centerY: 500, width: 1920, height: 1000, size: 48 })]) {
    const quarter = Math.PI / 2;
    assert.ok(Math.abs(quickDialAngle(quickDialOffset(2, geo), geo)) < 80 * Math.PI / 180, 'the second neighbour is inside the visible arc');
    assert.ok(Math.abs(quickDialAngle(quickDialOffset(3, geo), geo)) > 78 * Math.PI / 180 || Math.abs(quickDialAngle(quickDialOffset(3, geo), geo)) > quarter, 'the third neighbour falls at or beyond its edge');
    assert.ok(geo.pitch >= geo.chip + 8, 'entries never touch');
  }
  assert.equal(quickDialOpacity(0), 1); assert.equal(quickDialOpacity(1), 1);
  assert.ok(quickDialOpacity(2) > 0.55 && quickDialOpacity(2) < 1, 'the outer slot is slightly faded');
  assert.equal(quickDialOpacity(2.9), 0); assert.equal(quickDialOpacity(-2.9), 0);
});

test('entries wrap around only when there are more than the five slots can show', () => {
  const geo = phone('right');
  assert.equal(quickDialCyclic(4), false); assert.equal(quickDialCyclic(6), false); assert.equal(quickDialCyclic(7), true); assert.equal(quickDialCyclic(17), true);
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
  assert.doesNotMatch(source + module, /quickDial\.grab|function grab\(/, 'after the long press, moving the finger moves the logo exactly as with the hive; the dial is turned by a separate gesture');
  assert.match(source, /if \(wheelOpened\) \{[\s\S]{0,260}closeQuickWheel\(\);\s*wheelOpened = false;\s*\}\s*moved = true;/, 'dragging after the long press closes the launcher and moves the logo');
  assert.match(css, /#story-director-float\.sd-float-dragging\.sd-wheel-away \{ filter: none !important; \}/, 'the logo is visible again the moment it is dragged');
  assert.match(module, /current\.root\.id = LEAVING_ID;/, 'while closing, the layer keeps a styled id so the logo never paints at its natural size');
  assert.doesNotMatch(module + css, /qm-dial-more|···/, 'no ellipsis markers at the ends of the arc');
  assert.match(module, /accent = look\?\.getPropertyValue\('--sd-float-edge'\)\.trim\(\) \|\| colors\.mainEdge \|\| colors\.edges\?\.\[0\] \|\| '#c99b51';/, 'arc, dot and frames read the accent the floating logo itself shows, so every theme and day/night follows');
  assert.match(module, /setProperty\('--qd-chip-bg', look\.backgroundColor\)/, 'dial entries are drawn with the floating logo fill');
  assert.match(module, /current\.home\?\.style\.setProperty\('--qd-grow', '1'\)/, 'the logo returns at its resting size and style');
  assert.match(css, /html\[data-qm-launcher="dial"\] #story-director-float \{[^}]*justify-content: center !important; align-items: center !important;/, 'the logo is centred in the round floating entry');
  assert.doesNotMatch(source, /quickDial\.press|sd-float-lifted/, 'no press-to-open gesture: a tap opens the main panel as with the hive');
  assert.match(source, /run: \(id\) => id \? runQuickWheelCommand\(id\) : openModal\(\)/, 'the first entry opens the main panel');
  assert.match(module, /prefers-reduced-motion: reduce/);
  assert.match(module, /chip\.animate\(\[\{ transform: 'scale\(1\)' \}, \{ transform: 'scale\(\.8\)'/, 'the entry dips and springs back before its panel opens');
  assert.doesNotMatch(module + css, /qm-dial-drop|qm-dial-scrim/, 'no bump on the arc and no backing disc');
  assert.match(css, /\.qm-dial-chip \{[^}]*border-radius: 50%;[^}]*inset 0 0 0 calc\(1\.2px \/ var\(--qd-grow, 1\)\)/, 'round frames with the same 1.2px line as the hive outline');
  assert.match(css, /\.qm-dial-chip > img \{ width: 82%; height: 82%; object-fit: contain; translate: 0 1px; pointer-events: none; \}/, 'the logo fits inside its round frame uncropped, slightly enlarged and nudged 1px down');
  assert.match(css, /#story-director-float > img, [^{]*\{ width: 82% !important; height: 82% !important; [^}]*translate: 0 1px;/, 'the floating entry draws the logo at the same proportion and offset');
  assert.match(module, /const list = \[\.\.\.\(items\?\.\(\) \|\| \[\]\), \{ id: HOME, label: '千幕', home: true \}\];/, 'the main-panel entry is the last slot, not a second logo at the front');
  assert.match(module, /origin\.classList\?\.add\('sd-wheel-away'\);[\s\S]{0,400}flyHome\(view, false\);/, 'the round logo itself slides into the arc when the dial opens');
  assert.match(module, /const motion = flyHome\(current, true\);/, 'and slides back when it closes');
  assert.match(css, /#story-director-float\.sd-wheel-away \{ filter: opacity\(0\) !important;/);
  assert.match(source, /settings\.quickLauncher === 'dial' \? 'circle\(50%\)' : 'polygon\(/, 'the floating logo is a circle in dial mode');
  assert.match(css, /html\[data-qm-launcher="dial"\] \.sd-detached-notes-entry > :is\(i, \.qm-glyph-icon\) \{[^}]*\* \.46\)/, 'dragged-out entries use the dial icon proportion');
  assert.match(css, /\.qm-prose-hive-layer\.qm-prose-hive-floor \{ z-index: 2147483000; \}/, 'the dragged-out chat toolkit entry sits below the main panel');
  assert.match(css, /html\[data-qm-launcher="dial"\] \.sd-detached-notes-entry \{[^}]*clip-path: circle\(50%\)/, 'dragged-out entries are round in dial mode');
  assert.match(source, /setAttribute\('data-qm-launcher', settings\.quickLauncher === 'dial' \? 'dial' : 'hive'\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ :is\(#story-director-quick-wheel, #qm-dial-leaving\)\.qm-dial \.qm-dial-stage > :not\(\.qm-dial-items\), [^{]*\.qm-dial-item:not\(\.is-home\) \{ animation: none; \} \}/);
  assert.match(css, /\.qm-dial-item:not\(\.is-home\) \{ animation: qm-dial-in [^}]*backwards; \}\s*@keyframes qm-dial-in \{ from \{ opacity: 0; \} \}/, 'the logo entry takes no part in the fade-in: it slides in from the floating entry unchanged');
  assert.match(css, /\.qm-dial-item\.is-current:not\(\.is-home\) \.qm-dial-chip \{ background:/, 'the logo entry is never tinted at the pointer');
  assert.match(module, /scale\(\$\{\(from\.scale \/ grow\)\.toFixed\(3\)\}\)/, 'the slide starts at the floating entry size even when the logo entry is enlarged at the pointer');
  assert.match(css, /:is\(#story-director-quick-wheel, #qm-dial-leaving\)\.qm-dial\.qm-dial-right \.qm-dial-label \{ right: calc\(var\(--qd-r\) \+ 12px\); \}/, 'the name box sits outside the arc');
  assert.ok(JSON.parse(readFileSync(new URL('../release-files.json', import.meta.url), 'utf8')).files.includes('qianmu-quick-dial.js'));
});
