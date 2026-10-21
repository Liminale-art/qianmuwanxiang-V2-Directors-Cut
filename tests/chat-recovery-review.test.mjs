import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatRecovery, inspectChatRecoveryJsonl } from '../qianmu-chat-recovery.js';
import { mountChatRecoveryView } from '../qianmu-chat-recovery-view.js';

const backup = 'chat_synthetic_20261019-110000.jsonl';
const encode = rows => rows.map(row => JSON.stringify(row)).join('\n');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const data = () => [{ chat_metadata: { integrity: 'old', unknownPlugin: { hiddenState: [null, false, { value: '原值' }] } }, customHeader: { items: ['不认识也保留'] } },
  { name: '合成角色', mes: '仅合成正文', extra: { unknownFlag: 0 }, swipes: ['仅合成正文', '未选候选'] }];
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function fixture(options = {}) {
  let raw = encode(data()), sequence = 0, view, account = 'account:synthetic';
  const calls = [], files = new Map(), drafts = new Map(), characters = [{ avatar: 'Synthetic.png', name: '合成角色' }];
  const controller = createChatRecovery({ origin: 'https://synthetic.invalid', resolveAccount: async () => account,
    getCharacters: () => characters, getRequestHeaders: () => ({}), onChange: state => view?.render(state),
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` },
    fetch: async (path, init) => {
      calls.push(path);
      if (path === '/api/plugins/qianmu-tts/chat-backups/list') return new Response('{"error":"optional service absent"}', { status: 404, headers: { 'content-type': 'application/json' } });
      if (path === '/api/backups/chat/get') return jsonResponse([{ file_name: backup }]);
      if (path === '/api/backups/chat/download') return new Response(raw);
      if (path === '/api/characters/chats') return jsonResponse([...files.keys()].map(file_name => ({ file_name })));
      if (path === '/api/chats/import') {
        const form = init.body, imported = await form.get('avatar').text();
        // Native 1.19 JSONL import runs flattenChubChat on every row (header
        // included), then uses character_name only for the new file prefix.
        const result = imported.split('\n').map(line => {
          const row = JSON.parse(line);
          if (row.mes && row.mes.message) row.mes = row.mes.message;
          if (Array.isArray(row.swipes)) row.swipes = row.swipes.map(swipe => swipe.message ? swipe.message : swipe);
          return JSON.stringify(row);
        }).join('\n');
        const name = `${form.get('character_name')} - synthetic imported.jsonl`;
        if (options.deferImport) { drafts.set(name, result); throw new Error('synthetic response lost'); }
        files.set(name, result); options.onImport?.(); return jsonResponse({ res: true, fileNames: [name] });
      }
      if (path === '/api/chats/rename') {
        const original = JSON.parse(init.body).original_file, renamed = JSON.parse(init.body).renamed_file;
        if (!files.has(original) || files.has(renamed)) return new Response(JSON.stringify({ error: true }), { status: 400, headers: { 'content-type': 'application/json' } });
        const value = files.get(original); files.delete(original); files.set(renamed, value); return jsonResponse({ ok: true });
      }
      if (path === '/api/chats/export') return jsonResponse({ result: files.get(JSON.parse(init.body).file) });
      assert.fail('unexpected route');
    } });
  return { controller, calls, files, drafts, characters, setAccount(value) { account = value; }, set raw(value) { raw = value; }, get raw() { return raw; },
    set view(value) { view = value; }, async prepare() { await controller.load(); await controller.preview(backup); } };
}

test('unknown import survives view close/reopen and later readback without another import', async () => {
  const f = fixture({ deferImport: true }); await f.prepare(); const first = await f.controller.recover('Synthetic.png');
  assert.equal(first.result.status, 'unknown'); const ui = dom();
  const mount = () => mountChatRecoveryView({ root: ui.root, controller: f.controller, getCharacters: () => f.characters, confirm: async () => true });
  const firstView = mount(); f.view = firstView; firstView.dispose(); f.view = mount();
  assert.equal(f.controller.snapshot().result.operationId, first.result.operationId);
  await f.controller.recover('Synthetic.png');
  for (const [key, value] of f.drafts) f.files.set(key, value);
  const result = await f.controller.verify(); assert.equal(result.result.status, 'verified');
  assert.equal(f.calls.filter(path => path.endsWith('/import')).length, 1);
});

test('verified recovery asks the host to refresh the welcome recent-chat list', async () => {
  const f = fixture(); await f.prepare(); const ui = dom(); let refreshed = 0;
  const view = mountChatRecoveryView({ root: ui.root, controller: f.controller, getCharacters: () => f.characters, confirm: async () => true,
    onRecovered: async result => { refreshed++; assert.equal(result.result.status, 'verified'); } });
  f.view = view;
  const target = ui.find(node => node.className === 'qm-recovery-character-select'); target.value = 'Synthetic.png'; await target.handlers.change();
  const item = ui.find(node => node.className === 'qm-recovery-item'); await item.handlers.click();
  const recover = ui.find(node => node.tag === 'button' && node.textContent.startsWith('找回至')); await recover.handlers.click();
  assert.equal(refreshed, 1);
});

test('account changes after submission hide old private state and cannot resubmit the unknown operation', async () => {
  const f = fixture({ onImport: () => f.setAccount('account:other') }); await f.prepare();
  await assert.rejects(f.controller.recover('Synthetic.png'), /账户/);
  assert.equal(f.controller.snapshot().preview, null); assert.equal(f.controller.snapshot().result, null);
  assert.equal(f.calls.filter(path => path.endsWith('/export')).length, 0);
  f.setAccount('account:synthetic'); const result = await f.controller.verify();
  assert.equal(result.result.status, 'verified'); assert.equal(f.calls.filter(path => path.endsWith('/import')).length, 1);
});

function dom() {
  const document = { createElement: tag => new Element(tag) };
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.handlers = {}; this.ownerDocument = document; this.value = ''; this.textContent = ''; this.classList = { toggle() {} }; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(type, handler) { this.handlers[type] = handler; }
    focus() {}
    setAttribute() {}
  }
  const root = new Element('root');
  const all = () => { const out = []; function visit(node) { out.push(node); node.children.forEach(visit); } visit(root); return out; };
  return { root, find: predicate => all().find(predicate), findAll: predicate => all().filter(predicate) };
}

test('native importer retains unknown header/metadata/message fields with new integrity only', async () => {
  const f = fixture(); await f.prepare(); const before = f.raw;
  const result = await f.controller.recover('Synthetic.png'); assert.equal(result.result.status, 'verified');
  const restored = inspectChatRecoveryJsonl(f.files.get(result.result.fileName)).rows;
  assert.notEqual(restored[0].chat_metadata.integrity, 'old'); restored[0].chat_metadata.integrity = 'old';
  assert.deepEqual(restored, data()); assert.equal(f.raw, before); assert.equal(f.calls.filter(path => path.endsWith('/import')).length, 1);
});

test('preflight rejects unknown header swipe shapes that native import would silently transform', () => {
  const rows = data(); rows[0].swipes = [{ message: 'header custom data would transform' }];
  assert.throws(() => inspectChatRecoveryJsonl(encode(rows)));
});

test('recovery action does not open a confirmation popup', async () => {
  const f = fixture(); await f.prepare(); const ui = dom();
  f.view = mountChatRecoveryView({ root: ui.root, controller: f.controller, getCharacters: () => f.characters,
    confirm: () => { throw new Error('confirmation popup should not be called'); } });
  const target = ui.find(node => node.className === 'qm-recovery-character-select'); target.value = 'Synthetic.png'; await target.handlers.change();
  const item = ui.find(node => node.className === 'qm-recovery-item'); await item.handlers.click();
  const recover = ui.find(node => node.tag === 'button' && node.textContent.startsWith('找回至'));
  await recover.handlers.click();
  assert.equal(f.calls.filter(path => path.endsWith('/import')).length, 1);
  assert.match(ui.find(node => node.className === 'qm-recovery-status').textContent, /^已将此聊天备份找回至/);
  assert.equal(recover.disabled, true, 'the source recovery action is disabled after a verified import');
  await f.controller.load();
  assert.equal(ui.find(node => node.className === 'qm-recovery-status').hidden, true, 'a fresh list read clears the old success banner');
  assert.equal(recover.disabled, true, 'the recovered source remains protected after reloading the list');
});

function automaticFixture() {
  const calls = [], ui = dom(); let account = 'account:A', statusFailure = 0, loseConfiguration = false, view, sequence = 0;
  const status = { ok: true, version: 1, enabled: false, intervalMinutes: 30, limitMiB: 1024, usedBytes: 0, retention: 'rotate-oldest-keep-one' };
  const controller = createChatRecovery({ origin: 'https://synthetic.invalid', resolveAccount: async () => account,
    getCharacters: () => [], getRequestHeaders: () => ({}), onChange: snapshot => view?.render(snapshot),
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` },
    fetch: async (path, init) => {
      calls.push({ path, body: JSON.parse(init.body) });
      if (path.endsWith('/status')) return statusFailure ? new Response('{}', { status: statusFailure, headers: { 'content-type': 'application/json' } }) : jsonResponse(status);
      if (path.endsWith('/configure')) {
        Object.assign(status, JSON.parse(init.body));
        if (loseConfiguration) throw new Error('synthetic lost configuration response');
        return jsonResponse(status);
      }
      assert.fail('unexpected automatic route');
    } });
  const mount = confirm => { view?.dispose(); view = mountChatRecoveryView({ root: ui.root, controller, getCharacters: () => [], confirm }); return view; };
  const edit = minutes => { const input = ui.find(node => node.type === 'number'); input.value = String(minutes); input.handlers.input(); };
  const openAutomatic = async () => { await wait(0); assert.ok(ui.find(node => node.className === 'qm-recovery-auto'), 'automatic backup card stays expanded'); };
  const button = text => ui.find(node => node.tag === 'button' && node.textContent === text);
  return { controller, calls, ui, mount, edit, openAutomatic, button, setAccount: value => { account = value; }, setStatusFailure: value => { statusFailure = value; }, loseNextConfiguration: () => { loseConfiguration = true; } };
}

