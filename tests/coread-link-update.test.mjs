import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createYimuCompanionBridge, offerLinkUpdate, runLink, formatReadLabel, LINK_TEXT} from '../qianmu-yimu-companion.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = 'scope::book';
const selection = {key, bookId: 'book', scope: 'scope', persona: 'Persona.png', avatar: 'Char.png'};
const story = () => ({avatar: 'Char.png', file: 'story', integrity: 'proof'});
const dialog = (id, readTo, summary = '两人聊到车站的分别。') => ({id, summary,
  provenance: {source: 'dialog', sources: ['dialog'], bookId: 'book', bucket: key, readTo, dialogFrom: 0, dialogTo: 0, dialogMessageIds: [`${id}-m`]}});
const book = (id, readTo) => ({id, summary: '书中人物在车站分别。', coveredTo: readTo, keywords: ['车站'],
  provenance: {source: 'book', sources: ['book'], bookId: 'book', bucket: key, readTo, charFrom: 0, charTo: readTo}});

// The reader's real bridge on one side, a stand-in for 忆幕 (which only answers for the story it has open) on the other.
function fixture() {
  const state = {available: true, owner: {}, coread: {books: [{id: 'book', title: '合成书', charCount: 1000}], companionSessions: [{scope: 'scope', avatar: 'Char.png', userAvatar: 'Persona.png'}]},
    characters: [{avatar: 'Char.png', name: '书友'}], personas: [{key: 'Persona.png', name: '读者'}], boundaries: {}, story: story(), currentKey: ''};
  const record = {bookId: 'book', slices: [dialog('d1', 100), book('b1', 200)]};
  const bridge = createYimuCompanionBridge({getState: () => state, resolveAccount: async () => 'st-user:fixture', hash, listKeys: async () => [key], readRecord: async () => record});
  const yimu = {open: story(), stored: null, updates: [], failing: false};
  bridge.api.setLink({
    status: context => JSON.stringify(context.story) !== JSON.stringify(yimu.open) ? null
      : yimu.stored ? {linked: true, confirmedReadTo: yimu.stored.confirmedReadTo, readLabel: yimu.stored.readLabel, updatedAt: 1,
        entryHashes: Object.fromEntries(yimu.stored.entries.map(entry => [entry.id, entry.hash]))} : {linked: false},
    update: async (context, payload) => { yimu.updates.push(payload); if (yimu.failing) throw Error('offline'); yimu.stored = payload.snapshot; return {linked: true}; },
    unlink: async () => { yimu.stored = null; return {linked: false}; },
  });
  const asked = [], toasts = [];
  const ui = {answer: '', ask: async prompt => { asked.push(prompt); return ui.answer; }, confirm: async () => true, notify: (...args) => toasts.push(args)};
  const captured = (confirmedReadTo = 300, readLabel = '第3章 · 30%') => ({selection, confirmedReadTo, readLabel});
  const link = () => bridge.linkUpdate(selection, {confirmedReadTo: 300, readLabel: '第3章 · 30%'});
  return {state, record, bridge, yimu, ui, asked, toasts, captured, link};
}

test('closing the reader asks nothing while the book is not linked to the open story', async () => {
  const f = fixture();
  assert.equal(await offerLinkUpdate(f.bridge, f.captured(), f.ui), 'unlinked');
  assert.equal(f.asked.length, 0); assert.equal(f.yimu.updates.length, 0); assert.deepEqual(f.toasts, []);
});

test('nothing new was read into memory: no prompt, even though the reading position moved', async () => {
  const f = fixture(); await f.link(); f.yimu.updates.length = 0;
  assert.equal(await offerLinkUpdate(f.bridge, f.captured(), f.ui), 'unchanged');
  assert.equal(await offerLinkUpdate(f.bridge, f.captured(900, '第9章 · 90%'), f.ui), 'unchanged', 'a moved boundary alone never prompts');
  assert.equal(f.asked.length, 0); assert.equal(f.yimu.updates.length, 0); assert.deepEqual(f.toasts, []);
});

