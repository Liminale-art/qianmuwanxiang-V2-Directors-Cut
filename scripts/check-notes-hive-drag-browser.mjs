// Native mouse/touch-pointer coverage of the real hive-detach handler.
// Persistence and note opening are counters only; no real notes, ST, APIs or media.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const skin = await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const handler = storyboardFunctionSource('bindNotesHiveDetachDrag');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 393, height: 850 }, hasTouch: true });
const page = await context.newPage(), errors = [], checks = []; let external = 0;
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
  const url = route.request().url();
  if (url === 'https://qianmu.test/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>' });
  for (const file of ['qianmu-theme-surfaces.js', 'qianmu-theme-palette.js']) {
    if (url === 'https://qianmu.test/' + file) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../' + file, import.meta.url), 'utf8') });
  }
  external++; return route.abort();
});
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < .2, `${message}: ${actual} != ${expected}`);

async function mount(appearance = null) {
  await page.evaluate(({ handler, appearance }) => {
    window.controller?.dispose();
    document.body.innerHTML = '<div id="story-director-quick-wheel" style="inset:0;width:100%;height:100%"><div class="sd-wheel-items"><button class="sd-wheel-command is-glass-dark" data-command="notes" data-hive-tone="dark" data-hive-edge-index="1" style="left:150px;top:160px;--sd-wheel-item-size:42px;--sd-wheel-item-height:48px;--sd-wheel-delay:0ms"><span>便笺</span></button></div></div>';
    window.button = document.querySelector('button');
    window.fixture = { settingsSaves: 0, deviceSaves: 0, savedAppearance: null, savedGeometry: null, rendered: 0, opened: 0, closed: 0, notices: 0, lastPointer: null, noteSettings: { detached: false, position: null } };
    Object.assign(window, { notesFeatureSettings: () => fixture.noteSettings, detachedNotesGeometry: () => ({ width: 42, height: 48 }),
      saveSettings: () => {fixture.settingsSaves++;fixture.savedAppearance=structuredClone(fixture.noteSettings.appearance);},
      persistNotesDevice: () => {fixture.deviceSaves++;fixture.savedGeometry={detached:fixture.noteSettings.detached,position:{...fixture.noteSettings.position}};}, renderFloatingNotes: () => fixture.rendered++,
      closeQuickWheel: () => { fixture.closed++; document.getElementById('story-director-quick-wheel')?.remove(); },
      toast: () => fixture.notices++ });
    button.addEventListener('pointerdown', event => fixture.lastPointer = event.pointerId);
    new Function(handler + ';bindNotesHiveDetachDrag(window.button,{id:"notes"},{itemSize:42});')();
    button.addEventListener('click', () => fixture.opened++);
    controller = theme.createQianmuThemeSurfaceController();
    controller.register(button, { role: 'hive-entry', tone: 'dark', edgeIndex: 1 });
    controller.setTheme(appearance);
  }, { handler, appearance });
  await page.waitForTimeout(420); await frame();
  return measure();
}
async function measure() {
  return page.evaluate(() => {
    const rect = button.getBoundingClientRect(), style = getComputedStyle(button), matrix = new DOMMatrixReadOnly(style.transform);
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tx: matrix.m41, ty: matrix.m42,
      inline: button.style.transform, priority: button.style.getPropertyPriority('transform'), dragging: button.classList.contains('is-undock-dragging'),
      ready: button.classList.contains('is-undock-ready'), capture: button.hasPointerCapture(fixture.lastPointer), touchAction: style.touchAction,
      ink: style.color, edge: style.getPropertyValue('--sd-wheel-edge'), connected: button.isConnected, settingsSaves: fixture.settingsSaves, deviceSaves: fixture.deviceSaves,
      savedAppearance:fixture.savedAppearance,savedGeometry:fixture.savedGeometry,rendered: fixture.rendered, opened: fixture.opened, closed: fixture.closed,
      detached: fixture.noteSettings.detached, position: fixture.noteSettings.position };
  });
}
function clean(result, { committed = false } = {}) {
  assert.equal(result.dragging, false); assert.equal(result.ready, false); assert.equal(result.inline, ''); assert.equal(result.capture, false);
  assert.equal(result.settingsSaves, committed ? 1 : 0); assert.equal(result.deviceSaves, committed ? 1 : 0); assert.equal(result.rendered, committed ? 1 : 0);
  if(committed){assert.deepEqual(result.savedAppearance,{tone:'dark',edgeIndex:1});assert.deepEqual(result.savedGeometry,{detached:true,position:result.position});}
}

