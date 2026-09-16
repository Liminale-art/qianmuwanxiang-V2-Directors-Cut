// Real renderer CSS coverage, isolated from ST, credentials, storage and providers.
// Core production mounts are checked separately; this is renderer-level CSS coverage.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { join } from 'node:path';
import { createStoryboardFormFixture, storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const skin = await readFile(new URL('../qianmu-theme-skins.css', import.meta.url), 'utf8');
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage();
const errors = [], checks = [], screenshots = []; let external = 0;
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
  const url = route.request().url();
  if (url === 'https://qianmu.test/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>' });
  for (const file of ['qianmu-theme-surfaces.js', 'qianmu-theme-palette.js', 'qianmu-icon-renderer.js']) {
    if (url === `https://qianmu.test/${file}`) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../' + file, import.meta.url), 'utf8') });
  }
  external++; return route.abort();
});

async function frame() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function inspect() {
  return page.evaluate(() => {
    const root = document.getElementById('story-director-modal'), nav = root.querySelector('.sd-storyboard-nav');
    const fields = [...root.querySelectorAll('input,select,textarea,button')];
    const measured = node => {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      return { color: style.color, background: style.background, radius: style.borderRadius, filter: style.backdropFilter,
        width: rect.width, height: rect.height, x: rect.x, y: rect.y };
    };
    return { window: measured(root.querySelector('.sd-window')), card: measured(root.querySelector('.sd-card')), nav: measured(nav),
      fields: fields.map(node => [node.tagName, node.className, node.disabled, node.hidden]),
      host: measured(document.getElementById('host-control')), html: document.documentElement.getAttribute('style'), body: document.body.getAttribute('style') };
  });
}