test('a new slice asks once, and the optional note travels with the update', async () => {
  const f = fixture(); await f.link(); f.yimu.updates.length = 0;
  f.record.slices.push(dialog('d2', 400, '两人争论结局是否圆满。'), dialog('d3', 450, '两人约好读完再谈。'));
  f.ui.answer = '在咖啡馆一起读完了第四章';
  assert.equal(await offerLinkUpdate(f.bridge, f.captured(500, '第5章 · 50%'), f.ui), 'updated');
  assert.deepEqual(f.asked, [{title: '更新关联伴读', okButton: '更新', cancelButton: '先不用', placeholder: '这次发生了什么（可不填）',
    body: '这次读到 第5章 · 50%，多了 2 条共读记忆。要更新到当前故事吗？'}]);
  assert.equal(f.yimu.updates.length, 1); assert.equal(f.yimu.updates[0].note, '在咖啡馆一起读完了第四章');
  assert.equal(f.yimu.updates[0].confirmed, true); assert.equal(f.yimu.updates[0].confirmedLocalOwnership, true);
  assert.deepEqual(f.yimu.updates[0].snapshot.entries.map(entry => entry.id), ['d1', 'b1', 'd2', 'd3']);
  assert.equal(f.yimu.updates[0].snapshot.readLabel, '第5章 · 50%'); assert.deepEqual(f.toasts, [[LINK_TEXT.updated, 'success']]);
  assert.equal(await offerLinkUpdate(f.bridge, f.captured(500, '第5章 · 50%'), f.ui), 'unchanged', 'once updated there is nothing left to ask about');
});

test('an edited slice counts as changed; an empty note is fine; 先不用 changes nothing', async () => {
  const f = fixture(); await f.link(); f.yimu.updates.length = 0;
  f.record.slices[0].summary = '两人后来改口，说那不是分别。';
  f.ui.answer = null;
  assert.equal(await offerLinkUpdate(f.bridge, f.captured(), f.ui), 'declined');
  assert.equal(f.asked.length, 1); assert.match(f.asked[0].body, /多了 1 条共读记忆/); assert.equal(f.yimu.updates.length, 0); assert.deepEqual(f.toasts, []);
  f.ui.answer = '';
  assert.equal(await offerLinkUpdate(f.bridge, f.captured(), f.ui), 'updated');
  assert.equal(f.yimu.updates[0].note, ''); assert.equal(f.asked.length, 2);
});

test('a failed update says so once and leaves the link as it was', async () => {
  const f = fixture(); await f.link(); const before = f.yimu.stored; f.yimu.updates.length = 0;
  f.record.slices.push(dialog('d2', 250)); f.yimu.failing = true; f.ui.answer = '记一笔';
  assert.equal(await offerLinkUpdate(f.bridge, f.captured(), f.ui), 'failed');
  assert.deepEqual(f.toasts, [['没更新成功，可稍后在忆幕里更新', 'warning']]); assert.equal(f.yimu.stored, before); assert.equal(f.asked.length, 1);
});

test('another story chat is open: the linked book is not offered an update there', async () => {
  const f = fixture(); await f.link(); f.yimu.updates.length = 0; f.record.slices.push(dialog('d2', 250));
  f.state.story = {...story(), file: 'another story'};
  assert.equal(await offerLinkUpdate(f.bridge, f.captured(), f.ui), 'unlinked', 'the reader is in a chat Yimu does not have open');
  f.state.story = story(); f.yimu.open = {...story(), file: 'another story'};
  assert.equal(await offerLinkUpdate(f.bridge, f.captured(), f.ui), 'unlinked', 'Yimu has a different story open');
  f.state.story = null;
  assert.equal(await offerLinkUpdate(f.bridge, f.captured(), f.ui), 'unlinked', 'no story chat at all (group chat or none)');
  assert.equal(f.asked.length, 0); assert.equal(f.yimu.updates.length, 0); assert.deepEqual(f.toasts, []);
});

test('leafing back to an earlier page never takes shared memories away from the story', async () => {
  const f = fixture(); await f.link(); f.yimu.updates.length = 0;
  f.record.slices.push(dialog('d2', 50, '重读第一章时的新想法。'));
  assert.equal(await offerLinkUpdate(f.bridge, f.captured(60, '第1章 · 6%'), f.ui), 'updated');
  const sent = f.yimu.updates[0].snapshot;
  assert.equal(sent.confirmedReadTo, 300); assert.equal(sent.readLabel, '第3章 · 30%');
  assert.deepEqual(sent.entries.map(entry => entry.id), ['d1', 'b1', 'd2'], 'what was shared up to 300 stays; the new early slice joins');
  assert.match(f.asked[0].body, /这次读到 第3章 · 30%，多了 1 条共读记忆/);
});

