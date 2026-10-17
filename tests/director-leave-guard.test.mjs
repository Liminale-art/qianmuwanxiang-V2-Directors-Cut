import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDirectorLeaveGuard } from '../qianmu-director-leave-guard.js';

// Minimal capture/bubble DOM double. It models the native click dispatched by
// ST's Enter-key handler, not browser layout or live ST acceptance.
function fixture() {
  const listeners = [], notices = [], calls = [];
  let time = 0, cancels = 0;
  const context = { characterId: 0, groupId: null };
  const document = {
    addEventListener(type, callback, capture) { listeners.push({ type, callback, capture }); },
    removeEventListener(type, callback, capture) {
      const at = listeners.findIndex(row => row.type === type && row.callback === callback && row.capture === capture);
      if (at >= 0) listeners.splice(at, 1);
    },
  };
  class Element {
    constructor(selector, attrs = {}, parentElement = null) { this.selector = selector; this.attrs = attrs; this.parentElement = parentElement; }
    matches(selector) { return selector.split(',').some(value => value.trim() === this.selector); }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    getAttribute(name) { return this.attrs[name] ?? null; }
  }
  const options = new Element('#options');
  const close = new Element('#option_close_chat', {}, options), character = new Element('.character_select', { 'data-chid': '1' });
  const history = new Element('.select_chat_block', { file_name: 'Synthetic B' });
  const group = new Element('.group_select', { 'data-grid': 'group-B' });
  const f = {
    context, document, notices, calls, listeners, Element, close, character, history, group,
    set time(value) { time = value; }, get cancels() { return cancels; },
    begin() { const owner = {}; return { owner, ticket: f.guard.begin(owner, () => { cancels++; calls.push('cancel'); }) }; },
    click(target, extra = {}) {
      const event = { type: 'click', button: 0, target, defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra };
      for (const listener of [...listeners].filter(row => row.type === event.type && row.capture)) { listener.callback(event); if (event.stopped) break; }
      if (!event.stopped) calls.push('host');
      return event;
    },
  };
  f.guard = createDirectorLeaveGuard({ document, getContext: () => context, notify: (...args) => notices.push(args), now: () => time });
  return f;
}

for (const entry of ['close', 'character', 'history', 'group']) {
  test(`${entry}: generation-stage leave synchronously cancels before host click and prevents later save admission`, () => {
    const f = fixture(), { ticket } = f.begin(), event = f.click(f[entry]);
    assert.deepEqual(f.calls, ['cancel', 'host']); assert.equal(event.defaultPrevented, false);
    assert.equal(f.guard.acquire(ticket), false); assert.equal(f.guard.release(ticket), true); f.guard.dispose();
  });
  test(`${entry}: saving-stage leave is stopped before host click until the same ticket releases`, () => {
    const f = fixture(), { ticket } = f.begin(); assert.equal(f.guard.acquire(ticket), true);
    const event = f.click(f[entry]); assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
    assert.deepEqual(f.calls, []); assert.equal(f.cancels, 0); assert.equal(f.notices.length, 1);
    assert.equal(f.guard.release({}), false); assert.equal(f.click(f[entry]).stopped, true);
    assert.equal(f.guard.release(ticket), true); assert.equal(f.click(f[entry]).stopped, false); f.guard.dispose();
  });
}

test('nested icon/text and keyboard-generated native clicks use the same capture protection', () => {
  const f = fixture(), { ticket } = f.begin(); f.guard.acquire(ticket);
  for (const target of [new f.Element('.icon', {}, f.close), { parentElement: f.history }, f.character]) {
    const event = f.click(target, { detail: 0, isTrusted: false }); assert.equal(event.stopped, true);
  }
  assert.equal(f.calls.length, 0); f.guard.release(ticket); f.guard.dispose();
});

