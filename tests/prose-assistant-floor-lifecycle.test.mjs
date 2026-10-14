import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createProseAssistantFloorTools} from '../qianmu-prose-assistant-floor.js';
import {createProseFloorTools} from '../qianmu-prose-floor-tools.js';
import {emptyProseAssistantHistory} from '../qianmu-prose-assistant-history-contract.js';
import {proseAssistantPanelDom} from './helpers/prose-assistant-panel-dom.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; }

// Exercise the real retained panel and its asynchronous account guard. Only the
// DOM and history storage are doubles; no model or remote storage is contacted.
function fixture(t, {wrapper = false} = {}) {
  t.mock.method(globalThis, 'fetch', () => assert.fail('lifecycle checks must not call network transport'));
  const dom = proseAssistantPanelDom(), events = new EventEmitter(), notices = [];
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {configurable: true, value: dom.doc});
  t.after(() => { if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else delete globalThis.document; });
  const host = {chatId: 'Chat A', characterId: 0, groupId: null,
    characters: [{avatar: 'A.png', chat: 'Chat A'}], chat: [], chatMetadata: {}, eventSource: events};
  let live = true, nextAccountGate = null, accountChecks = 0, histories = 0, closedHistories = 0, mounts = 0, detaches = 0;
  const options = {getContext: () => host, headers: () => ({}), isCurrent: () => live,
    resolveNamespace: async () => {
      accountChecks++;
      const gate = nextAccountGate; nextAccountGate = null;
      if (gate) { gate.entered.resolve(); await gate.release.promise; }
      return 'st-user:lifecycle-fixture';
    },
    confirm: async () => true, notify: notice => notices.push(notice),
    assistantConversationFactory: async () => ({view: () => ({entries: [], defaults: []}), close() {}}),
    mountPortal: () => { mounts++; return () => { detaches++; }; },
    assistantHistoryFactory: async ({source}) => {
      histories++; let closed = false;
      return {initialHistory: () => emptyProseAssistantHistory(source.key), close() { if (!closed) { closed = true; closedHistories++; } }};
    }};
  const controller = wrapper ? createProseFloorTools(options) : createProseAssistantFloorTools(options);
  const bind = () => wrapper ? controller.refresh(dom.parent) : controller.bindRoot(dom.parent);
  const dispose = () => wrapper ? controller.dispose() : controller.disposeFloor();
  bind(); t.after(dispose);
  return {dom, host, events, controller, bind, dispose, notices,
    get live() { return live; }, set live(value) { live = value; },
    get histories() { return histories; }, get closedHistories() { return closedHistories; },
    get accountChecks() { return accountChecks; },
    get mounts() { return mounts; }, get detaches() { return detaches; },
    portals: () => dom.doc.querySelectorAll('[data-qm-prose-assistant-portal]'),
    pauseNextAccountCheck() {
      assert.equal(nextAccountGate, null);
      const gate = {entered: deferred(), release: deferred()}; nextAccountGate = gate;
      return {entered: gate.entered.promise, release: () => gate.release.resolve()};
    },
    async open() {
      const panel = await controller.openAssistant(); assert.ok(panel, notices.join('\n'));
      await panel.ready; assert.equal(panel.visible, true); return panel;
    },
    async hide(panel) {
      dom.get('关闭').click(); await dom.wait(() => !panel.visible, 'retained assistant did not hide');
      assert.equal(panel.element.isConnected, true, 'ordinary close retains the panel');
    },
  };
}

for (const cause of ['disposeFloor', 'chat_changed', 'controller.dispose', 'caller isCurrent expired']) {
  test(`retained assistant interrupted by ${cause} cannot create a replacement portal after delayed reopen`, async t => {
    const f = fixture(t, {wrapper: cause === 'controller.dispose'}), original = await f.open();
    await f.hide(original);
    const gate = f.pauseNextAccountCheck(), reopening = f.controller.openAssistant();
    await gate.entered;
    if (cause === 'chat_changed') f.events.emit('chat_changed');
    else if (cause === 'caller isCurrent expired') f.live = false;
    else f.dispose();
    gate.release();
    const result = await reopening;
    await turn();
    assert.equal(f.portals().length, 0, 'no empty portal remains after the old reopen settles');
    assert.equal(result === null, true, 'the invalidated invocation must stop, not restart a new panel');
    assert.equal(f.dom.doc.querySelectorAll('.qm-prose-assistant-dialog').length, 0);
    assert.equal(f.histories, 1, 'interruption must not open another history');
    assert.equal(f.closedHistories, 1);
    assert.equal(f.mounts, 1, 'interruption must not mount a new empty shell');
    assert.equal(f.detaches, 1);
    assert.deepEqual(f.notices, []);
    f.live = true; f.bind();
    const fresh = await f.open();
    assert.notEqual(fresh, original, 'an explicit later action may open a fresh valid panel');
    assert.equal(f.portals().length, 1);
    f.dispose(); await turn(); assert.equal(f.portals().length, 0); assert.equal(f.mounts, f.detaches);
    assert.equal(f.events.eventNames().length, 0, 'disposal releases retained chat listeners');
  });
}

