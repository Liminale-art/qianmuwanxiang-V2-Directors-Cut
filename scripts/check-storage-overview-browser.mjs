// Real storage renderer and stylesheet, isolated accounting fixtures only.
// This never reads a user's database or executes a backup / cleanup operation.
import assert from 'node:assert/strict';
import {mkdir, readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import vm from 'node:vm';
import {renderStorageBackupSection, replaceStorageManagementCard, collectionCleanupOptions, storageOverviewSegments, STORAGE_CATEGORY_LABELS, STORAGE_CATEGORY_COLORS} from '../qianmu-storage-backup-view.js';
import {storyboardFunctionSource as section} from '../tests/helpers/storyboard-form-fixture.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.QIANMU_PLAYWRIGHT_MODULE || 'playwright');
const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
const MB = 1024 * 1024;
const snapshot = {sampledAt: 1, origin: {available: true, usage: 500 * MB, quota: 2000 * MB}, trackedBytes: 400 * MB, manageableBytes: 400 * MB,
  categories: [{category: 'images', bytes: 240 * MB}, {category: 'audio', bytes: 120 * MB}, {category: 'reader', bytes: 40 * MB}],
  idb: {chatScopes: ['fixture']}, recipeStorage:{status:'ready',state:'present',files:10,bytes:5*MB,limitFiles:4096,limitBytes:256*MB}, vibeStorage: {status: 'ready', assets: {count: 0, bytes: 0}, previews: {bytes: 0}, records: {count: 0, bytes: 0}, metadata: {bytes: 0}},
  restoreStorage: {status: 'ready', count: 0, bytes: 0}, mappingStorage: {status: 'ready', count: 0, bytes: 0}, carrierStorage: {status: 'ready', count: 0, bytes: 0},
  characterStorage: {status: 'ready', documents: {count: 0, bytes: 0}, bindings: {count: 0, bytes: 0}, indexes: {bytes: 0}},
  comfyStorage: {status: 'ready'}, focusLibrary: {status: 'ready', bytes: 0, count: 0}, notesStorage: {status:'ready',bytes:200,count:3,pinned:1}};
function render(data = snapshot, status = 'ready') {
  const state = vm.createContext({renderStorageBackupSection, collectionCleanupOptions, storageOverviewSegments, STORAGE_CATEGORY_LABELS, STORAGE_CATEGORY_COLORS, storageInventoryState: {data, status, error: 'fixture inventory unavailable'},
    optionalServiceState: {status: 'ready', services: [], version: 'fixture'}, VERSION: '1.59.390',
    htmlEscape: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    formatStorageBytes: bytes => `${((Number(bytes) || 0) / MB).toFixed(1)} MB`, blobStore: {classifyStoragePressure: () => ({level: 'normal'})}});
  vm.runInContext(['optionalServiceLabel', 'optionalServiceLatestDisplay', 'optionalServiceDetail', 'renderStorageServiceStatus', 'renderStorageManagementCard'].map(section).join('\n'), state);
  return state.renderStorageManagementCard();
}

const browser = await chromium.launch({channel: process.env.QIANMU_BROWSER_CHANNEL || undefined, headless: true});
const context = await browser.newContext(), errors = [], checks = [];
let external = 0;
await context.route('**/*', async route => {
  const url = route.request().url();
  if (url === 'https://qianmu.test/') return route.fulfill({contentType: 'text/html', body: '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>'});
  if (url === 'https://qianmu.test/qianmu-icon-renderer.js') return route.fulfill({contentType: 'text/javascript', body: await readFile(new URL('../qianmu-icon-renderer.js', import.meta.url), 'utf8')});
  for(const file of ['qianmu-theme-surfaces.js','qianmu-theme-palette.js','qianmu-storage-backup-view.js'])if(url===`https://qianmu.test/${file}`)return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../'+file,import.meta.url),'utf8')});
  // Stylesheet background art does not belong to the storage renderer under test.
  if (url.startsWith('https://qianmu.test/') && /\.(?:png|jpe?g|webp|woff2?)(?:\?|$)/.test(url)) return route.fulfill({status: 204, body: ''});
  external++; return route.abort();
});
try {
  const page = await context.newPage();
  if (process.env.QIANMU_STORAGE_SCREENSHOT_DIR) await mkdir(process.env.QIANMU_STORAGE_SCREENSHOT_DIR, {recursive: true});
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://qianmu.test/');
  await page.evaluate(async()=>{
    Object.assign(window,await import('/qianmu-storage-backup-view.js'));
    for(const name of ['coreadExportData','exportTtsFavoritesBackup','ttsExportAudioCache','exportPinnedNotesBackup','storyboardImportAnyPackage','coreadImportDataFile'])window[name]=()=>{throw Error('Unexpected transfer: '+name);};
  });
  await page.addStyleTag({content: css});
  await page.addStyleTag({content:await readFile(new URL('../qianmu-theme-skins.css',import.meta.url),'utf8')});
  await page.addStyleTag({content: 'body{margin:0;background:#555}#story-director-modal{box-sizing:border-box}#story-director-modal .sd-storage-card{width:min(620px,100%);box-sizing:border-box;margin:0 auto}'});
  for (const width of [320, 393, 768, 1280]) for (const theme of ['light', 'dark', 'summer', 'candy', 'kraft', 'dream']) {
    await page.setViewportSize({width, height: 898});
    const metrics = await page.evaluate(async ({html, theme}) => {
      document.body.innerHTML = `<div id="story-director-modal" class="open sd-theme-${theme}"><div class="sd-backdrop"></div><section class="sd-window"><main class="sd-body">${html}</main></section></div>`;
      const root = document.getElementById('story-director-modal');
      (await import('/qianmu-icon-renderer.js')).applyQianmuIcons(root);
      const expanded = root.querySelectorAll('details[open]').length;
      root.querySelector('.sd-storage-backup-section').open = true;
      const hero = root.querySelector('.sd-storage-hero b'), legend = root.querySelector('.sd-storage-legend');
      const rows = [...legend.children].map(row => row.getBoundingClientRect());
      const buttons = [...root.querySelectorAll('.sd-storage-manage-actions button')].map(button => button.getBoundingClientRect());
      return {overflow: root.scrollWidth > root.clientWidth || document.documentElement.scrollWidth > innerWidth,
        heroSize: parseFloat(getComputedStyle(hero).fontSize), heroText: hero.textContent,
        rowsAligned: rows.every(row => Math.abs(row.left - rows[0].left) < 1 && Math.abs(row.right - rows[0].right) < 1),
        minRowHeight: Math.min(...rows.map(row => row.height)), minButtonHeight: Math.min(...buttons.map(row => row.height)),
        icons: [...root.querySelectorAll('.fa-arrow-right svg')].map(svg => svg.getAttribute('data-qm-glyph')),
        backups: root.querySelectorAll('.sd-storage-backup-section').length, expanded};
    }, {html: render(), theme});
    assert.equal(metrics.overflow, false, `${theme}/${width} overflows`);
    assert.ok(metrics.heroSize >= 30, `${theme}/${width}: hero ${metrics.heroSize}px`);
    assert.equal(metrics.heroText, '400.0 MB');
    assert.equal(metrics.rowsAligned, true); assert.ok(metrics.minRowHeight >= 41); assert.ok(metrics.minButtonHeight >= 44);
    assert.deepEqual(metrics.icons, ['qm-regular-arrow-right']); assert.equal(metrics.backups, 1); assert.equal(metrics.expanded, 0);
    if (process.env.QIANMU_STORAGE_SCREENSHOT_DIR && ((width === 393 && theme === 'dark') || (width === 1280 && theme === 'light'))) {
      await page.screenshot({path: join(process.env.QIANMU_STORAGE_SCREENSHOT_DIR, `storage-real-renderer-${theme}-${width}.png`), fullPage: true});
    }
    await page.locator('.sd-storage-backup-section > summary').click();
    assert.equal(await page.locator('.sd-storage-backup-section').getAttribute('open'), null);
    await page.locator('.sd-storage-backup-section > summary').click();
    assert.equal(await page.locator('.sd-storage-backup-section').getAttribute('open'), '');
    assert.equal(await page.locator('.sd-storage-details').count(), 0);
    assert.equal(await page.locator('.sd-storage-backup-section .sd-storage-clean').count(), 1);
    assert.equal(await page.locator('.sd-storage-backup-section .sd-storage-characters').count(), 0);
    const recipe=page.locator('.sd-storage-resource-list .sd-storage-backup-row').filter({hasText:'图片配置'});
    assert.equal(await recipe.count(),1);assert.match(await recipe.textContent(),/图片配置5.0 MB/);assert.equal(await recipe.locator('button').count(),0);
    checks.push(`${theme}/${width}: single resource list, real layout, local arrows, unique controls`);
  }
  for(const width of [320,393,1280])for(const theme of ['editorial','glass'])for(const mode of ['light','dark']){
    await page.setViewportSize({width,height:898});
    const result=await page.evaluate(async ({html,theme,mode})=>{
      window.storageTheme?.dispose();document.body.innerHTML=`<div id="story-director-modal" class="open sd-theme-light"><section class="sd-window"><main class="sd-body">${html}</main></section></div>`;
      const root=document.getElementById('story-director-modal'),{createQianmuThemeSurfaceController}=await import('/qianmu-theme-surfaces.js');
      window.storageTheme=createQianmuThemeSurfaceController();storageTheme.register(root);storageTheme.setTheme({theme,mode,accent:'#5c79d3'});
      root.querySelectorAll('details').forEach(item=>item.open=true);await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
      const row=[...root.querySelectorAll('.sd-storage-resource-list .sd-storage-backup-row')].find(row=>row.firstElementChild.textContent==='图片配置'),card=root.querySelector('.sd-storage-card'),box=row.getBoundingClientRect();
      return {fit:box.left>=0&&box.right<=innerWidth&&row.scrollWidth<=row.clientWidth,hero:root.querySelector('.sd-storage-hero b').textContent,
        row:row.textContent,radius:getComputedStyle(card).borderRadius,inputs:root.querySelectorAll('input[data-storage-import="notes"]').length};
    },{html:render(),theme,mode});
    assert.equal(result.fit,true,`${width}/${theme}/${mode}`);assert.equal(result.hero,'400.0 MB');assert.match(result.row,/5.0 MB/);assert.equal(result.inputs,1);assert.equal(result.radius,theme==='editorial'?'0px':'22px');
    checks.push(`${theme}/${mode}/${width}: server row fits themed resource list and does not alter browser totals`);
  }
  await page.evaluate(()=>window.storageTheme?.dispose());
  for (const status of ['loading', 'error']) {
    await page.evaluate(html => {document.querySelector('#story-director-modal .sd-body').innerHTML = html;}, render(null, status));
    assert.equal(await page.locator('.sd-storage-hero').count(), 0);
    assert.equal(await page.locator('.sd-storage-backup-section').count(), 1);
    assert.equal(await page.locator('.sd-storage-clean').count(), status === 'loading' ? 1 : 0);
    if(status==='loading')assert.equal(await page.locator('.sd-storage-clean').isDisabled(),true);
    assert.equal(await page.locator('.sd-storage-service-refresh').count(), 1);
    assert.equal(await page.locator('.sd-storage-card > :last-child').getAttribute('class'), 'sd-storage-service');
    checks.push(`${status}: no fake total or cleanup, backup remains available`);
  }
  const changed=structuredClone(snapshot);changed.notesStorage={status:'ready',count:7,pinned:2,bytes:400};
  changed.recipeStorage={status:'unavailable',files:null,bytes:null,error:'配套后端尚未读取'};
  const summaryRefresh=await page.evaluate(({before,after,replace})=>{
    document.body.innerHTML=before;const card=document.querySelector('.sd-storage-card'),backup=card.querySelector('.sd-storage-backup-section');
    backup.open=true;const input=backup.querySelector('input[data-storage-import="notes"]'),button=backup.querySelector('[data-storage-export="notes"]');
    button.focus();let clicks=0;button.addEventListener('click',()=>clicks++);
    (0,eval)(`(${replace})`)(card,after,{icons(){},bind(){}});button.click();
    return {sameInput:input===document.querySelector('input[data-storage-import="notes"]'),sameBackup:backup===document.querySelector('.sd-storage-backup-section'),open:backup.open,clicks,
      recipe:[...backup.querySelectorAll('.sd-storage-resource-list .sd-storage-backup-row')].find(row=>row.firstElementChild.textContent==='图片配置').textContent};
  },{before:render(),after:render(changed),replace:replaceStorageManagementCard.toString()});
  assert.equal(summaryRefresh.sameInput&&summaryRefresh.sameBackup&&summaryRefresh.open,true);assert.equal(summaryRefresh.clicks,1);
  checks.push('inventory refresh retains the original backup file chooser, listeners and disclosure');
  assert.match(summaryRefresh.recipe,/暂未读取/);assert.doesNotMatch(summaryRefresh.recipe,/5.0 MB|0.0 MB/);checks.push('server observation refresh clears stale numbers without replacing live backup inputs');
  const resourceRefresh=await page.evaluate(async ({before,after,loading,failed,replace,source})=>{
    Object.assign(window,{settings:{},configUndo:{available:()=>false},MODAL_ID:'story-director-modal',storageInventoryState:{data:{mappingStorage:{namespace:'before'}}}});
    let calls=0;window.storyboardOpenRestoreStorage=()=>{calls++;};
    const bind=new Function(source+';return bindStorageManagementEvents;')(),swap=(0,eval)(`(${replace})`);
    document.body.innerHTML=`<div id="story-director-modal" class="open">${before}</div>`;
    let card=document.querySelector('.sd-storage-card');const backup=card.querySelector('.sd-storage-backup-section'),input=backup.querySelector('input[data-storage-import="notes"]');
    backup.open=true;const dt=new DataTransfer();dt.items.add(new File(['fixture'],'keep.json'));input.files=dt.files;
    bind(card);bind(card);
    if(card.querySelector('.sd-storage-mappings'))throw Error('removed duplicate manager returned');
    for(let i=0;i<3;i++) {
      storageInventoryState.data.mappingStorage.namespace='after';
      swap(card,after,{icons(){},bind});card=document.querySelector('.sd-storage-card');bind(card);
    }
    const stable=input===card.querySelector('input[data-storage-import="notes"]')&&input.files[0]?.name==='keep.json'&&backup.open;
    const manager=calls===0&&card.querySelectorAll('button.sd-storage-mappings,button.sd-storage-characters').length===0;
    const updated=card.querySelector('.sd-storage-resource-list').textContent.includes('角色资料8.0 MB');
    swap(card,loading,{icons(){},bind});card=document.querySelector('.sd-storage-card');
    const pending=card.querySelector('.sd-storage-clean').disabled&&card.querySelector('.sd-storage-chat-clean').disabled;
    swap(card,failed,{icons(){},bind});card=document.querySelector('.sd-storage-card');
    const error=card.querySelectorAll('.sd-storage-clean,.sd-storage-chat-clean,.sd-storage-mappings').length===0&&input===card.querySelector('input[data-storage-import="notes"]');
    return {stable,manager,updated,pending,error};
  },{before:render(),after:render({...snapshot,characterStorage:{...snapshot.characterStorage,documents:{count:8,bytes:8*MB}}}),loading:render(snapshot,'loading'),failed:render(null,'error'),replace:replaceStorageManagementCard.toString(),source:section('bindStorageManagementEvents')});
  for(const [key,value]of Object.entries(resourceRefresh)){assert.equal(value,true,key);checks.push(`resource refresh ${key}`);}
  const serviceSource = ['optionalServiceLabel', 'optionalServiceLatestDisplay', 'optionalServiceDetail', 'paintOptionalServiceState', 'refreshOptionalServiceState', 'bindStorageManagementEvents'].map(section).join('\n');
  const serviceChecks = await page.evaluate(async ({html, source, replace}) => {
    document.body.innerHTML = `<div id="story-director-modal" class="open"><div class="sd-body" style="height:400px;overflow:auto"><input class="api-draft" value="https://unsaved.invalid/v1"><div style="height:200px"></div>${html}<div style="height:800px"></div></div></div>`;
    Object.assign(window, {MODAL_ID: 'story-director-modal', VERSION: '1.59.390', optionalServiceState: {status: 'idle', services: [], checkedAt: 0}, optionalServiceProbePromise: null,
      settings: {}, configUndo: {available: () => false}, ctx: () => ({getRequestHeaders: () => ({})}), probeCount: 0,
      renderModal: () => {throw Error('Unexpected modal redraw');}, paintStorageManagementCard: () => {throw Error('Unexpected card redraw');},
      storyboardPaintVideoConnectionState: async () => {}, refreshQianmuUpdateStatus: async () => {},
      featureRuntime: {load: async () => ({probeQianmuOptionalService: async () => {probeCount++; return new Promise(resolve => {window.resolveProbe = resolve;});}})}});
    (0, eval)(source); window.replaceCard = (0, eval)(`(${replace})`);
    const root = document.getElementById(MODAL_ID), body = root.querySelector('.sd-body'), draft = root.querySelector('.api-draft');
    bindStorageManagementEvents(root); bindStorageManagementEvents(root);
    draft.focus(); draft.setSelectionRange(8, 15); body.scrollTop = 150;
    const savedTop = body.scrollTop, card = root.querySelector('.sd-storage-card'), button = card.querySelector('.sd-storage-service-refresh');
    button.click(); button.click(); await new Promise(resolve => setTimeout(resolve, 0));
    const checking = probeCount === 1 && button.getAttribute('aria-busy') === 'true';
    const pending = optionalServiceProbePromise;
    resolveProbe({status: 'ready', version: 'fixture', services: [], checkedAt: Date.now()}); await pending;
    const stable = root.querySelector('.sd-storage-card') === card && root.querySelector('.api-draft') === draft
      && draft.value === 'https://unsaved.invalid/v1' && document.activeElement === draft && draft.selectionStart === 8 && draft.selectionEnd === 15 && body.scrollTop === savedTop;
    replaceCard(card, html, {icons: () => {}, bind: bindStorageManagementEvents});
    const fresh = root.querySelector('.sd-storage-service-refresh');
    bindStorageManagementEvents(root); button.click(); fresh.click(); await new Promise(resolve => setTimeout(resolve, 0));
    const rebound = fresh !== button && probeCount === 2;
    const again = optionalServiceProbePromise;
    resolveProbe({status: 'missing', services: [], checkedAt: Date.now()}); await again;
    return {checking, stable, rebound, result: root.querySelector('.sd-optional-service-label').textContent === '未安装',
      focus: document.activeElement === draft, draft: draft.value === 'https://unsaved.invalid/v1'};
  }, {html: render(), source: serviceSource, replace: replaceStorageManagementCard.toString()});
  for (const [key, value] of Object.entries(serviceChecks)) {assert.equal(value, true, `service ${key}`); checks.push(`service ${key}`);}
  assert.equal(external, 0); assert.deepEqual(errors, []);
  console.log(JSON.stringify({checks, external, errors, productionDataRead: false}));
} finally {await context.close(); await browser.close();}