test('history tools do not masquerade as switching history; merely opening history is not leaving', () => {
  const f = fixture(), { ticket } = f.begin(); f.guard.acquire(ticket);
  for (const selector of ['.renameChatButton', '.exportChatButton', '.exportRawChatButton', '.PastChat_cross']) {
    assert.equal(f.click(new f.Element('.icon', {}, new f.Element(selector, {}, f.history))).stopped, false);
  }
  for (const target of [new f.Element('#option_select_chat'), new f.Element('.sd-close'), new f.Element('#select_chat_cross')]) assert.equal(f.click(target).stopped, false);
  assert.equal(f.notices.length, 0); f.guard.release(ticket); f.guard.dispose();
});

test('clicking the same character is not leaving, but selecting it from a group is', () => {
  const f = fixture(), { ticket } = f.begin(); const current = new f.Element('.character_select', { 'data-chid': '0' });
  f.click(current); assert.equal(f.cancels, 0); assert.equal(f.guard.acquire(ticket), true);
  f.context.groupId = 'group'; assert.equal(f.click(current).stopped, true); f.guard.release(ticket); f.guard.dispose();
});

test('selecting the same history filename is still a reload and is protected', () => {
  const f = fixture(), { ticket } = f.begin(); f.context.chatId = 'Synthetic B'; f.guard.acquire(ticket);
  assert.equal(f.click(f.history).stopped, true); f.guard.release(ticket); f.guard.dispose();
});

test('group list and hotswap use native data-grid/data-chid precedence; the current group only opens its menu', () => {
  const f = fixture(), { ticket } = f.begin(); f.context.groupId = 'group-A';
  f.click(new f.Element('.group_select', { 'data-grid': 'group-A' }));
  assert.equal(f.cancels, 0); assert.equal(f.guard.acquire(ticket), true);
  assert.equal(f.click(new f.Element('.group_select', { 'data-chid': 'group-A', 'data-grid': 'group-B' })).stopped, false);
  assert.equal(f.click(new f.Element('.icon', {}, new f.Element('.group_select', { 'data-chid': 'group-B' })), { detail: 0, isTrusted: false }).stopped, true);
  assert.equal(f.click(new f.Element('.group_select')).stopped, false);
  assert.equal(f.click(new f.Element('.group_select', { 'data-chid': '', 'data-grid': 'group-B' })).stopped, true);
  f.guard.release(ticket); f.guard.dispose();
});

test('malformed/template controls and non-primary clicks have no navigation side effect', () => {
  const f = fixture(), { ticket } = f.begin();
  for (const target of [new f.Element('#option_close_chat'), new f.Element('.character_select'), new f.Element('.character_select', { 'data-chid': 'bad' }), new f.Element('.select_chat_block', { file_name: '' })]) f.click(target);
  f.click(f.close, { button: 1 });
  assert.equal(f.cancels, 0); assert.equal(f.guard.acquire(ticket), true); f.guard.release(ticket); f.guard.dispose();
});

test('defaultPrevented alone cannot bypass protection for ST explicit click handlers', () => {
  const f = fixture(), { ticket } = f.begin(); f.guard.acquire(ticket);
  assert.equal(f.click(f.close, { defaultPrevented: true }).stopped, true);
  f.guard.release(ticket); f.guard.dispose();
});

test('observed leave invalidates a run even when host has not changed its chat yet and callback throws', () => {
  const f = fixture(), before = JSON.stringify(f.context), ticket = f.guard.begin({}, () => { throw Error('cancel failure'); });
  assert.doesNotThrow(() => f.click(f.close)); assert.equal(JSON.stringify(f.context), before);
  assert.equal(f.guard.acquire(ticket), false); f.guard.release(ticket); f.guard.dispose();
});

test('cancel callback cannot reenter saving; a rejected async callback does not create an unhandled rejection', async () => {
  const f = fixture(); let ticket, admitted;
  ticket = f.guard.begin({}, () => { admitted = f.guard.acquire(ticket); return Promise.reject(Error('late cancel rejection')); });
  assert.equal(f.click(f.close).stopped, false); assert.equal(admitted, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.guard.acquire(ticket), false); f.guard.release(ticket); f.guard.dispose();
});