test('concurrent ordinary reopens reuse one retained panel and one account check', async t => {
  const f = fixture(t), panel = await f.open(); await f.hide(panel);
  const gate = f.pauseNextAccountCheck(), checksBefore = f.accountChecks;
  const pending = [f.controller.openAssistant(), f.controller.openAssistant(), f.controller.openAssistant()];
  await gate.entered; assert.equal(f.portals().length, 1); gate.release();
  assert.deepEqual(await Promise.all(pending), [panel, panel, panel]);
  assert.equal(panel.visible, true); assert.equal(f.histories, 1); assert.equal(f.mounts, 1);
  assert.equal(f.accountChecks - checksBefore, 1, 'concurrent reopen calls share the in-flight account guard');
  f.dispose(); await turn(); assert.equal(f.portals().length, 0); assert.equal(f.detaches, 1);
});

test('concurrent delayed reopens all stop after disposal without leaking replacement shells', async t => {
  const f = fixture(t), panel = await f.open(); await f.hide(panel);
  const gate = f.pauseNextAccountCheck();
  const pending = [f.controller.openAssistant(), f.controller.openAssistant(), f.controller.openAssistant()];
  await gate.entered; f.dispose(); gate.release();
  assert.deepEqual((await Promise.all(pending)).map(panel => panel === null), [true, true, true]); await turn();
  assert.equal(f.portals().length, 0); assert.equal(f.mounts, 1); assert.equal(f.detaches, 1);
  assert.equal(f.histories, 1); assert.equal(f.closedHistories, 1);
  f.bind(); await f.open(); assert.equal(f.portals().length, 1);
});

test('an old delayed reopen neither returns nor closes a newer explicitly opened panel', async t => {
  const f = fixture(t), old = await f.open(); await f.hide(old);
  const gate = f.pauseNextAccountCheck(), pendingOld = f.controller.openAssistant();
  await gate.entered; f.dispose(); f.bind();
  const fresh = await f.open(); assert.notEqual(fresh, old); assert.equal(f.portals().length, 1);
  gate.release(); assert.equal((await pendingOld) === null, true, 'old action must not adopt the newer entry'); await turn();
  assert.equal(fresh.visible, true); assert.equal(fresh.element.isConnected, true);
  assert.equal(f.portals().length, 1); assert.equal(f.portals()[0], fresh.element.parentNode);
  assert.equal(f.histories, 2); assert.equal(f.closedHistories, 1); assert.equal(f.mounts, 2); assert.equal(f.detaches, 1);
  f.dispose(); await turn(); assert.equal(f.portals().length, 0); assert.equal(f.mounts, f.detaches);
});

test('a new explicit open after the chat has already changed replaces the stale retained panel immediately', async t => {
  const f = fixture(t), old = await f.open(); await f.hide(old);
  // This is a new user action in the new chat, not the continuation of an old
  // reopen. It must succeed once without requiring a second click.
  f.host.chatId = 'Chat B'; f.host.characters[0].chat = 'Chat B';
  f.host.chat = []; f.host.chatMetadata = {};
  const fresh = await f.open();
  assert.notEqual(fresh, old);
  assert.equal(old.element.isConnected, false); assert.equal(fresh.visible, true);
  assert.equal(f.portals().length, 1); assert.equal(f.portals()[0], fresh.element.parentNode);
  assert.equal(f.histories, 2); assert.equal(f.closedHistories, 1);
  assert.equal(f.mounts, 2); assert.equal(f.detaches, 1); assert.deepEqual(f.notices, []);
  f.dispose(); await turn();
  assert.equal(f.portals().length, 0); assert.equal(f.mounts, f.detaches);
  assert.equal(f.events.eventNames().length, 0);
});
