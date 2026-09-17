// Material-only checks with real form/notes renderers and production CSS.
// All state is synthetic; no ST account, media, storage or provider is accessed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { createStoryboardFormFixture, storyboardFunctionSource } from '../tests/helpers/storyboard-form-fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const styles = await Promise.all(['style.css', 'qianmu-theme-skins.css'].map(file => readFile(new URL('../' + file, import.meta.url), 'utf8')));
const browser = await chromium.launch({ channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true });
const context = await browser.newContext(), page = await context.newPage();
const checks = [], errors = []; let external = 0;
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', async route => {
  const url = route.request().url();
  if (url === 'https://qianmu.test/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>' });
  for (const file of ['qianmu-theme-surfaces.js', 'qianmu-theme-palette.js']) {
    if (url === `https://qianmu.test/${file}`) return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL('../' + file, import.meta.url), 'utf8') });
  }
  external++; return route.abort();
});

const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function captureClassic() {
  return page.evaluate(() => [...document.querySelectorAll('#story-director-modal button,#story-director-modal input,#story-director-modal select,#story-director-modal textarea,#story-director-modal .sd-card,#story-director-modal h2,#host-control')].map(node => {
    const css = getComputedStyle(node), rect = node.getBoundingClientRect();
    return [node.tagName, node.className, css.borderRadius, css.backgroundImage, css.color, css.webkitTextFillColor, rect.width, rect.height];
  }));
}