test('automatic settings auto-save cannot be rebound into a different ST account', async () => {
  const f = automaticFixture(); await f.controller.inspectAutomaticBackup();
  f.mount(async () => true); await f.openAutomatic(); f.edit(60);
  f.setAccount('account:B'); await wait(360);
  assert.equal(f.calls.filter(row => row.path.endsWith('/configure')).length, 0);
  assert.equal(f.controller.snapshot().automaticBackup.status, null);
});

test('automatic settings readback preserves an unsaved draft', async () => {
  const f = automaticFixture(); await f.controller.inspectAutomaticBackup();
  f.mount(async () => true); f.edit(60);
  await f.controller.inspectAutomaticBackup();
  assert.equal(f.calls.filter(row => row.path.endsWith('/configure')).length, 0);
  assert.equal(f.ui.find(node => node.type === 'number').value, '60', 'status refresh preserves the unsaved draft while cancelling its old confirmation');
});

test('role autocomplete binds the selected avatar, keeps the controls icon-only, and nests load-more in the scroller', async () => {
  const f = fixture(); await f.controller.load();
  const ui = dom(); mountChatRecoveryView({ root: ui.root, controller: f.controller, getCharacters: () => f.characters, confirm: async () => true });
  const input = ui.find(node => node.tag === 'input' && node.placeholder === '搜索角色名');
  input.value = '合'; input.handlers.input(); await wait(140);
  const suggestion = ui.find(node => node.className === 'qm-recovery-suggestion');
  assert.ok(suggestion, 'typed query shows a custom suggestion, not a native datalist');
  suggestion.handlers.click();
  const load = ui.find(node => node.tag === 'button' && node.innerHTML?.includes('fa-rotate'));
  assert.equal(load.disabled, false, 'choosing a suggestion binds the role for reading');
  const list = ui.find(node => node.className === 'qm-recovery-list');
  assert.equal(list.children.at(-1), ui.find(node => node.className === 'qm-recovery-load-more'), 'load-more is inside the scroll container');
});