test('leave cancellation is once per run, not once per click, and an old ticket cannot release a new run', () => {
  const f = fixture(), first = f.begin(); f.click(f.close); f.click(f.character); assert.equal(f.cancels, 1);
  f.guard.release(first.ticket); const second = f.begin(); assert.equal(f.guard.acquire(second.ticket), true);
  assert.equal(f.guard.release(first.ticket), false); assert.equal(f.click(f.history).stopped, true);
  f.guard.release(second.ticket); f.guard.dispose();
});

test('toast is throttled, but elapsed time never releases saving protection', () => {
  const f = fixture(), { ticket } = f.begin(); f.guard.acquire(ticket);
  f.click(f.close); f.time = 1000; f.click(f.close); assert.equal(f.notices.length, 1);
  f.time = 1500; f.click(f.close); assert.equal(f.notices.length, 2);
  f.time = 86_400_000; assert.equal(f.click(f.close).stopped, true); assert.equal(f.cancels, 0);
  f.guard.release(ticket); f.guard.dispose();
});

test('dispose cancels a generating run and detaches only its own capture listener', () => {
  const f = fixture(), { ticket } = f.begin(), foreign = () => {};
  f.document.addEventListener('click', foreign, true); f.guard.dispose(); f.guard.dispose();
  assert.equal(f.cancels, 1); assert.equal(f.guard.acquire(ticket), false);
  assert.deepEqual(f.listeners.map(row => row.callback), [foreign]); assert.throws(() => f.begin());
});

test('dispose during saving retains owner protection; only the owner release completes detachment', () => {
  const f = fixture(), { ticket } = f.begin(); f.guard.acquire(ticket); f.guard.dispose();
  assert.equal(f.listeners.length, 1); assert.equal(f.click(f.close).stopped, true); assert.equal(f.cancels, 0);
  assert.equal(f.guard.release({}), false); assert.throws(() => f.begin());
  assert.equal(f.guard.release(ticket), true); assert.equal(f.listeners.length, 0);
  assert.equal(f.click(f.close).stopped, false); assert.equal(f.guard.release(ticket), false);
});

test('another coordinator cannot release or dispose the saving owner', () => {
  const f = fixture(), { ticket } = f.begin(); f.guard.acquire(ticket);
  const other = createDirectorLeaveGuard({ document: f.document, getContext: () => f.context });
  assert.equal(other.release(ticket), false); other.dispose(); assert.equal(f.click(f.close).stopped, true);
  f.guard.release(ticket); f.guard.dispose();
});

test('foreign or forged tickets cannot acquire, replace, or release an active run', () => {
  const f = fixture(), { ticket } = f.begin();
  assert.equal(f.guard.acquire({}), false); assert.equal(f.guard.release({}), false);
  assert.throws(() => f.guard.begin({}, () => {}));
  assert.equal(f.guard.acquire(ticket), true); assert.equal(f.guard.acquire(ticket), true);
  f.guard.release(ticket); assert.equal(f.guard.acquire(ticket), false); f.guard.dispose();
});

test('a failing toast cannot unblock a saving-stage navigation event', () => {
  const f = fixture(); f.guard.dispose();
  const guard = createDirectorLeaveGuard({ document: f.document, getContext: () => f.context, notify() { throw Error('toast unavailable'); } });
  const ticket = guard.begin({}, () => {}); guard.acquire(ticket);
  assert.equal(f.click(f.close).stopped, true); assert.equal(f.calls.length, 0);
  guard.release(ticket); guard.dispose();
});

test('no active run leaves host operations untouched and allows a later run', () => {
  const f = fixture(); f.click(f.close); assert.deepEqual(f.calls, ['host']); assert.equal(f.notices.length, 0);
  const { ticket } = f.begin(); assert.equal(f.guard.acquire(ticket), true); f.guard.release(ticket); f.guard.dispose();
});

test('module has no timer-based unlock, host lock mutation, global network interception or storage', async () => {
  const code = await readFile(new URL('../qianmu-director-leave-guard.js', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /\b(?:setTimeout|setInterval|fetch|saveMetadata|localStorage|indexedDB)\s*\(/);
  assert.doesNotMatch(code, /isChatSaving\s*=/); assert.match(code, /addEventListener\('click', onClick, true\)/);
});