try {
  await page.goto('https://qianmu.test/'); await page.addStyleTag({ content: css });
  await page.evaluate(async () => {
    window.themeModule = await import('./qianmu-theme-surfaces.js');
    window.icons = await import('./qianmu-icon-renderer.js');
    // Evaluate final CSS colors using the browser, including color-mix's color(srgb ...).
    window.colorChannels = value => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data];
    };
    window.ratio = (a, b) => {
      const l = c => c.slice(0, 3).reduce((sum, n, i) => sum + [0.2126, 0.7152, 0.0722][i] * (n / 255 <= 0.04045 ? n / 255 / 12.92 : ((n / 255 + 0.055) / 1.055) ** 2.4), 0);
      const x = l(a), y = l(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
    };
  });
  let skinAdded = false;
  for (const family of ['novel', 'openai', 'banana', 'seedream', 'comfy']) {
    const form = createStoryboardFormFixture({ family });
    Object.assign(form.context, { storyboardReconcileGalleryLinks() {}, storyboardVibeLibraryController: null });
    vm.runInContext(['storyboardPageTitle', 'storyboardPageKey', 'renderStoryboardTab'].map(storyboardFunctionSource).join('\n'), form.context);
    const content = form.context.renderStoryboardTab();
    await page.evaluate(content => {
      window.controller?.dispose();
      document.body.innerHTML = `<button id="host-control">ST 原有按钮</button><main id="story-director-modal" class="sd-theme-dream sd-storyboard-mode open"><div class="sd-backdrop"></div><section class="sd-window" role="dialog"><main class="sd-body sd-storyboard-body">${content}</main></section></main>`;
      const root = document.getElementById('story-director-modal');
      root.querySelectorAll('details').forEach(node => node.open = true);
      icons.applyQianmuIcons(root);
      window.controller = themeModule.createQianmuThemeSurfaceController(); controller.register(root);
      window.draft = [...root.querySelectorAll('textarea')].find(node => node.getClientRects().length && !node.disabled);
      if (!draft) throw Error('Real renderer has no visible editable textarea');
      draft.value = '切换主题保留的草稿';
    }, content);
    await page.setViewportSize({ width: 1280, height: 900 }); await frame();
    const classic = await inspect();
    if (!skinAdded) { const style = await page.addStyleTag({ content: skin }); await style.evaluate(node => node.id = 'theme-skin-stylesheet'); skinAdded = true; await frame(); assert.deepEqual(await inspect(), classic, 'new CSS must be a no-op without opt-in'); }
    for (const width of [320, 393, 1280]) for (const theme of ['editorial', 'glass']) for (const mode of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(({ theme, mode }) => {
        draft.focus(); draft.setSelectionRange(1, 4, 'backward');
        controller.setTheme({ theme, mode, accent: '#5c79d3' });
        document.querySelector('.sd-storyboard-scroll').scrollTop = 80;
      }, { theme, mode }); await page.waitForTimeout(380); await frame();
      const result = await page.evaluate(() => {
        const root = document.getElementById('story-director-modal'), nav = root.querySelector('.sd-storyboard-nav');
        const scroller = root.querySelector('.sd-storyboard-scroll'), box = nav.getBoundingClientRect(), windowBox = root.querySelector('.sd-window').getBoundingClientRect();
        const buttons = [...nav.querySelectorAll('button')], card = root.querySelector('.sd-card');
        const contrasts = [...root.querySelectorAll('.text_pole,.sd-btn:not(:disabled)')].filter(node => node.getClientRects().length && !node.disabled).map(node => {
          const style = getComputedStyle(node), bg = colorChannels(style.backgroundColor), fg = colorChannels(style.color);
          return { className: node.className, ratio: ratio(fg, bg), opaque: bg[3] === 255 };
        });
        return { scroll: scroller.scrollTop, overflow: scroller.scrollWidth - scroller.clientWidth,
          focus: document.activeElement === draft, selection: [draft.selectionStart, draft.selectionEnd, draft.selectionDirection], value: draft.value,
          navInside: buttons.every(button => { const r = button.getBoundingClientRect(); return r.left >= box.left - .5 && r.right <= box.right + .5; }) && box.left >= windowBox.left && box.right <= windowBox.right,
          labels: buttons.map(button => [button.getAttribute('aria-label'), getComputedStyle(button.querySelector('span')).display]),
          selectedLabelWidth: nav.querySelector('button.active span').getBoundingClientRect().width,
          floating: getComputedStyle(nav).position, filter: getComputedStyle(card).backdropFilter,
          dreamHidden: getComputedStyle(root.querySelector('.sd-window'), '::before').display,
          bodyHeight: document.documentElement.scrollHeight, viewport: innerHeight, contrasts };
      });
      assert.equal(result.focus, true); assert.deepEqual(result.selection, [1, 4, 'backward']); assert.equal(result.value, '切换主题保留的草稿');
      assert.equal(result.scroll, 80); assert.ok(result.overflow <= 2, `${family}/${width}: scroll overflow ${result.overflow}`);
      assert.equal(result.navInside, true, `${family}/${width}: nav clipped`); assert.ok(result.labels.every(([name]) => name));
      assert.equal(result.floating, theme === 'glass' ? 'absolute' : 'relative');
      assert.equal(result.dreamHidden, 'none'); assert.ok(result.bodyHeight <= result.viewport);
      if (theme === 'editorial') { assert.ok(result.labels.every(([, display]) => display === 'none')); assert.equal(result.filter, 'none'); }
      else { assert.ok(result.labels.every(([, display]) => ['block', 'inline-block'].includes(display))); assert.ok(result.selectedLabelWidth >= 36); assert.match(result.filter, /blur/); }
      assert.ok(result.contrasts.length > 0);
      for (const item of result.contrasts) { assert.equal(item.opaque, true, `${family}/${theme}/${mode}: ${item.className} has a translucent field background`); assert.ok(item.ratio >= 4.5, `${family}/${theme}/${mode}: ${item.className} contrast ${item.ratio}`); }
      assert.deepEqual((await inspect()).fields, classic.fields, 'CSS must not remove, disable or replace functional controls');
      assert.deepEqual((await inspect()).host, classic.host);
      checks.push(`${family}/${width}/${theme}/${mode}: geometry, fields, readability, focus and classic isolation`);
      // Content really passes behind the glass rail and the last control can scroll above it.
      if (theme === 'glass') {
        const safe = await page.evaluate(() => {
          const scroller = document.querySelector('.sd-storyboard-scroll'); scroller.scrollTop = scroller.scrollHeight;
          const controls = [...scroller.querySelectorAll('button,input,select,textarea')].filter(node => node.getClientRects().length);
          return controls.at(-1).getBoundingClientRect().bottom <= document.querySelector('.sd-storyboard-nav').getBoundingClientRect().top;
        }); assert.equal(safe, true, `${family}/${width}: floating rail covers last control`);
      }
      if (process.env.QIANMU_THEME_QA_DIR && family === 'novel' && width !== 320) {
        await mkdir(process.env.QIANMU_THEME_QA_DIR, { recursive: true });
        await page.evaluate(() => document.querySelector('.sd-storyboard-scroll').scrollTop = 0);
        const file = join(process.env.QIANMU_THEME_QA_DIR, `renderer_${theme}_${mode}_${width}.png`);
        await page.screenshot({ path: file }); screenshots.push(file);
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => { controller.setTheme(null); document.querySelector('.sd-storyboard-scroll').scrollTop = 0; draft.blur(); }); await frame();
    assert.deepEqual(await inspect(), classic, 'classic geometry and appearance must restore exactly'); checks.push(`${family}: exact classic restore`);
  }

  for (const theme of ['light', 'dark', 'summer', 'candy', 'kraft', 'dream']) {
    await page.evaluate(theme => {
      const root = document.getElementById('story-director-modal'); root.className = `sd-theme-${theme} sd-storyboard-mode open`;
      document.getElementById('theme-skin-stylesheet').sheet.disabled = true;
    }, theme); await page.waitForTimeout(250); const before = await inspect();
    await page.evaluate(() => document.getElementById('theme-skin-stylesheet').sheet.disabled = false); await frame();
    assert.deepEqual(await inspect(), before, `skin stylesheet changed classic ${theme}`); checks.push(`classic/${theme}: stylesheet on/off is identical`);
  }

  // Transition mechanics on the actual nav node. Production route-node reuse is a separate gate.
  await page.setViewportSize({ width: 393, height: 900 });
  await page.evaluate(() => controller.setTheme({ theme: 'glass', mode: 'light' }));
  await page.waitForTimeout(400);
  const animate = async () => {
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('.sd-storyboard-nav button')];
      buttons.forEach((button, i) => { button.classList.toggle('active', i === 1); button.setAttribute('aria-current', i === 1 ? 'page' : 'false'); });
    });
    await page.waitForTimeout(80);
    return page.evaluate(() => ({ widths: [...document.querySelectorAll('.sd-storyboard-nav button')].map(node => node.getBoundingClientRect().width), duration: getComputedStyle(document.querySelector('.sd-storyboard-nav button')).transitionDuration }));
  };
  const mid = await animate(); assert.ok(mid.widths[1] > 40 && mid.widths[1] < 100); assert.ok(mid.widths[0] > 40 && mid.widths[0] < 100);
  await page.waitForTimeout(360);
  assert.equal(await page.locator('.sd-storyboard-nav button.active').evaluate(node => node.getBoundingClientRect().width), 100);
  await page.emulateMedia({ reducedMotion: 'reduce' }); assert.equal((await animate()).duration, '0s'); checks.push('real nav: intermediate expansion, settled width, reduced motion');

  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  await page.waitForTimeout(380); await frame();
  const reduced = await page.evaluate(() => ({ matches: matchMedia('(prefers-reduced-transparency: reduce)').matches,
    card: getComputedStyle(document.querySelector('.sd-card')).backdropFilter,
    nav: getComputedStyle(document.querySelector('.sd-storyboard-nav')).backdropFilter,
    window: getComputedStyle(document.querySelector('.sd-window')).backgroundImage }));
  assert.deepEqual(reduced, { matches: true, card: 'none', nav: 'none', window: 'none' }); checks.push('reduced transparency: opaque card, nav and canvas');
  await cdp.send('Emulation.setEmulatedMedia', { features: [] }); await cdp.detach();

  // Semantic controls are exercised separately from the production form inventory.
  await page.evaluate(() => {
    const root = document.createElement('dialog'); root.id = 'theme-semantic-probe';
    root.innerHTML = '<button class="sd-btn sd-primary">确认</button><button class="sd-btn sd-danger">删除</button><button class="sd-btn" disabled>不可用</button>';
    document.body.append(root); controller.register(root); root.showModal();
  });
  for (const theme of ['editorial', 'glass']) for (const mode of ['light', 'dark']) for (const accent of ['#000', '#fff', '#ff0000', '#00ff00']) {
    await page.evaluate(options => controller.setTheme(options), { theme, mode, accent }); await page.waitForTimeout(230);
    const semantic = await page.evaluate(() => [...document.querySelectorAll('#theme-semantic-probe button')].map(node => {
      const style = getComputedStyle(node); return { ratio: ratio(colorChannels(style.color), colorChannels(style.backgroundColor)),
        color: style.color, bg: style.backgroundColor, disabled: node.disabled };
    }));
    assert.ok(semantic[0].ratio >= 4.5); assert.ok(semantic[1].ratio >= 4.5);
    assert.notEqual(semantic[0].bg, semantic[1].bg); assert.equal(semantic[2].disabled, true);
    checks.push(`semantic controls/${theme}/${mode}/${accent}: readable primary and distinct danger`);
  }
  await page.evaluate(() => { const dialog = document.getElementById('theme-semantic-probe'); dialog.close(); dialog.remove(); });

  // Notes use the actual editor renderer, including its own classic surface variables.
  const notesContext = vm.createContext({ notesSearch: '', notesRuntime: [], notesActiveId: 'n', notesFind: () => ({ id: 'n', body: '独立便笺草稿' }),
    notesFeatureSettings: () => ({ editorFontSize: 13 }), NOTES_EDITOR_FONT_SIZES: [13, 15], htmlEscape: value => String(value) });
  vm.runInContext(storyboardFunctionSource('renderNotesPanel'), notesContext);
  await page.evaluate(content => {
    controller.dispose(); document.getElementById('story-director-modal').remove();
    const root = document.createElement('div'); root.id = 'qianmu-notes-panel-layer'; root.className = 'sd-theme-dark'; root.innerHTML = content; document.body.append(root);
    controller = themeModule.createQianmuThemeSurfaceController(); controller.register(root); window.note = root.querySelector('textarea'); note.focus(); note.setSelectionRange(1, 3);
  }, notesContext.renderNotesPanel());
  for (const theme of ['editorial', 'glass']) for (const mode of ['light', 'dark']) {
    const note = await page.evaluate(({ theme, mode }) => {
      controller.setTheme({ theme, mode });
      const style = getComputedStyle(window.note), bg = colorChannels(style.backgroundColor), expected = colorChannels(controller.snapshot.css['--qm-bg']);
      return { color: colorChannels(style.color), expectedInk: colorChannels(controller.snapshot.css['--qm-ink']), bg, expected,
        active: document.activeElement === window.note, value: window.note.value, selection: [window.note.selectionStart, window.note.selectionEnd] };
    }, { theme, mode });
    assert.deepEqual(note.color, note.expectedInk);
    // Canvas round-trips premultiplied 8-bit alpha; allow one channel step, not a different palette.
    assert.ok(note.bg.slice(0, 3).every((channel, index) => Math.abs(channel - note.expected[index]) <= 1)); assert.ok(note.bg[3] >= 229);
    assert.equal(note.active, true); assert.equal(note.value, '独立便笺草稿'); assert.deepEqual(note.selection, [1, 3]); checks.push(`independent notes/${theme}/${mode}: classic local color override and live editor`);
  }
  assert.deepEqual(errors, []); assert.equal(external, 0);
  console.log(JSON.stringify({ passed: checks.length, checks, errors, external, screenshots, productionDataRead: false, scope: 'real isolated renderer skins; production wiring and real phone remain pending' }));
} finally { await context.close(); await browser.close(); }