test('role picker is an in-panel list and writes the chosen role into the search field', async () => {
  const f = fixture(); await f.controller.load();
  const ui = dom(); mountChatRecoveryView({ root: ui.root, controller: f.controller, getCharacters: () => f.characters, confirm: async () => true });
  const icon = ui.find(node => node.className === 'qm-recovery-icon-button'); await icon.handlers.click();
  const picker = ui.find(node => node.className === 'qm-recovery-role-picker');
  assert.equal(picker.hidden, false, 'role picker opens inside the panel');
  assert.equal(ui.find(node => node.className === 'qm-recovery-character-select').hidden, true, 'native select stays out of the touch path');
  const choice = ui.find(node => node.className?.includes('qm-recovery-role-option') && node.textContent === '合成角色');
  await choice.handlers.click();
  assert.equal(ui.find(node => node.tag === 'input' && node.placeholder === '搜索角色名').value, '合成角色');
  assert.equal(ui.find(node => node.tag === 'button' && node.innerHTML?.includes('fa-rotate')).disabled, false);
});

test('native ST Assistant is omitted from the recovery role picker and suggestions', async () => {
  const f = fixture();
  f.characters.unshift({ avatar: 'default_Assistant.png', name: 'Assistant' });
  await f.controller.load();
  const ui = dom();
  mountChatRecoveryView({ root: ui.root, controller: f.controller, getCharacters: () => f.characters, confirm: async () => true });
  const picker = ui.find(node => node.className === 'qm-recovery-character-select');
  assert.equal(picker.children.some(node => node.value === 'default_Assistant.png'), false);
  const input = ui.find(node => node.tag === 'input' && node.placeholder === '搜索角色名');
  input.value = 'Assistant'; input.handlers.input(); await wait(140);
  assert.equal(ui.find(node => node.className === 'qm-recovery-suggestion'), undefined);
});

