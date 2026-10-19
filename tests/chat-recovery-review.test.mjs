import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatRecovery, inspectChatRecoveryJsonl } from '../qianmu-chat-recovery.js';
import { mountChatRecoveryView } from '../qianmu-chat-recovery-view.js';

const backup = 'chat_synthetic_20261019-110000.jsonl';
const encode = rows => rows.map(row => JSON.stringify(row)).join('\n');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
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
      if (path === '/api/backups/chat/get') return jsonResponse([{ file_name: backup }]);
      if (path === '/api/backups/chat/download') return new Response(raw);
      if (path === '/api/characters/chats') return jsonResponse([...files.keys()].map(file_name => ({ file_name })));
      if (path === '/api/chats/import') {
        const form = init.body, imported = await form.get('file').text();
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
  await f.controller.recover('not-a-new-target.png');
  for (const [key, value] of f.drafts) f.files.set(key, value);
  const result = await f.controller.verify(); assert.equal(result.result.status, 'verified');
  assert.equal(f.calls.filter(path => path.endsWith('/import')).length, 1);
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
    setAttribute() {}
  }
  const root = new Element('root');
  const all = () => { const out = []; function visit(node) { out.push(node); node.children.forEach(visit); } visit(root); return out; };
  return { root, find: predicate => all().find(predicate) };
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

for (const change of ['same-name source re-preview', 'same-avatar target rename']) {
  test(`confirmation is bound to its original preview and target: ${change}`, async () => {
    const f = fixture(); await f.prepare(); const ui = dom(), waiting = deferred(), asked = deferred();
    f.view = mountChatRecoveryView({ root: ui.root, controller: f.controller, getCharacters: () => f.characters,
      confirm: () => { asked.resolve(); return waiting.promise; } });
    const target = ui.find(node => node.tag === 'select'); target.value = 'Synthetic.png'; target.handlers.change();
    const recover = ui.find(node => node.tag === 'button' && node.textContent === '另建找回副本');
    const clicking = recover.handlers.click(); await asked.promise;
    if (change === 'same-name source re-preview') {
      const rows = data(); rows[0].chat_metadata.unknownPlugin.hiddenState[2].value = '确认等待时换了隐藏资料';
      f.raw = encode(rows); await f.controller.preview(backup);
    } else f.characters[0].name = '确认后不是刚才展示的角色名';
    waiting.resolve(true); await clicking;
    assert.equal(f.calls.filter(path => path.endsWith('/import')).length, 0, 'changed confirmation inputs require a fresh explicit confirmation');
  });
}