try {
  await page.goto('https://qianmu.test/'); await page.addStyleTag({ content: css }); await page.addStyleTag({ content: skin });
  await page.evaluate(async () => window.theme = await import('./qianmu-theme-surfaces.js'));
  // The original normal-priority inline transform is hidden by a finished
  // fill-mode:both animation. Reproduce that precedence on the same live node.
  let start = await mount();
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x + 34, start.y + 22);
  let moved = await measure(); near(moved.tx, 34, 'fixed horizontal movement'); near(moved.ty, 22, 'fixed vertical movement');
  await page.evaluate(() => button.style.setProperty('transform', button.style.transform)); await frame();
  const regression = await measure(); near(regression.tx, 0, 'old animation overrides inline horizontal movement'); near(regression.ty, 0, 'old animation overrides inline vertical movement');
  assert.match(regression.inline, /34px, 22px/); assert.equal(regression.dragging, true);
  await page.evaluate(() => button.style.setProperty('transform', button.style.transform, 'important')); await frame();
  moved = await measure(); near(moved.tx, 34, 'priority restores visual feedback');
  await page.mouse.up(); clean(await measure());
  checks.push('regression reproduced: ordinary inline has 34/22 displacement but animation renders 0/0; important renders 34/22');

  for (const appearance of [null, { theme: 'editorial', mode: 'light', accent: '#97324d' }, { theme: 'glass', mode: 'dark', accent: '#425fac' }]) {
    start = await mount(appearance); assert.equal(start.touchAction, 'none');
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x + 24, start.y - 19);
    moved = await measure(); near(moved.x, start.x + 24, 'mouse follows pointer x'); near(moved.y, start.y - 19, 'mouse follows pointer y');
    assert.equal(moved.capture, true); assert.equal(moved.ready, false); assert.equal(moved.settingsSaves, 0); assert.equal(moved.deviceSaves, 0);
    await page.evaluate(() => controller.setTheme({ theme: 'glass', mode: 'light', accent: '#cf573d' })); await frame();
    const recolored = await measure(); near(recolored.x, moved.x, 'theme change retains dragged x'); near(recolored.y, moved.y, 'theme change retains dragged y');
    assert.equal(recolored.capture, true); assert.equal(recolored.connected, true); assert.notEqual(recolored.edge, start.edge);
    await page.mouse.move(start.x + 96, start.y + 82);
    moved = await measure(); near(moved.tx, 96, 'continued mouse movement x'); near(moved.ty, 82, 'continued mouse movement y'); assert.equal(moved.ready, true);
    await page.mouse.up(); const end = await measure(); clean(end, { committed: true }); assert.equal(end.detached, true); assert.equal(end.opened, 0);
    near(end.position.x, start.x + 96 - 21, 'drop position x'); near(end.position.y, start.y + 82 - 24, 'drop position y');
    checks.push(`${appearance?.theme || 'classic'}: mouse-follow feedback survives palette change; release saves device geometry and the detached cell appearance separately once`);
  }

  start = await mount(); await page.mouse.click(start.x, start.y);
  let end = await measure(); clean(end); assert.equal(end.opened, 1); checks.push('ordinary click still opens notes without detaching');
  start = await mount(); await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x + 4, start.y + 3); await page.mouse.up();
  end = await measure(); clean(end); assert.equal(end.opened, 1); checks.push('sub-threshold pointer jitter remains an ordinary click');

  for (const cancellation of ['pointercancel', 'lostcapture', 'remove']) {
    start = await mount(); await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x + 85, start.y + 10);
    assert.equal((await measure()).ready, true);
    await page.evaluate(cancellation => {
      if (cancellation === 'pointercancel') button.dispatchEvent(new PointerEvent('pointercancel', { pointerId: fixture.lastPointer, bubbles: true }));
      else if (cancellation === 'lostcapture') button.releasePointerCapture(fixture.lastPointer);
      else document.getElementById('story-director-quick-wheel').remove();
    }, cancellation);
    await page.mouse.move(start.x + 90, start.y + 15); await page.mouse.up(); await frame();
    end = await measure();
    if (cancellation !== 'remove') clean(end);
    assert.equal(end.settingsSaves, 0); assert.equal(end.deviceSaves, 0); assert.equal(end.rendered, 0); assert.equal(end.detached, false); assert.equal(end.opened, 0);
    checks.push(`${cancellation}: no detachment or synthetic write, pointer state released for connected cell`);
  }

  const cdp = await context.newCDPSession(page);
  for (const ending of ['touchEnd', 'touchCancel']) {
    start = await mount({ theme: 'editorial', mode: 'dark', accent: '#895db4' });
    const point = (x, y, id = 1) => ({ x, y, id, radiusX: 1, radiusY: 1, force: .8 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(start.x, start.y)] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(start.x + 26, start.y + 24)] }); await frame();
    moved = await measure(); assert.equal(moved.capture, true); assert.equal(moved.dragging, true); near(moved.tx, 26, 'touch follows x'); near(moved.ty, 24, 'touch follows y');
    await page.evaluate(() => controller.setTheme({ theme: 'glass', mode: 'light', accent: '#51a38d' }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(start.x + 84, start.y + 78)] }); await frame();
    moved = await measure(); assert.equal(moved.ready, true); near(moved.tx, 84, 'touch continues through recolor'); assert.equal(moved.settingsSaves, 0); assert.equal(moved.deviceSaves, 0);
    await cdp.send('Input.dispatchTouchEvent', { type: ending, touchPoints: [] }); await frame();
    end = await measure(); clean(end, { committed: ending === 'touchEnd' }); assert.equal(end.detached, ending === 'touchEnd'); assert.equal(end.opened, 0);
    checks.push(`native ${ending}: touch follows pointer through theme change, no browser pan takeover and correct commit/cancel cleanup`);
  }
  await cdp.detach();
  assert.deepEqual(errors, []); assert.equal(external, 0);
  console.log(JSON.stringify({ passed: checks.length, checks, errors, external, productionDataRead: false, productionWrites: false,
    scope: 'real CSS and detach handler, native mouse and CDP touch pointers; account/device storage and opening use separate synthetic counters, not real localStorage; physical-phone acceptance pending' }));
} finally { await context.close(); await browser.close(); }
