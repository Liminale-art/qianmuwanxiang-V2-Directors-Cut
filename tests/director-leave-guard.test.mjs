import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDirectorLeaveGuard } from '../qianmu-director-leave-guard.js';

// Minimal capture/bubble DOM double. It models the native click dispatched by
// ST's Enter-key handler, not browser layout or live ST acceptance.
function fixture({ captureIntent = raw => Object.freeze({ ...raw }) } = {}) {
  const listeners = [], notices = [], calls = [], navigations = [];
  let time = 0, cancels = 0, hostGenerating = false;
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
  const newChat = new Element('#option_start_new_chat', {}, options);
  const newFromHistory = new Element('#newChatFromManageScreenButton');
  const f = {
    context, document, notices, calls, navigations, listeners, Element, close, character, history, group, newChat, newFromHistory,
    set hostGenerating(value) { hostGenerating = value; },
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
  f.guard = createDirectorLeaveGuard({ document, getContext: () => context,
    isHostGenerating: () => hostGenerating, captureIntent, onNavigate: kind => navigations.push(kind),
    notify: (...args) => notices.push(args), now: () => time });
  return f;
}

for (const entry of ['close', 'character', 'history', 'group', 'newChat', 'newFromHistory']) {
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
  for (const target of [new f.Element('#option_close_chat'), new f.Element('#option_start_new_chat'), new f.Element('.character_select'), new f.Element('.character_select', { 'data-chid': 'bad' }), new f.Element('.select_chat_block', { file_name: '' })]) f.click(target);
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

for (const entry of ['close', 'character', 'history', 'group', 'newChat', 'newFromHistory']) test(`${entry}: active Q blocks all navigation while the host is generating or finishing its stream tail`, () => {
  const f = fixture(), { ticket } = f.begin(); f.hostGenerating = true;
  assert.equal(f.click(f[entry]).stopped, true);
  assert.deepEqual(f.calls, []); assert.equal(f.cancels, 0); assert.deepEqual(f.navigations, []);
  assert.match(f.notices.at(-1)[0], /正文尚未结束/);
  assert.equal(f.guard.acquire(ticket), true);
  assert.equal(f.click(f[entry]).stopped, true);
  assert.equal(f.guard.hasPendingNavigation(ticket), false); assert.deepEqual(f.navigations, []);
  f.guard.release(ticket); f.guard.dispose();
});

for (const entry of ['close', 'character', 'history', 'group', 'newChat', 'newFromHistory']) test(`${entry}: generation protection is scoped to an active Q run rather than becoming a global ST lock`, () => {
  const f = fixture(); f.hostGenerating = true;
  assert.equal(f.click(f[entry]).stopped, false); assert.deepEqual(f.calls, ['host']);
  assert.equal(f.notices.length, 0); assert.deepEqual(f.navigations, []); f.guard.dispose();
});

for (const entry of ['close', 'character', 'history', 'group', 'newChat', 'newFromHistory']) test(`${entry}: unknown host state cannot cancel an active Q run or schedule navigation during saving`, () => {
  const f = fixture(), { ticket } = f.begin(); f.hostGenerating = undefined;
  assert.equal(f.click(f[entry]).stopped, true); assert.equal(f.cancels, 0); assert.deepEqual(f.navigations, []);
  assert.equal(f.guard.acquire(ticket), true);
  assert.equal(f.click(f[entry]).stopped, true); assert.equal(f.guard.hasPendingNavigation(ticket), false);
  f.guard.release(ticket); f.guard.dispose();
});

test('allowed navigation cancels queued automatic work even without an active Q run', () => {
  const f = fixture();
  for (const kind of ['close', 'character', 'history', 'group', 'newChat', 'newFromHistory']) f.click(f[kind]);
  assert.deepEqual(f.navigations, ['close', 'character', 'history', 'group', 'new', 'new']);
  f.hostGenerating = true; f.click(f.close);
  assert.equal(f.navigations.length, 6); f.guard.dispose();
});

test('close during saving records one intent and cancels queued automatic work only once', async () => {
  const f = fixture(), { ticket } = f.begin(); f.guard.acquire(ticket);
  f.click(f.close); f.click(f.close); f.click(f.close);
  assert.equal(f.guard.hasPendingNavigation(ticket), true); assert.equal(f.guard.hasPendingNavigation({}), false);
  assert.deepEqual(f.navigations, ['close']); assert.deepEqual(f.calls, []);
  let closes = 0;
  assert.equal(await f.guard.finish(ticket, { confirmed: true, isCurrent: () => true, navigate: () => { closes++; return 'completed'; } }), true);
  assert.equal(closes, 1); assert.equal(f.guard.hasPendingNavigation(ticket), false);
  assert.equal(f.guard.release(ticket), false);
  assert.equal(await f.guard.finish(ticket, { confirmed: true, isCurrent: () => true, navigate: () => { closes++; return 'completed'; } }), false);
  assert.equal(closes, 1); f.guard.dispose();
});

test('native asynchronous close retains saving protection and repeated finish shares one promise', async () => {
  const f = fixture(), { ticket } = f.begin(); f.guard.acquire(ticket); f.click(f.close);
  let endClose, closes = 0;
  const finish = f.guard.finish(ticket, { confirmed: true, isCurrent: () => true,
    navigate: () => { closes++; return new Promise(resolve => { endClose = resolve; }); } });
  assert.equal(f.guard.finish(ticket, { confirmed: false }), finish);
  await Promise.resolve();
  assert.equal(closes, 1); assert.equal(f.guard.release(ticket), false);
  for (const kind of ['close', 'character', 'history', 'group', 'newChat', 'newFromHistory']) assert.equal(f.click(f[kind]).stopped, true);
  assert.deepEqual(f.navigations, ['close']); assert.equal(f.cancels, 0);
  f.time = 86_400_000; assert.equal(f.click(f.close).stopped, true);
  endClose('completed'); assert.equal(await finish, true);
  assert.equal(f.click(f.history).stopped, false); f.guard.dispose();
});

test('source identity check immediately precedes the native close without an asynchronous gap', async () => {
  const f = fixture(), { ticket } = f.begin(); f.guard.acquire(ticket); f.click(f.close);
  let current = true;
  assert.equal(await f.guard.finish(ticket, { confirmed: true,
    isCurrent: () => { queueMicrotask(() => { current = false; }); return current; },
    navigate: () => { assert.equal(current, true); return 'completed'; } }), true);
  f.guard.dispose();
});

test('the latest validated choice replaces the pending close rather than stacking host operations', async () => {
  const f = fixture(), { ticket } = f.begin(); f.guard.acquire(ticket); f.click(f.close);
  for (const kind of ['character', 'history', 'group']) f.click(f[kind]);
  const intents = [];
  assert.equal(await f.guard.finish(ticket, { confirmed: true, isCurrent: () => true, navigate: intent => { intents.push(intent); return 'completed'; } }), true);
  assert.deepEqual(intents, [{ kind: 'group', id: 'group-B' }]); assert.deepEqual(f.calls, []);
  assert.deepEqual(f.navigations, ['close', 'character', 'history', 'group']); f.guard.dispose();
});

test('a saved history choice continues with that filename and never becomes an automatic close', async () => {
  const f = fixture(), { ticket } = f.begin(); f.guard.acquire(ticket); f.click(f.history);
  const intents = [];
  assert.equal(await f.guard.finish(ticket, { confirmed: true, isCurrent: () => true, navigate: intent => { intents.push(intent); return 'completed'; } }), true);
  assert.deepEqual(intents, [{ kind: 'history', file: 'Synthetic B' }]); assert.deepEqual(f.navigations, ['history']); f.guard.dispose();
});

for (const [entry, expected] of [
  ['close', { kind: 'close' }], ['character', { kind: 'character', id: '1' }],
  ['group', { kind: 'group', id: 'group-B' }], ['history', { kind: 'history', file: 'Synthetic B' }],
  ['newChat', { kind: 'new', confirm: true }], ['newFromHistory', { kind: 'new', confirm: false }],
]) test(`${entry}: saving captures a frozen destination once and continues it without redispatching a click`, async () => {
  const captures = [], actions = [];
  const f = fixture({ captureIntent: raw => { assert.equal(Object.isFrozen(raw), true); captures.push(raw); return Object.freeze({ ...raw }); } });
  const { ticket } = f.begin(); f.guard.acquire(ticket); f.click(f[entry]);
  assert.deepEqual(captures, [expected]); assert.deepEqual(f.calls, []);
  assert.equal(await f.guard.finish(ticket, { confirmed: true, isCurrent: () => true,
    navigate: (intent, state) => { assert.equal(Object.isFrozen(intent), true); assert.equal(state.isCurrent(), true); actions.push(intent); return 'completed'; } }), true);
  assert.deepEqual(actions, [expected]); assert.deepEqual(f.calls, []); f.guard.dispose();
});

test('repeated destination coalesces but changed captured identity replaces even the same DOM index', async () => {
  let avatar = 'first.png';
  const f = fixture({ captureIntent: raw => Object.freeze({ ...raw, avatar }) }), { ticket } = f.begin(); f.guard.acquire(ticket);
  f.click(f.character); f.click(f.character); assert.deepEqual(f.navigations, ['character']);
  avatar = 'replacement.png'; f.click(f.character); f.click(f.character);
  assert.deepEqual(f.navigations, ['character', 'character']);
  let destination;
  assert.equal(await f.guard.finish(ticket, { confirmed: true, isCurrent: () => true,
    navigate: intent => { destination = intent; return 'completed'; } }), true);
  assert.deepEqual(destination, { kind: 'character', id: '1', avatar: 'replacement.png' }); f.guard.dispose();
});

for (const failure of ['null', 'throw', 'async', 'mutable', 'wrong-kind', 'cyclic']) test(`${failure}: an uncapturable latest choice clears an older pending destination`, async () => {
  const f = fixture({ captureIntent: raw => {
    if (raw.kind === 'close') return Object.freeze({ ...raw });
    if (failure === 'throw') throw Error('unavailable target');
    if (failure === 'async') return Promise.resolve(Object.freeze({ ...raw }));
    if (failure === 'mutable') return { ...raw };
    if (failure === 'wrong-kind') return Object.freeze({ kind: 'close' });
    if (failure === 'cyclic') { const value = { ...raw }; value.self = value; return Object.freeze(value); }
    return null;
  } });
  const { ticket } = f.begin(); f.guard.acquire(ticket); f.click(f.close); f.time = 2000;
  assert.equal(f.click(f.character).stopped, true); assert.equal(f.guard.hasPendingNavigation(ticket), false);
  assert.match(f.notices.at(-1)[0], /暂无法确认目标/);
  let invoked = false;
  assert.equal(await f.guard.finish(ticket, { confirmed: true, isCurrent: () => true,
    navigate: () => { invoked = true; return 'completed'; } }), false);
  assert.equal(invoked, false); assert.deepEqual(f.navigations, ['close']); f.guard.dispose();
});

test('without an injected target resolver only close can be captured safely', async () => {
  const f = fixture({ captureIntent: undefined });
  f.guard.dispose();
  const guard = createDirectorLeaveGuard({ document: f.document, getContext: () => f.context, isHostGenerating: () => false });
  const ticket = guard.begin({}, () => {}); guard.acquire(ticket);
  f.click(f.close); assert.equal(guard.hasPendingNavigation(ticket), true);
  f.click(f.history); assert.equal(guard.hasPendingNavigation(ticket), false);
  assert.equal(await guard.finish(ticket, { confirmed: true, isCurrent: () => true, navigate: () => assert.fail('no unsafe fallback') }), false);
  guard.dispose();
});

test('generation-stage navigation never needs a deferred target resolver or bypasses the native new-chat confirmation', () => {
  const f = fixture({ captureIntent: () => { assert.fail('capture belongs only to pending saves'); } }), { ticket } = f.begin();
  assert.equal(f.click(f.newChat).stopped, false); assert.deepEqual(f.calls, ['cancel', 'host']);
  assert.deepEqual(f.navigations, ['new']); assert.equal(f.guard.acquire(ticket), false); f.guard.release(ticket); f.guard.dispose();
});

test('a newly busy host clears an earlier pending choice instead of later executing a stale one', async () => {
  const f = fixture(), { ticket } = f.begin(); f.guard.acquire(ticket); f.click(f.close);
  f.hostGenerating = true; f.click(f.character); f.hostGenerating = false;
  assert.equal(f.guard.hasPendingNavigation(ticket), false);
  assert.equal(await f.guard.finish(ticket, { confirmed: true, isCurrent: () => true, navigate: () => assert.fail('old close discarded') }), false);
  f.guard.dispose();
});

test('new-chat confirmation cancellation is not reported as navigation failure', async () => {
  const f = fixture(), { ticket } = f.begin(); f.guard.acquire(ticket); f.click(f.newChat);
  const noticesBefore = f.notices.length;
  assert.equal(await f.guard.finish(ticket, { confirmed: true, isCurrent: () => true, navigate: () => 'cancelled' }), false);
  assert.equal(f.notices.length, noticesBefore); assert.equal(f.guard.release(ticket), false); f.guard.dispose();
});

for (const change of ['source', 'dispose']) test(`${change}: asynchronous navigation can recheck ownership after awaiting its confirmation`, async () => {
  const f = fixture(), { ticket } = f.begin(); f.guard.acquire(ticket); f.click(f.newChat);
  let sourceCurrent = true, proceed, ownership;
  const finish = f.guard.finish(ticket, { confirmed: true, isCurrent: () => sourceCurrent,
    navigate: async (_intent, state) => { ownership = state.isCurrent; await new Promise(resolve => { proceed = resolve; }); return state.isCurrent() ? 'completed' : 'cancelled'; } });
  await Promise.resolve(); assert.equal(ownership(), true);
  if (change === 'source') sourceCurrent = false; else f.guard.dispose();
  assert.equal(ownership(), false); assert.equal(f.click(f.history).stopped, true);
  proceed(); assert.equal(await finish, false); assert.equal(f.guard.release(ticket), false); f.guard.dispose();
});

for (const reason of ['unconfirmed', 'source-changed', 'disposed', 'host-generating', 'host-unknown', 'async-source-check']) {
  test(`${reason}: finish discards close intent without closing or retrying a write`, async () => {
    const f = fixture(), { ticket } = f.begin(); f.guard.acquire(ticket); f.click(f.close);
    if (reason === 'disposed') f.guard.dispose();
    if (reason === 'host-generating') f.hostGenerating = true;
    if (reason === 'host-unknown') f.hostGenerating = null;
    let closes = 0;
    assert.equal(await f.guard.finish(ticket, { confirmed: reason !== 'unconfirmed',
      isCurrent: () => reason === 'async-source-check' ? Promise.resolve(true) : reason !== 'source-changed',
      navigate: () => { closes++; return 'completed'; } }), false);
    assert.equal(closes, 0); assert.equal(f.guard.hasPendingNavigation(ticket), false);
    assert.equal(f.guard.release(ticket), false);
    if (reason.startsWith('host-')) assert.match(f.notices.at(-1)[0], /暂未继续/);
    f.guard.dispose();
  });
}

test('dispose before deferred completion starts discards the close and detaches after releasing owner', async () => {
  const f = fixture(), { ticket } = f.begin(); f.guard.acquire(ticket); f.click(f.close);
  let closes = 0;
  const finish = f.guard.finish(ticket, { confirmed: true, isCurrent: () => true, navigate: () => { closes++; return 'completed'; } });
  f.guard.dispose();
  assert.equal(f.listeners.length, 1); assert.equal(await finish, false);
  assert.equal(closes, 0); assert.equal(f.listeners.length, 0);
});

test('dispose during native close retains protection until that native operation finishes', async () => {
  const f = fixture(), { ticket } = f.begin(); f.guard.acquire(ticket); f.click(f.close);
  let endClose;
  const finish = f.guard.finish(ticket, { confirmed: true, isCurrent: () => true, navigate: () => new Promise(resolve => { endClose = resolve; }) });
  await Promise.resolve(); f.guard.dispose();
  assert.equal(f.listeners.length, 1); assert.equal(f.click(f.history).stopped, true);
  endClose('completed'); assert.equal(await finish, true); assert.equal(f.listeners.length, 0);
});

for (const result of ['rejected', 'refused', 'undefined']) {
  test(`native close ${result}: do not replay and report that chat remains open`, async () => {
    const f = fixture(), { ticket } = f.begin(); f.guard.acquire(ticket); f.click(f.close);
    let closes = 0;
    assert.equal(await f.guard.finish(ticket, { confirmed: true, isCurrent: () => true,
      navigate: () => { closes++; return result === 'rejected' ? Promise.reject(Error('close failed')) : result === 'refused' ? 'unavailable' : undefined; } }), false);
    assert.equal(closes, 1); assert.match(f.notices.at(-1)[0], /未能继续切换/);
    assert.equal(f.guard.hasPendingNavigation(ticket), false); assert.equal(f.click(f.history).stopped, false); f.guard.dispose();
  });
}

test('an old or foreign completion cannot close or release another ticket', async () => {
  const f = fixture(), old = f.begin(); f.guard.release(old.ticket);
  const { ticket } = f.begin(); f.guard.acquire(ticket); f.click(f.close);
  let closes = 0;
  assert.equal(await f.guard.finish(old.ticket, { confirmed: true, isCurrent: () => true, navigate: () => { closes++; return 'completed'; } }), false);
  assert.equal(closes, 0); assert.equal(f.guard.hasPendingNavigation(ticket), true); assert.equal(f.click(f.history).stopped, true);
  f.guard.release(ticket); f.guard.dispose();
});

test('module has no timer-based unlock, host lock mutation, global network interception or storage', async () => {
  const code = await readFile(new URL('../qianmu-director-leave-guard.js', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /\b(?:setTimeout|setInterval|fetch|saveMetadata|localStorage|indexedDB)\s*\(/);
  assert.doesNotMatch(code, /isChatSaving\s*=/); assert.match(code, /addEventListener\('click', onClick, true\)/);
});