try {
  await page.goto('https://qianmu.test/');
  for (const content of styles) await page.addStyleTag({ content });
  await page.evaluate(async () => window.theme = await import('./qianmu-theme-surfaces.js'));
  for (const family of ['novel', 'openai', 'comfy']) {
    const fixture = createStoryboardFormFixture({ family });
    await page.evaluate(content => {
      window.controller?.dispose();
      document.body.innerHTML = `<button id="host-control" style="border-radius:13px">ST 控件</button>
        <main id="story-director-modal" class="sd-theme-dream open"><section class="sd-window">
        <header class="sd-header"><div class="sd-titlebox"><h2>千幕</h2><span class="sd-version-tag">v.test</span></div>
        <button class="sd-theme-opt">纸间</button><button class="sd-close">关闭</button></header>
        <main class="sd-body">${content}<section class="sd-card" id="semantic-probe">
        <div class="sd-reader-setup-identity"><button data-coread-identity="user">头像</button></div>
        <input type="radio" checked><input type="checkbox" id="multi-select-probe" checked><label class="checkbox_label"><input type="checkbox" checked>启用</label>
        <img alt="圆形头像" style="width:24px;height:24px;border-radius:50%">
        <div class="sd-focus-phase-tabs"><button class="sd-focus-phase">专注</button></div>
        <button class="sd-focus-sound-preview">播放</button>
        <label class="sd-btn">导入<input type="file" hidden></label>
        </section></main></section></main>`;
      window.root = document.getElementById('story-director-modal');
      root.querySelectorAll('details').forEach(node => node.open = true);
      window.controller = theme.createQianmuThemeSurfaceController(); controller.register(root);
      window.draft = [...root.querySelectorAll('textarea')].find(node => !node.disabled && node.getClientRects().length);
      if (!draft) throw Error('Missing real editable form field');
      draft.value = '切换外观仍保留这份草稿';
      window.originalFields = [...root.querySelectorAll('button,input,textarea,select')];
    }, fixture.content);
    for (const width of [320, 393, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => controller.setTheme(null)); await page.waitForTimeout(250); await frame();
      const classic = await captureClassic();
      for (const theme of ['editorial', 'glass']) for (const mode of ['light', 'dark']) {
        await page.evaluate(options => {
          draft.focus(); draft.setSelectionRange(1, 5);
          controller.setTheme(options);
        }, { theme, mode, accent: '#975264' }); await page.waitForTimeout(250); await frame();
        const result = await page.evaluate(() => {
          const root = window.root, title = getComputedStyle(root.querySelector('h2'));
          const fields = [...root.querySelectorAll('button:not([data-coread-identity]):not(.sd-world-edge):not([role="switch"]),input:not([type=radio]):not([type=checkbox]):not([type=range]),textarea,select,label.sd-btn')];
          const round = selector => getComputedStyle(root.querySelector(selector)).borderRadius;
          const radius = node => ({ tag: node.tagName, cls: node.className, radius: getComputedStyle(node).borderRadius });
          const roundedGroups = [...root.querySelectorAll('div,section,article,fieldset,label,nav')].filter(node => {
            const css = getComputedStyle(node), rect = node.getBoundingClientRect();
            return rect.width > 50 && rect.height > 25 && parseFloat(css.borderTopLeftRadius) > 0;
          }).map(radius);
          return { fields: fields.map(radius), cards: [...root.querySelectorAll('.sd-card,details,details>summary,.sd-focus-phase-tabs,.sd-version-tag')].map(radius), roundedGroups,
            shell: round('.sd-window'), title: { fill: title.webkitTextFillColor, color: title.color, background: title.backgroundImage },
            avatar: round('[data-coread-identity]'), radio: round('#semantic-probe [type=radio]'), checkbox: round('#multi-select-probe'), toggle: round('#semantic-probe .checkbox_label > input'), image: round('#semantic-probe img'),
            host: getComputedStyle(document.getElementById('host-control')).borderRadius,
            connected: originalFields.every(node => node.isConnected), active: document.activeElement === draft,
            value: draft.value, selection: [draft.selectionStart, draft.selectionEnd] };
        });
        if (theme === 'editorial') {
          for (const item of [...result.fields, ...result.cards]) assert.equal(item.radius, '0px', `${family}/${width}/${mode}: ${item.tag}.${item.cls}`);
          assert.equal(result.shell, '0px');
          assert.equal(result.title.background, 'none'); assert.equal(result.title.fill, result.title.color);
          assert.deepEqual(result.roundedGroups, [], `${family}/${width}/${mode}: rectangular functional group containers`);
        } else {
          assert.equal(result.shell, '30px'); assert.equal(result.cards.find(item => item.cls === 'sd-card').radius, '22px');
        }
        assert.equal(result.avatar, '50%'); assert.equal(result.radio, '50%'); assert.equal(result.toggle, '999px'); assert.equal(result.image, '50%');
        assert.equal(result.checkbox, theme === 'editorial' ? '0px' : '4px');
        assert.equal(result.host, '13px'); assert.equal(result.connected, true); assert.equal(result.active, true);
        assert.equal(result.value, '切换外观仍保留这份草稿'); assert.deepEqual(result.selection, [1, 5]);
        checks.push(`${family}/${width}/${theme}/${mode}: control family, monocolor paper title, semantic circles, draft and host isolation`);
      }
      await page.evaluate(() => { controller.setTheme(null); draft.blur(); }); await page.waitForTimeout(250); await frame();
      assert.deepEqual(await captureClassic(), classic); checks.push(`${family}/${width}: classic styles and geometry restored`);
    }
  }

  // Resize only the panel while keeping the viewport unchanged: round fields
  // retain exactly the same radii instead of stretching with width/height.
  for (const mode of ['light', 'dark']) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(mode => controller.setTheme({ theme: 'glass', mode, accent: '#5c79d3' }), mode);
    let image;
    for (const [width, height] of [[1100, 400], [400, 800], [720, 720], [300, 200]]) {
      const result = await page.evaluate(({ width, height }) => {
        const shell = root.querySelector('.sd-window');
        for (const [name, value] of Object.entries({ width: `${width}px`, height: `${height}px`, minWidth: '0', maxWidth: 'none', minHeight: '0', maxHeight: 'none' })) shell.style[name] = value;
        shell.style.setProperty('width', width + 'px', 'important'); shell.style.setProperty('height', height + 'px', 'important');
        const style = getComputedStyle(shell), box = shell.getBoundingClientRect();
        return { image: style.backgroundImage, width: box.width, height: box.height };
      }, { width, height });
      assert.equal(result.width, width); assert.equal(result.height, height);
      // CSSOM may omit the optional "circle" keyword for a single pixel radius.
      const circles = [...result.image.matchAll(/radial-gradient\((?:circle )?([\d.]+)px at /g)].map(match => +match[1]);
      assert.equal(circles.length, 2, result.image); assert.ok(circles[0] > circles[1]);
      if (image) assert.equal(result.image, image); else image = result.image;
      checks.push(`glass/${mode}/${width}x${height}: two undistorted circular fields retain primary/secondary balance`);
    }
  }
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  assert.equal(await page.locator('.sd-window').evaluate(node => getComputedStyle(node).backgroundImage), 'none');
  await cdp.send('Emulation.setEmulatedMedia', { features: [] }); await cdp.detach();
  checks.push('reduced transparency disables both glow fields');

  // Independent notes use their actual renderer. Modal controls reuse the exact
  // class structures used by registered route-picker and cleanup portals.
  const notes = vm.createContext({ notesSearch: '', notesRuntime: [], notesActiveId: 'n', notesFind: () => ({ id: 'n', body: '独立便笺草稿' }),
    notesFeatureSettings: () => ({ editorFontSize: 13 }), NOTES_EDITOR_FONT_SIZES: [13, 15], htmlEscape: value => String(value) });
  vm.runInContext(storyboardFunctionSource('renderNotesPanel'), notes);
  await page.evaluate(content => {
    controller.dispose(); document.body.innerHTML = `<div id="qianmu-notes-panel-layer" class="sd-theme-dark">${content}</div>
      <dialog class="sd-comfy-route-dialog"><div class="popup-controls"><button class="menu_button popup-button-ok">确认</button></div><input class="text_pole"></dialog>
      <div id="qianmu-storage-cleanup-layer"><section class="sd-storage-cleanup-dialog"><div class="sd-storage-chat-group"><label>聊天</label></div><button class="sd-btn">删除所选</button></section></div>`;
    controller = theme.createQianmuThemeSurfaceController();
    [...document.body.children].forEach(node => controller.register(node));
    window.note = document.querySelector('#qianmu-notes-panel-layer textarea'); note.focus(); note.setSelectionRange(1, 3);
  }, notes.renderNotesPanel());
  for (const mode of ['light', 'dark']) {
    await page.evaluate(mode => controller.setTheme({ theme: 'editorial', mode }), mode); await frame();
    const result = await page.evaluate(() => ({
      corners: [...document.querySelectorAll('button,input,textarea,.sd-notes-panel,.sd-storage-cleanup-dialog,.sd-storage-chat-group,.sd-storage-chat-group label')].map(node => [node.className, getComputedStyle(node).borderRadius]),
      active: document.activeElement === note, value: note.value, selection: [note.selectionStart, note.selectionEnd],
    }));
    for (const [name, radius] of result.corners) assert.equal(radius, '0px', `portal/${mode}: ${name}`);
    assert.equal(result.active, true); assert.equal(result.value, '独立便笺草稿'); assert.deepEqual(result.selection, [1, 3]);
    checks.push(`editorial/${mode}: detached notes and registered portal controls follow rectangular system without remounting`);
  }
  assert.deepEqual(errors, []); assert.equal(external, 0);
  console.log(JSON.stringify({ passed: checks.length, checks, errors, external, productionDataRead: false,
    scope: 'isolated real form/notes renderers, native CSS geometry; physical-phone and live-ST visual acceptance remain pending' }));
} finally { await context.close(); await browser.close(); }
