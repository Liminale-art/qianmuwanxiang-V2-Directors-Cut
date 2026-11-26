import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as reader from '../qianmu-reader.js';
import { stripDialogQuotes } from '../qianmu-storyboard-utils.js';
import { storyboardFunctionSource as section } from './helpers/storyboard-form-fixture.mjs';

// 真实的 coreadGenerateReply：重新生成没出新回复（失败、停止）时原回复放回；回复已总结进记忆时先问一声。
function fixture({ slices = [], answer = true } = {}) {
  const toasts = [], saves = [], confirms = [], state = { model: async () => '新的一句' };
  const view = { bookId: 'book' };
  const dialog = { bucket: 'A::book', bookId: 'book', loaded: true, slices, messages: [
    { id: 'u1', role: 'user', text: '你看到哪了' }, { id: 'f1', role: 'friend', text: '旧回复一' }, { id: 'f2', role: 'friend', text: '旧回复二' },
  ] };
  const c = vm.createContext({
    reader, console, MODULE_NAME: 'fixture', AbortController, setTimeout, stripDialogQuotes,
    readerView: view, readerDialog: dialog, dialogBusy: false, dialogAbort: null, dialogGenToken: 0, settings: { streamEnabled: false },
    document: { getElementById: () => null }, coreadDialogBucket: () => 'A::book',
    coreadMemory: () => ({ recallScanMessages: 8, autoDistill: false }), coreadCompanion: () => ({ recentDialogueCount: 20, replyLinesMin: 1, replyLinesMax: 3 }),
    buildCompanionContext: async () => ({ systemPrompt: 'SYS' }), companionCharName: () => '友', coreadUserName: () => '我',
    uid: (() => { let n = 0; return (p) => `${p}-${++n}`; })(), coreadSyncDialogButtons: () => {}, renderReaderDialogMessages: () => '',
    applyQianmuIcons: () => {}, scrollDialogToBottom: () => {}, coreadBookMeta: () => ({ mode: 'text' }), coreadComicConfig: () => ({}),
    blobStore: {}, parseCoreadDialogOutput: (text) => ({ lines: String(text || '').split('\n').filter(Boolean), reply: String(text || ''), thought: '' }),
    coreadCleanThoughtText: (t) => t, coreadExplainError: (e) => e.message, refreshMoreIfRecords: () => {}, coreadDistill: async () => ({}),
    toast: (message, level) => toasts.push({ message, level }), coreadSaveDialog: async () => { saves.push(dialog.messages.map((m) => m.id)); return true; },
    confirmDialog: async (title, message) => { confirms.push(message); return answer; },
    callCoreadDialogModel: (...args) => state.model(...args),
  });
  vm.runInContext(['lastFriendBatchRange', 'coreadGenerateReply'].map(section).join('\n'), c);
  return { c, dialog, toasts, saves, confirms, state, texts: () => dialog.messages.map((m) => m.text) };
}

test('a failed regenerate puts the original reply back and says so', async () => {
  const e = fixture();
  e.state.model = async () => { throw new Error('HTTP 500'); };
  await e.c.coreadGenerateReply(true);
  assert.deepEqual(e.texts(), ['你看到哪了', '旧回复一', '旧回复二']);
  assert.match(e.toasts.at(-1).message, /伴读对话生成失败：HTTP 500；原回复已放回/);
  assert.deepEqual(e.saves.at(-1), ['u1', 'f1', 'f2'], 'what is saved still holds the original reply');
  assert.equal(e.c.dialogBusy, false);
});

test('stopping a regenerate before any line arrives also puts the original reply back', async () => {
  const e = fixture();
  e.state.model = async () => { e.c.dialogGenToken++; const error = new Error('aborted'); error.name = 'AbortError'; throw error; };
  await e.c.coreadGenerateReply(true);
  assert.deepEqual(e.texts(), ['你看到哪了', '旧回复一', '旧回复二']);
  assert.ok(!e.dialog.messages.some((m) => m.role === 'friend' && !m.text), 'no empty placeholder is left behind');
});

test('a successful regenerate replaces the reply', async () => {
  const e = fixture();
  await e.c.coreadGenerateReply(true);
  assert.deepEqual(e.texts(), ['你看到哪了', '新的一句']);
  assert.equal(e.confirms.length, 0, 'nothing summarized yet: no question');
});

test('regenerating a reply that is already in a memory asks first; declining changes nothing', async () => {
  const slice = reader.normalizeCoreadSlice({ id: 's1', src: 'dialog', summary: '记过', coveredFrom: 0, coveredTo: 2, provenance: { source: 'dialog', dialogMessageIds: ['u1', 'f1', 'f2'] } });
  const e = fixture({ slices: [slice], answer: false });
  let called = 0; e.state.model = async () => { called++; return 'x'; };
  await e.c.coreadGenerateReply(true);
  assert.equal(e.confirms.length, 1);assert.match(e.confirms[0], /已经总结进记忆/);
  assert.equal(called, 0);assert.deepEqual(e.texts(), ['你看到哪了', '旧回复一', '旧回复二']);
  const yes = fixture({ slices: [slice], answer: true });
  await yes.c.coreadGenerateReply(true);
  assert.deepEqual(yes.texts(), ['你看到哪了', '新的一句']);
});