test('role autocomplete accepts pinyin and avatar-letter aliases', async () => {
  const f = fixture(); f.characters.push({ avatar: 'char.png', name: '琮' });
  const ui = dom(); mountChatRecoveryView({ root: ui.root, controller: f.controller, getCharacters: () => f.characters, confirm: async () => true });
  const input = ui.find(node => node.tag === 'input' && node.placeholder === '搜索角色名');
  input.value = 'cong'; input.handlers.input(); await wait(140);
  assert.equal(ui.find(node => node.className === 'qm-recovery-suggestion')?.textContent, '琮');
  input.value = 'char'; input.handlers.input(); await wait(140);
  assert.equal(ui.find(node => node.className === 'qm-recovery-suggestion')?.textContent, '琮');
});

test('loaded count identifies the selected role and preview rows toggle independently without reloading', async () => {
  const revisions = new Map(), calls = [];
  const backups = ['one', 'two'].map((name, index) => ({
    name: `${name}.jsonl`, chatFile: `${name}.jsonl`, size: '1 KB',
    lastMessageAt: index === 0 ? '2026-10-19T03:00:00Z' : '2026-10-19T01:00:00Z', backupSort: index + 1,
    messageCount: index === 0 ? 99 : 2,
    candidateAvatars: ['Synthetic.png'], match: 'candidate', sourceLabel: 'ST备份',
  }));
  const state = { busy: false, error: '', backups, preview: null, result: null, automaticBackup: { availability: 'unavailable', busy: false } };
  const controller = {
    snapshot: () => structuredClone(state),
    preview: async name => {
      calls.push(name);
      const revision = (revisions.get(name) || 0) + 1; revisions.set(name, revision);
      state.preview = { name, revision, messageCount: 2, previewFloorLimit: 5, previewMessages: [{ floor: 2, name: '合成角色', text: name }] , canRecover: true };
    },
    load: async () => {},
  };
  const ui = dom();
  mountChatRecoveryView({ root: ui.root, controller, getCharacters: () => [{ avatar: 'Synthetic.png', name: '合成角色' }], confirm: async () => true });
  const character = ui.find(node => node.className === 'qm-recovery-character-select');
  character.value = 'Synthetic.png'; await character.handlers.change();
  await ui.find(node => node.tag === 'button' && node.innerHTML?.includes('fa-rotate')).handlers.click();
  const items = () => ui.findAll(node => node.className === 'qm-recovery-item');
  const firstName = items()[0].title, secondName = items()[1].title;
  assert.equal(firstName, 'one.jsonl', 'the newest final conversation time wins over message count and backup time');
  assert.equal(secondName, 'two.jsonl');
  await items()[0].handlers.click(); await items()[1].handlers.click();
  assert.deepEqual(calls, [firstName, secondName]);
  assert.equal(ui.findAll(node => node.className === 'qm-recovery-preview' || node.className === 'qm-recovery-preview qm-recovery-preview-actions').length, 3, 'two row previews plus shared recovery actions remain visible');
  const firstPreview = ui.findAll(node => node.className === 'qm-recovery-preview')[0];
  assert.equal(firstPreview.children.some(node => node.tag === 'h4'), false, 'a row preview does not repeat the file title');
  const loaded = ui.find(node => node.className === 'qm-recovery-loaded');
  assert.match(loaded.textContent, /当前已加载 2 份/);
  assert.match(loaded.textContent, /合成角色 · 共 2 份聊天记录/);
  await items()[0].handlers.click();
  assert.deepEqual(calls, [firstName, secondName], 'collapsing an open row does not download it again');
  assert.equal(ui.findAll(node => node.className === 'qm-recovery-preview' || node.className === 'qm-recovery-preview qm-recovery-preview-actions').length, 2);
  await items()[0].handlers.click();
  assert.deepEqual(calls, [firstName, secondName], 'reopening a cached row does not download it again');
  assert.equal(ui.findAll(node => node.className === 'qm-recovery-preview' || node.className === 'qm-recovery-preview qm-recovery-preview-actions').length, 3);
});

