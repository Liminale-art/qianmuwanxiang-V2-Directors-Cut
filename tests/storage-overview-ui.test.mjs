import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import {STORAGE_CATEGORY_LABELS,STORAGE_CATEGORY_COLORS} from '../qianmu-storage-backup-view.js';
import {renderStorageCard,paintStorageCard,storageCategoryBlocks,storageScanText,STORAGE_SCAN_LABELS,readItemsFile} from '../qianmu-storage-card.js';
import {STORAGE_TRANSFER_ITEMS} from '../qianmu-storage-transfer.js';
import {renderStorageBackupSection,storageEventsShell,storageCardRoot} from './helpers/storage-card.mjs';
import { readFile } from 'node:fs/promises';
import { storyboardFunctionSource as section } from './helpers/storyboard-form-fixture.mjs';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
function fixture(data = null, status = 'ready') {
  const context = vm.createContext({renderStorageCard,VERSION:manifest.version,STORAGE_CATEGORY_LABELS,STORAGE_CATEGORY_COLORS, storageInventoryState: { data, status, error: '<unavailable>' },
    optionalServiceState: {status: 'idle'},
    htmlEscape: x => String(x ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    formatStorageBytes: x => `${Number(x) || 0} B`, blobStore: { classifyStoragePressure: () => ({ level: 'normal' }) } });
  vm.runInContext(['optionalServiceLabel', 'optionalServiceLatestDisplay', 'optionalServiceDetail', 'renderStorageServiceStatus', 'renderStorageManagementCard'].map(section).join('\n'), context);
  return context;
}
const data = () => ({sampledAt: 1, origin: { available: true, usage: 4000, quota: 10000 }, trackedBytes: 1000, manageableBytes: 900,
  categories: [{ category: 'vibes', bytes: 1000 }], idb: { chatScopes: ['chat'] },
  vibeStorage: { status: 'ready', assets: { count: 1, bytes: 800 }, previews: { bytes: 100 }, records: { count: 0, bytes: 0 }, metadata: { bytes: 100 } },
  recipeStorage: { status: 'ready', state: 'present', files: 3, bytes: 12345678 },
  restoreStorage: { status: 'ready', count: 0, bytes: 0 }, mappingStorage: { status: 'ready', count: 0, bytes: 0 }, carrierStorage: { status: 'ready', count: 0, bytes: 0 },
  characterStorage: { status: 'ready', documents: { count: 0, bytes: 0 }, bindings: { count: 0, bytes: 0 }, indexes: { bytes: 0 } },
  comfyStorage: { status: 'ready', workflows: { status: 'ready', count: 0, bytes: 0 }, pools: { status: 'ready', count: 0, bytes: 0 }, scenes: { status: 'ready', count: 0, bytes: 0 } }
});
const count = (html, pattern) => (html.match(pattern) || []).length;

test('the card is a title, an overview and two rows: one export, one import, one scan-and-clean, one per-chat clean', () => {
  const snapshot = data(), before = structuredClone(snapshot), html = fixture(snapshot).renderStorageManagementCard();
  assert.match(html, /^<section class="sd-card sd-storage-card sd-dm">/);
  assert.match(html, /<div class="sd-card-title-row sd-dm-head"><h3>数据管理<\/h3>/);
  const top = html.indexOf('class="sd-dm-top"'), body = html.indexOf('class="sd-storage-backup-section sd-dm-body"'), service = html.indexOf('class="sd-storage-service"');
  assert.ok(top > 0 && top < body && body < service, 'title, overview, actions, then service status at the card end');
  const rows = [...html.matchAll(/<div class="sd-dm-row"><span>([^<]+)<\/span><div class="sd-dm-actions">([\s\S]*?)<\/div><\/div>/g)].map(match => [match[1], [...match[2].matchAll(/<button type="button" class="([^"]+)">([^<]+)<\/button>/g)].map(button => [button[1], button[2]])]);
  assert.deepEqual(rows, [
    ['备份', [['sd-btn sd-storage-export', '导出'], ['sd-btn sd-storage-import', '导入']]],
    ['清理', [['sd-btn sd-storage-clean', '扫描并清理'], ['sd-btn sd-storage-chat-clean', '按聊天清理']]],
  ]);
  assert.equal(count(html, /<input\b/g), 2);
  assert.match(html, /<input type="file" class="sd-storage-import-file" multiple accept="\.zip,application\/zip,\.json,application\/json" hidden>/);
  assert.match(html, /<input type="file" class="sd-storage-import-slot" hidden>/);
  assert.match(html, /<button type="button" class="sd-btn sd-undo-config" hidden>撤回本次恢复<\/button>/);
  // 卡片主体里只有这四枚按钮、撤回键与两枚隐藏输入；此外是标题旁的重新扫描与后端服务的说明键。
  assert.equal(count(html.slice(body, service), /<button\b/g), 5);
  assert.equal(count(html, /<button\b/g), 7);
  assert.doesNotMatch(html, /<details\b|<h4>|<small>|data-storage-|sd-dm-fold|sd-dm-advanced|sd-storage-export-all|sd-storage-gallery-check|sd-storage-storyboard-recover|sd-import-config|sd-export-config/);
  assert.doesNotMatch(html, /预设与提示词|资料库|其他位置|高级|分镜|影片|不代表|未读取|图片配置|Vibe 素材|角色资料|工作流/);
  assert.doesNotMatch(html, /\sdisabled/);
  assert.deepEqual(snapshot, before, 'render must not mutate accounting, assets, or recovery data');
});

test('the four actions are present and enabled in every scan state; only the overview block changes', () => {
  const actions = /class="sd-btn sd-storage-export">[\s\S]*class="sd-btn sd-storage-import">[\s\S]*class="sd-btn sd-storage-clean">[\s\S]*class="sd-btn sd-storage-chat-clean">/;
  const body = html => html.slice(html.indexOf('class="sd-storage-backup-section sd-dm-body"'));
  const reference = body(fixture(data()).renderStorageManagementCard());
  for (const status of ['idle', 'loading', 'error', 'ready', 'stale']) for (const snapshot of [null, data()]) {
    const html = fixture(snapshot, status).renderStorageManagementCard();
    assert.match(html, actions, status);
    assert.equal(body(html), reference, `${status}: the action rows never depend on the scan`);
    assert.match(html, /sd-storage-service[\s\S]*后端服务[\s\S]*sd-storage-service-guide/);
    assert.equal(/class="sd-icon-btn sd-storage-refresh" title="重新扫描" aria-label="重新扫描"/.test(html), status !== 'loading', status);
    assert.equal(/class="sd-dm-overview"/.test(html), Boolean(snapshot), status);
  }
  const idle = fixture(null, 'idle').renderStorageManagementCard();
  assert.match(idle, /<div class="sd-dm-top"><\/div>/);
  const failed = fixture(null, 'error').renderStorageManagementCard();
  assert.match(failed, /<p class="sd-muted" role="status">扫描未完成：&lt;unavailable&gt;<\/p>/); assert.doesNotMatch(failed, /<unavailable>/);
  // 有旧结果时，失败不再另起一行说明，旧的占用继续显示。
  assert.doesNotMatch(fixture(data(), 'error').renderStorageManagementCard(), /扫描未完成/);
});

test('scanning shows measured progress above the last overview without hiding it', () => {
  const context = fixture(null, 'loading');
  assert.match(context.renderStorageManagementCard(), /<div class="sd-dm-scan" style="--sd-dm-done:0\.0%"><p role="status">准备扫描…<\/p><progress max="1" value="0" aria-label="资料扫描进度"><\/progress><\/div>/);
  context.storageInventoryState.progress = { done: 5, total: 20 };
  const scanning = context.renderStorageManagementCard();
  assert.match(scanning, /<p role="status">5\/20项 领取记录 25%<\/p><progress max="20" value="5" aria-label="资料扫描进度"><\/progress>/);
  assert.doesNotMatch(scanning, /sd-dm-overview|sd-storage-refresh/);
  const again = fixture(data(), 'loading'); again.storageInventoryState.progress = { done: 19, total: 20 };
  const html = again.renderStorageManagementCard();
  assert.ok(html.indexOf('class="sd-dm-scan"') < html.indexOf('class="sd-dm-overview"'));
  assert.match(html, /19\/20项 汇总 95%/); assert.match(html, /千幕资料已盘点<\/span><b>1000 B/);
  assert.doesNotMatch(fixture(data()).renderStorageManagementCard(), /sd-dm-scan|资料扫描进度/);
});

test('scan progress text names the step being read and never overruns the step list', () => {
  assert.equal(STORAGE_SCAN_LABELS.length, 20);
  assert.equal(new Set(STORAGE_SCAN_LABELS).size, STORAGE_SCAN_LABELS.length);
  assert.equal(storageScanText(), '准备扫描…');
  assert.equal(storageScanText({ done: 3, total: 0 }), '准备扫描…');
  assert.equal(storageScanText({ done: 0, total: 20 }), '0/20项 浏览器空间 0%');
  assert.equal(storageScanText({ done: 3, total: 20 }), '3/20项 生图记录 15%');
  assert.equal(storageScanText({ done: 10, total: 20 }), '10/20项 角色资料 50%');
  assert.equal(storageScanText({ done: 19, total: 20 }), '19/20项 汇总 95%');
  assert.equal(storageScanText({ done: 20, total: 20 }), '20/20项 汇总 100%');
  assert.equal(storageScanText({ done: 25, total: 20 }), '20/20项 汇总 100%');
  assert.equal(storageScanText({ done: 30, total: 40 }), '30/40项 汇总 75%');
  assert.equal(storageScanText({ done: 1, total: 3 }), '1/3项 本机资料 33%');
  assert.equal(storageScanText({ done: 'x', total: 20 }), '0/20项 浏览器空间 0%');
});

test('the step names follow the real inventory job list', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const jobs = source.slice(source.indexOf('const jobs=['), source.indexOf('];', source.indexOf('const jobs=[')));
  // 每个任务占一行，再加最后的汇总一步。
  assert.equal(count(jobs, /^\s*\(\)=>/gm) + 1, STORAGE_SCAN_LABELS.length);
});

test('category blocks sort by size, fold slivers into one remainder and keep shares summing to the total', () => {
  const { total, blocks } = storageCategoryBlocks([{ category: 'notes', bytes: 5 }, { category: 'images', bytes: 600 }, { category: 'audio', bytes: 390 }, { category: 'logs', bytes: 5 }, { category: 'video', bytes: 0 }]);
  assert.equal(total, 1000);
  assert.deepEqual(blocks.map(block => [block.key, block.bytes]), [['images', 600], ['audio', 390], ['other', 10]]);
  assert.equal(blocks[0].label, STORAGE_CATEGORY_LABELS.images); assert.equal(blocks[0].color, STORAGE_CATEGORY_COLORS.images);
  assert.ok(Math.abs(blocks.reduce((sum, block) => sum + block.share, 0) - 1) < 1e-9);
  assert.deepEqual(storageCategoryBlocks([]), { total: 0, blocks: [] });
  const snapshot = data(); snapshot.categories = [{ category: 'images', bytes: 750 }, { category: 'audio', bytes: 250 }];
  const html = fixture(snapshot).renderStorageManagementCard();
  assert.equal((html.match(/<i style="flex-grow:/g) || []).length, 2);
  assert.match(html, /<em>图片<\/em><b>750 B<\/b><span>75\.0 %<\/span>/);
  assert.match(html, /<em>音频<\/em><b>250 B<\/b><span>25\.0 %<\/span>/);
});

test('item files reject foreign shapes', async () => {
  const file = value => ({ text: async () => JSON.stringify(value) });
  assert.deepEqual(await readItemsFile(file({ type: 'kind', version: 1, items: [{ name: 'a' }, null, [1], 'x'] }), 'kind'), [{ name: 'a' }]);
  assert.deepEqual(await readItemsFile(file([{ name: 'b' }]), 'kind'), [{ name: 'b' }]);
  await assert.rejects(readItemsFile(file({ type: 'other', items: [{ name: 'a' }] }), 'kind'), /没有可导入的条目/);
  await assert.rejects(readItemsFile(file({ type: 'kind' }), 'kind'), /没有可导入的条目/);
});

test('a browser-space warning stays above the actions; unreadable parts add no small print', () => {
  const snapshot = data();
  snapshot.comfyStorage.status = 'partial'; snapshot.comfyStorage.errors = ['bad <index>'];
  snapshot.origin.pressure = { level: 'critical', ratio: .95, freeBytes: 50 };
  const html = fixture(snapshot).renderStorageManagementCard(), split = html.indexOf('class="sd-storage-backup-section sd-dm-body"');
  assert.ok(split > 0);
  assert.match(html.slice(0, split), /<p class="sd-storage-pressure is-critical" role="status">浏览器空间已用 95% · 剩余约 50 B，建议先导出备份再清理。<\/p>/);
  assert.doesNotMatch(html, /bad <index>|bad &lt;index&gt;|部分数据暂不可读取|暂未读取/);
  snapshot.origin.pressure = { level: 'warning', ratio: .8, freeBytes: 2000 };
  assert.match(fixture(snapshot).renderStorageManagementCard(), /sd-storage-pressure is-warning" role="status">浏览器空间已用 80% · 剩余约 2000 B/);
  delete snapshot.origin.pressure;
  assert.doesNotMatch(fixture(snapshot).renderStorageManagementCard(), /sd-storage-pressure/);
  // 没有随扫描结果带来的压力判断时，改用本机库的分级。
  const context = fixture(snapshot); context.blobStore.classifyStoragePressure = origin => { assert.equal(origin, snapshot.origin); return { level: 'warning', ratio: .7, freeBytes: 30 }; };
  assert.match(context.renderStorageManagementCard(), /浏览器空间已用 70% · 剩余约 30 B/);
});

test('missing browser quota does not prevent backup or invent a device disk size', () => {
  const snapshot = data(); snapshot.origin = { available: false };
  const html = fixture(snapshot).renderStorageManagementCard();
  assert.match(html, /浏览器未提供配额信息/);
  assert.match(html, /sd-storage-backup-section/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test('the overview shows accounted bytes and site quota once, and nothing it did not measure', () => {
  const snapshot = data(), html = fixture(snapshot).renderStorageManagementCard();
  assert.match(html, /class="sd-dm-total"><span>千幕资料已盘点<\/span><b>1000 B<\/b>/);
  assert.match(html, /<p class="sd-dm-site">本设备 ST 站点已用 \/ 配额<b>4000 B \/ 10000 B<\/b><\/p>/);
  assert.match(html, /<em>参考素材<\/em><b>1000 B<\/b><span>100\.0 %<\/span>/);
  assert.equal(count(html, /class="sd-dm-bar"/g), 1);
  assert.equal(count(html, /class="sd-dm-legend-item"/g), 1);
  assert.doesNotMatch(html, /12345678|fa-arrow-up-right|↗|2\.46 GB|其他 ST 数据|未盘点站点数据/);
  // 读不到的部分不会被补成一行，也不会抬高总数。
  snapshot.vibeStorage = { status: 'unavailable', error: '<not read>' };
  const partial = fixture(snapshot).renderStorageManagementCard();
  assert.match(partial, /千幕资料已盘点<\/span><b>1000 B<\/b>/);
  assert.doesNotMatch(partial, /<not read>|&lt;not read&gt;/);
  const empty = renderStorageBackupSection(null, undefined, { data: {}, ready: true });
  assert.match(empty, /<p class="sd-muted">暂未发现千幕本地数据。<\/p>/); assert.doesNotMatch(empty, /sd-dm-bar|sd-dm-legend/);
});

// ── 就地更新 ──
// paintStorageCard 只用到很少几样节点能力；这里按选择器直接给出各块，不解析标记。
function paintFixture(parts, nextParts) {
  const log = [], document = { activeElement: null };
  const block = (selector, { html = '', attrs = {}, buttons = [] } = {}) => {
    const attributes = new Map(Object.entries(attrs)), node = { selector, innerHTML: html, childNodes: [html], children: [html], buttons,
      hasAttribute: name => attributes.has(name), getAttribute: name => attributes.get(name), setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name),
      attributes, contains: target => buttons.includes(target), querySelectorAll: () => node.buttons,
      replaceChildren(...nodes) { log.push(['replace', selector]); node.children = nodes; node.buttons = node.incoming || []; } };
    return node;
  };
  const tree = spec => { const map = new Map(Object.entries(spec).map(([selector, part]) => [`:scope > ${selector}`, block(selector, part)])); return { map, querySelector: selector => map.get(selector) || null }; };
  const current = tree(parts); current.ownerDocument = document;
  let next = nextParts ? tree(nextParts) : null;
  document.createElement = name => { assert.equal(name, 'template'); return { content: { get firstElementChild() { return next; } }, set innerHTML(value) { log.push(['parse', value]); } }; };
  return { current, document, log, live: selector => current.map.get(`:scope > ${selector}`), setNext: spec => { next = spec ? tree(spec) : null; return next; } };
}

test('painting rewrites only the title row, the overview and the service block, and only when they changed', () => {
  const body = { html: 'buttons' };
  const e = paintFixture({ '.sd-dm-head': { html: 'old head' }, '.sd-dm-top': { html: 'old top' }, '.sd-storage-service': { html: 'service' }, '.sd-dm-body': body },
    { '.sd-dm-head': { html: 'new head' }, '.sd-dm-top': { html: 'new top' }, '.sd-storage-service': { html: 'service' }, '.sd-dm-body': { html: 'other buttons' } });
  const icons = [], bound = [];
  assert.equal(paintStorageCard(e.current, '  <section>card</section>  ', { icons: node => icons.push(node.selector), bind: node => bound.push(node) }), true);
  assert.deepEqual(e.log, [['parse', '<section>card</section>'], ['replace', '.sd-dm-head'], ['replace', '.sd-dm-top'], ['replace', '.sd-storage-service']]);
  assert.deepEqual(icons, ['.sd-dm-head', '.sd-dm-top', '.sd-storage-service']);
  assert.deepEqual(bound, [e.current]);
  assert.deepEqual(e.live('.sd-dm-top').children, ['new top']);
  assert.deepEqual(e.live('.sd-dm-body').children, ['buttons'], 'the action rows and file inputs are never replaced');

  // 第二次：只有顶部变了。
  e.log.length = 0; icons.length = 0;
  e.setNext({ '.sd-dm-head': { html: 'new head' }, '.sd-dm-top': { html: 'newer top' }, '.sd-storage-service': { html: 'service' } });
  assert.equal(paintStorageCard(e.current, '<section>card</section>', { icons: node => icons.push(node.selector), bind: node => bound.push(node) }), true);
  assert.deepEqual(e.log.filter(([kind]) => kind === 'replace'), [['replace', '.sd-dm-top']]);
  assert.deepEqual(icons, ['.sd-dm-top']);
  assert.equal(bound.length, 2, 'binding runs on every paint so refreshed controls are wired');

  // 第三次：什么都没变。
  e.log.length = 0;
  assert.equal(paintStorageCard(e.current, '<section>card</section>'), true);
  assert.deepEqual(e.log.filter(([kind]) => kind === 'replace'), []);
});

test('painting copies status attributes, keeps focus on the same control and ignores markup without a card', () => {
  const refresh = { className: 'sd-icon-btn sd-storage-refresh' };
  const e = paintFixture({ '.sd-dm-head': { html: 'head', attrs: { hidden: '' }, buttons: [refresh] }, '.sd-storage-service': { html: 'a', attrs: { 'data-status': 'idle' } } });
  e.document.activeElement = refresh;
  let focused = null;
  const fresh = { className: 'sd-icon-btn sd-storage-refresh', focus: options => { focused = options; } }, other = { className: 'sd-btn', focus() { throw new Error('wrong control focused'); } };
  e.setNext({ '.sd-dm-head': { html: 'head 2' }, '.sd-storage-service': { html: 'b', attrs: { 'data-status': 'ready' } } });
  e.live('.sd-dm-head').incoming = [other, fresh];
  assert.equal(paintStorageCard(e.current, '<section></section>'), true);
  assert.deepEqual(focused, { preventScroll: true });
  assert.equal(e.live('.sd-dm-head').hasAttribute('hidden'), false);
  assert.equal(e.live('.sd-storage-service').getAttribute('data-status'), 'ready');
  // 新标记里缺的块、卡片上没有的块都跳过，不报错。
  assert.deepEqual(e.log.filter(([kind]) => kind === 'replace'), [['replace', '.sd-dm-head'], ['replace', '.sd-storage-service']]);

  e.log.length = 0; e.setNext(null); let bound = 0;
  assert.equal(paintStorageCard(e.current, '', { bind: () => bound++ }), false);
  assert.equal(bound, 0); assert.deepEqual(e.log.filter(([kind]) => kind === 'replace'), []);
});

// ── 入口文件的接线 ──
function wiring(overrides = {}) {
  const calls = [], card = storageCardRoot();
  const spy = name => (...args) => { calls.push([name, ...args]); };
  const context = vm.createContext(storageEventsShell({ storageDownloadSink: null,
    exportConfig: spy('config-export'), importConfig: spy('config-import'), exportPinnedNotesBackup: spy('notes-export'), importPinnedNotesBackup: spy('notes-import'),
    exportTtsFavoritesBackup: spy('favorites-export'), importTtsFavoritesBackup: spy('favorites-import'), ttsExportAudioCache: spy('audio-export'), ttsImportAudioCache: spy('audio-import'),
    coreadExportData: spy('reader-export'), coreadImportDataFile: spy('reader-import'),
    proseFloorTools: { exportCollection: spy('collection-export'), importCollection: spy('collection-import'), exportAssistantLibrary: spy('assistant-export'), importAssistantLibrary: spy('assistant-import') },
    createStorageLibraryTransfer: () => ({ exports: { focus: spy('focus-export') }, imports: { focus: spy('focus-import') } }),
    runStorageExport: spy('run-export'), runStorageImport: spy('run-import'), storageDialogs: () => 'dialogs', refreshStorageInventory: spy('refresh'), ...overrides }));
  vm.runInContext(section('bindStorageManagementEvents'), context);
  return { context, card, calls, bind: () => context.bindStorageManagementEvents(card.root) };
}
const transferKeys = STORAGE_TRANSFER_ITEMS.map(([key]) => key).sort();

test('binding starts no work, binds each action once and only schedules the idle scan', () => {
  let scheduled = 0;
  const e = wiring({ scheduleStorageScan: () => scheduled++ });
  e.bind(); e.bind();
  assert.deepEqual(e.calls, [], 'binding controls must never start backup, restore, or cleanup');
  assert.equal(scheduled, 2);
  for (const selector of ['.sd-storage-export', '.sd-storage-import', '.sd-storage-clean', '.sd-storage-chat-clean', '.sd-undo-config']) assert.equal(e.card.bound(selector), true, selector);
  assert.equal(e.card.node('.sd-storage-import-file').handlers.has('change'), true);
  assert.equal(e.card.backup.dataset.storageBound, 'true');
  // 标题旁的重新扫描每次重画都是新节点，所以每次绑定都重新接上。
  e.card.node('.sd-storage-refresh').onclick();
  assert.deepEqual(e.calls, [['refresh', true]]);
});

test('the undo control follows whether a restore can be undone', () => {
  let available = true, undone = 0;
  const e = wiring({ configUndo: { available: settings => { assert.equal(settings, e.context.settings); return available; } }, undoConfigRestore: () => undone++ });
  e.card.node('.sd-undo-config').hidden = true;
  e.bind(); assert.equal(e.card.node('.sd-undo-config').hidden, false);
  available = false; e.bind(); assert.equal(e.card.node('.sd-undo-config').hidden, true);
  e.card.click('.sd-undo-config'); assert.equal(undone, 1);
});

test('export hands the nine existing exporters to the shared flow and collects their files only while packing', async () => {
  const downloads = [], notices = [];
  const e = wiring({ ttsDownloadBlob: (blob, name) => downloads.push([blob, name]), toast: (...args) => notices.push(args),
    chatRingtone: { actions: { exportLocal: async () => ringBlob } } });
  let ringBlob = null;
  e.bind(); e.card.click('.sd-storage-export');
  assert.equal(e.calls.length, 1);
  const [name, options] = e.calls[0];
  assert.equal(name, 'run-export'); assert.equal(options.dialogs, 'dialogs'); assert.equal(options.button, e.card.node('.sd-storage-export'));
  assert.equal(options.download, e.context.ttsDownloadBlob); assert.equal(options.notify, e.context.toast); assert.equal(options.stamp, e.context.fileStamp);
  assert.deepEqual(Object.keys(options.exports).sort(), transferKeys);
  e.calls.length = 0;
  for (const key of ['config', 'notes', 'collection', 'favorites', 'audio', 'reader', 'assistant', 'focus']) await options.exports[key]('button');
  assert.deepEqual(e.calls.map(call => call[0]), ['config-export', 'notes-export', 'collection-export', 'favorites-export', 'audio-export', 'reader-export', 'assistant-export', 'focus-export']);
  await options.exports.ringtones();
  assert.deepEqual(downloads, []); assert.deepEqual(notices, [['没有可导出的本地铃声。', 'info']]);
  ringBlob = { size: 1 }; await options.exports.ringtones();
  assert.deepEqual(downloads, [[ringBlob, 'qianmu-ringtones-stamp.json']]); assert.deepEqual(notices.at(-1), ['已导出本地铃声。', 'success']);

  assert.equal(e.context.storageDownloadSink, null);
  let during = null;
  const files = await options.capture(async () => { during = e.context.storageDownloadSink; during.push({ name: 'a' }); });
  assert.ok(Array.isArray(during)); assert.equal(files, during); assert.equal(files.length, 1);
  assert.equal(e.context.storageDownloadSink, null);
  await assert.rejects(options.capture(async () => { throw new Error('halfway'); }), /halfway/);
  assert.equal(e.context.storageDownloadSink, null, 'a failed export never leaves later downloads swallowed');
});

test('import opens one picker and routes the chosen files through the shared flow to the nine existing importers', async () => {
  const notices = [];
  const e = wiring({ toast: (...args) => notices.push(args), chatRingtone: { actions: { importLocal: async file => { e.calls.push(['ringtones-import', file]); return { added: 2, skipped: 1 }; } } } });
  e.bind();
  const picker = e.card.node('.sd-storage-import-file'), slot = e.card.node('.sd-storage-import-slot');
  let opened = 0; picker.click = () => opened++;
  e.card.click('.sd-storage-import');
  assert.equal(opened, 1); assert.deepEqual(e.calls, []);
  picker.files = []; picker.value = 'empty'; picker.handlers.get('change')();
  assert.deepEqual(e.calls, []); assert.equal(picker.value, '');
  const chosen = [{ name: 'a.json' }, { name: 'b.zip' }];
  picker.files = chosen; picker.value = 'picked'; picker.handlers.get('change')();
  assert.equal(picker.value, '', 'the same file can be picked again');
  assert.equal(e.calls.length, 1);
  const [name, options] = e.calls[0];
  assert.equal(name, 'run-import'); assert.equal(options.dialogs, 'dialogs'); assert.equal(options.slot, slot); assert.equal(options.notify, e.context.toast);
  assert.deepEqual([...options.files], chosen);
  assert.deepEqual(Object.keys(options.imports).sort(), transferKeys);
  e.calls.length = 0;
  const file = { name: 'x.json' }, event = { target: slot, currentTarget: slot };
  for (const key of ['config', 'notes', 'collection', 'favorites', 'audio', 'reader', 'assistant', 'focus', 'ringtones']) await options.imports[key](file, slot, event);
  // 这四项从输入框事件里取文件；其余直接收文件。
  assert.deepEqual(e.calls, [['config-import', event], ['notes-import', event], ['collection-import', file, slot, event], ['favorites-import', event], ['audio-import', event],
    ['reader-import', file, slot, event], ['assistant-import', file, slot, event], ['focus-import', file, slot, event], ['ringtones-import', file]]);
  assert.deepEqual(notices, [['已导入 2 个本地铃声，1 个已存在或不可用。', 'success']]);
});

test('the scan shimmer runs only over the part already scanned', async () => {
  const { readFile } = await import('node:fs/promises');
  const { renderStorageCard } = await import('../qianmu-storage-card.js');
  const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
  assert.match(css, /\.sd-dm-scan::after \{ content: ''; position: absolute; left: 0; width: var\(--sd-dm-done, 0%\);/);
  const html = renderStorageCard({ state: { status: 'loading', data: null, progress: { done: 5, total: 20 } }, format: String, escape: String });
  assert.match(html, /class="sd-dm-scan" style="--sd-dm-done:25\.0%"/);
});