test('an unknown position or a missing selection is skipped without asking Yimu', async () => {
  const f = fixture(); await f.link();
  assert.equal(await offerLinkUpdate(f.bridge, {selection, confirmedReadTo: null}, f.ui), 'skipped');
  assert.equal(await offerLinkUpdate(f.bridge, null, f.ui), 'skipped');
  assert.equal(f.asked.length, 0);
});

// ---- index.js wiring ----
const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
function host({linked = true, busy = false} = {}) {
  const trace = [], prompts = [], toasts = [];
  const bridge = {linkAvailable: () => linked, linkStatus: async () => null};
  const c = vm.createContext({trace, prompts, toasts, formatReadLabel, Number, Date,
    focusClockBlockExit: () => false, focusClockCancelEntry() {}, focusClockPauseForReadingExit() {},
    coreadMemoryWrites: busy ? 1 : 0, coreadIdentitySwitchBusy: false, coreadDistilling: false, coreadAutoTextInFlight: false, coreadOpenRequestId: 0,
    coreadStopDialog() {}, coreadStopAssistant() {}, coreadClearPendingChatImages() {}, coreadComicStop() {}, coreadComicVisionAbort: null, coreadComicVisionBusy: false,
    coreadAssistantConfig: () => ({historyMode: 'session'}), coreadStoreAssistantHistory: async () => {}, coreadSaveProgress: () => trace.push('saved'),
    unmountReaderPortal: () => trace.push('unmounted'), renderModal: () => trace.push('rendered'), rerenderMoreIfOpen: () => trace.push('rerender'),
    readerView: {bookId: 'book', companionScope: 'scope', chapterIndex: 2, returnTab: 'coread'}, readerContentCache: {bookId: 'book', chapters: []}, readerDialog: {bookId: 'book'}, activeTab: 'coread',
    coreadCompanionCharacter: () => c.readerView ? {avatar: 'Char.png'} : null, coreadPersona: () => ({key: 'Persona.png'}), coreadCompanionSession: () => null,
    coreadCurrentReadBoundarySync: id => { trace.push(['boundary', id, !!c.readerView]); return {bookId: id, readTo: 300, chapterIndex: 2, progress: 30, exact: true}; },
    coreadBookMeta: () => ({mode: 'text'}), yimuCompanionBridge: bridge, nowMs: () => 1000,
    offerLinkUpdate: async (given, captured, ui) => { trace.push(['offer', given === bridge, captured]); return c.next?.(ui); },
    runLink: async (given, captured, ui) => { trace.push(['run', given === bridge, captured]); return c.next?.(ui); },
    coreadPromptText: async (...args) => { prompts.push(args); return '记一笔'; }, confirmDialog: async (...args) => { prompts.push(args); return true; },
    toast: (...args) => toasts.push(args)});
  vm.runInContext(['coreadCloseReader', 'coreadCaptureLink', 'coreadOfferLinkUpdate'].map(section).join('\n'), c);   // the second section carries `let coreadLinkState`
  return {c, trace, prompts, toasts};
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const expected = {selection: {key: 'scope::book', bookId: 'book', scope: 'scope', persona: 'Persona.png', avatar: 'Char.png'}, confirmedReadTo: 300, readLabel: '第3章 · 30%'};

test('the reader records who, which book and how far before it tears down, and offers the update only after the UI has closed', async () => {
  const {c, trace} = host();
  c.coreadCloseReader();
  assert.equal(c.readerView, null); assert.equal(c.readerContentCache, null);
  const plain = JSON.parse(JSON.stringify(trace));
  assert.deepEqual(plain.slice(0, 5), ['saved', ['boundary', 'book', true], 'unmounted', 'rendered', ['offer', true, expected]],
    'the position is taken while the reader is still open; the offer starts after the modal is repainted and is not awaited');
  await settle();
});

test('the offer hands the dialog texts to the reader popup and failures to a toast, and never throws into the close path', async () => {
  const {c, prompts, toasts, trace} = host();
  c.next = async ui => {
    const note = await ui.ask({title: '更新关联伴读', body: '正文', placeholder: '这次发生了什么（可不填）', okButton: '更新', cancelButton: '先不用'});
    await ui.confirm({title: '关联伴读', body: '确认', okButton: '关联', cancelButton: '取消'});
    ui.notify('没更新成功，可稍后在忆幕里更新', 'warning'); ui.notify('默认类型');
    return note;
  };
  assert.equal(await c.coreadOfferLinkUpdate(expected), '记一笔');
  assert.deepEqual(JSON.parse(JSON.stringify(prompts)), [['更新关联伴读', '正文', '', {okButton: '更新', cancelButton: '先不用', placeholder: '这次发生了什么（可不填）'}],
    ['关联伴读', '确认', {okButton: '关联', cancelButton: '取消'}]]);
  assert.deepEqual(JSON.parse(JSON.stringify(toasts)), [['没更新成功，可稍后在忆幕里更新', 'warning'], ['默认类型', 'info']]);
  assert.ok(!trace.includes('rerender'), 'the close-time offer does not repaint a page that is gone');
  c.next = async () => { throw Error('bridge exploded'); };
  assert.equal(await c.coreadOfferLinkUpdate(expected), 'failed');
  c.next = async () => 'linked';
  assert.equal(await c.coreadOfferLinkUpdate(expected, {always: true}), 'linked');
  assert.deepEqual(JSON.parse(JSON.stringify(trace.at(-2))), ['run', true, expected]); assert.equal(trace.at(-1), 'rerender', 'the memory page button refreshes its 已关联 state');
});

test('nothing is captured or offered when Yimu is not attached, the companion is unknown or the reader refuses to close', async () => {
  let h = host({linked: false}); h.c.coreadCloseReader(); await settle();
  assert.equal(h.c.readerView, null); assert.ok(!h.trace.some(step => Array.isArray(step)), 'no boundary read and no offer');
  h = host({busy: true}); h.c.coreadCloseReader(); await settle();
  assert.notEqual(h.c.readerView, null); assert.deepEqual(h.trace, []); assert.equal(h.toasts.length, 1);
  h = host(); h.c.coreadPersona = () => null;
  assert.equal(h.c.coreadCaptureLink(), null);
  h = host(); h.c.readerView.companionScope = '';
  assert.equal(h.c.coreadCaptureLink(), null, 'an archive without a companion session has no identity to link');
  h = host(); h.c.coreadCurrentReadBoundarySync = id => ({bookId: id, readTo: null});
  assert.equal(h.c.coreadCaptureLink(), null, 'an unknown position is never guessed');
  h = host(); h.c.coreadBookMeta = () => ({mode: 'comic'});
  assert.equal(h.c.coreadCaptureLink().readLabel, '第3页 · 30%');
});

test('the input popup takes custom buttons and a placeholder without changing its other callers', () => {
  const body = section('coreadPromptText');
  assert.match(body, /async function coreadPromptText\(title, label, defaultValue = '', \{ okButton = '确定', cancelButton = '取消', placeholder = '' \} = \{\}\)/);
  assert.match(body, /new Popup\(header, context\.POPUP_TYPE\.INPUT, String\(defaultValue \|\| ''\), \{ okButton, cancelButton \}\)/);
  assert.match(body, /if \(placeholder && popup\.mainInput\) popup\.mainInput\.placeholder = placeholder;/);
  assert.match(source, /if \(linkCapture\) void coreadOfferLinkUpdate\(linkCapture\);/);
  assert.match(source, /readDictionary: bound => coreadDictFor\(bound\),/);
});

test('runLink is what the memory page button runs: one confirmation to link, the update dialog once linked', async () => {
  const f = fixture(), confirms = [];
  f.ui.confirm = async prompt => { confirms.push(prompt); return true; };
  assert.equal(await runLink(f.bridge, f.captured(), f.ui), 'linked');
  assert.deepEqual(confirms, [{title: '关联伴读', okButton: '关联', cancelButton: '取消', body: '把《合成书》读到 第3章 · 30% 的共读记忆关联到当前故事？'}]);
  assert.equal(f.yimu.updates[0].confirmedLocalOwnership, true, 'the single confirmation carries the ownership consent');
  assert.deepEqual(f.toasts.at(-1), ['已关联。之后读了新内容，关闭阅读器时会问你要不要更新。', 'success']);
  assert.equal(await runLink(f.bridge, f.captured(), f.ui), 'updated'); assert.equal(confirms.length, 1); assert.equal(f.asked.length, 1);
  f.record.slices = [];
  f.yimu.stored = null; assert.equal(await runLink(f.bridge, f.captured(), f.ui), 'unreadable'); assert.deepEqual(f.toasts.at(-1), [LINK_TEXT.nothing, 'info']);
});