test('an unconfirmed recovery keeps browsing and preview available while the result remains frozen', async () => {
  const f = fixture({ deferImport: true }); await f.prepare();
  const first = await f.controller.recover('Synthetic.png'); assert.equal(first.result.status, 'unknown');
  const ui = dom(); mountChatRecoveryView({ root: ui.root, controller: f.controller, getCharacters: () => f.characters, confirm: async () => true });
  const character = ui.find(node => node.className === 'qm-recovery-character-select'); character.value = 'Synthetic.png'; character.handlers.change();
  const item = ui.find(node => node.className === 'qm-recovery-item');
  assert.equal(item.disabled, false, 'an uncertain write does not disable backup reading');
  await item.handlers.click();
  assert.equal(f.controller.snapshot().result.status, 'unknown', 'the frozen write receipt remains available for later verification');
  assert.equal(ui.find(node => node.className === 'qm-recovery-receipt'), undefined, 'the duplicate lower receipt is removed');
  const status = ui.find(node => node.className === 'qm-recovery-status');
  assert.equal(status.children.some(node => node.textContent === '核实上次结果'), false, 'verification is not exposed in the view');
});

test('unknown automatic configuration survives view remount and failed identity readback until a successful status read', async () => {
  const f = automaticFixture(); await f.controller.inspectAutomaticBackup(); f.mount(async () => true); await f.openAutomatic(); f.edit(60); f.loseNextConfiguration();
  await wait(360); assert.equal(f.controller.snapshot().automaticBackup.configurationUnknown, true);
  f.mount(async () => true); assert.equal(f.ui.find(node => node.type === 'number').disabled, true);
  f.setStatusFailure(401); await assert.rejects(f.controller.inspectAutomaticBackup());
  f.mount(async () => true); assert.equal(f.ui.find(node => node.type === 'number').disabled, true);
  f.setStatusFailure(500); await assert.rejects(f.controller.inspectAutomaticBackup());
  await assert.rejects(f.controller.configureAutomaticBackup({ enabled: true, intervalMinutes: 15, limitMiB: 512 }));
  assert.equal(f.calls.filter(row => row.path.endsWith('/configure')).length, 1);
  f.setStatusFailure(0); await f.controller.inspectAutomaticBackup();
  assert.equal(f.controller.snapshot().automaticBackup.configurationUnknown, false);
  assert.equal(f.ui.find(node => node.type === 'number').value, '60');
  assert.equal(f.calls.filter(row => row.path.endsWith('/configure')).length, 1);
});

for (const field of ['capacity', 'versions']) {
  test(`changing ${field} is persisted by the automatic draft saver`, async () => {
    const f = automaticFixture(); await f.controller.inspectAutomaticBackup();
    f.mount(async () => true); await f.openAutomatic(); f.edit(60); await wait(360);
    const input = f.ui.find(node => node.type === 'number' && node.min === (field === 'capacity' ? '256' : '1'));
    input.value = field === 'capacity' ? '1536' : '5'; input.handlers.input();
    await wait(360);
    assert.equal(f.calls.filter(row => row.path.endsWith('/configure')).length, 2);
  });
}

test('UI validates capacity and finite version integers before write, while only blank versions serialize as unlimited', async () => {
  const f = automaticFixture(); await f.controller.inspectAutomaticBackup(); f.mount(async () => true);
  const capacity = f.ui.find(node => node.type === 'number' && node.min === '256');
  const versions = f.ui.find(node => node.type === 'number' && node.min === '1');
  assert.equal(versions.value, '', 'legacy status missing the optional field means unlimited');
  capacity.value = ''; capacity.handlers.input(); await wait(360);
  assert.equal(f.calls.filter(row => row.path.endsWith('/configure')).length, 0);
  capacity.value = '1536'; capacity.handlers.input(); versions.value = '1.5'; versions.handlers.input(); await wait(360);
  assert.equal(f.calls.filter(row => row.path.endsWith('/configure')).length, 0);
  versions.value = ''; versions.handlers.input(); await wait(360);
  const writes = f.calls.filter(row => row.path.endsWith('/configure'));
  assert.equal(writes.length, 1); assert.equal(writes[0].body.limitMiB, 1536); assert.equal(writes[0].body.maxVersionsPerChat, 0);
});
