import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as reader from '../qianmu-reader.js';
import { storyboardFunctionSource as section } from './helpers/storyboard-form-fixture.mjs';

// 方案 §七「无声」几条：失败要说出来，且只说一次。
test('a dialogue that cannot be saved locally is reported once per opened book', async () => {
  const toasts = [];
  const c = vm.createContext({ reader, console: { warn: () => {} }, MODULE_NAME: 'fixture', toast: (message, level) => toasts.push({ message, level }),
    readerDialog: { bucket: 'A::book', bookId: 'book', loaded: true, messages: [], slices: [] }, readerAssistant: {},
    readerChatSync: { put: async () => { throw new Error('QuotaExceededError'); } },
    coreadAssistantConfig: () => ({ historyMode: 'session' }), companionCharName: () => '友', coreadUserName: () => '我' });
  vm.runInContext(section('coreadSaveDialog'), c);
  assert.equal(await c.coreadSaveDialog(), false);
  assert.equal(await c.coreadSaveDialog(), false);
  assert.equal(toasts.length, 1);assert.match(toasts[0].message, /没能存进本机/);
  c.readerDialog = { bucket: 'B::book', bookId: 'book', loaded: true, messages: [], slices: [] };   // 重新打开：再提示一次
  await c.coreadSaveDialog();
  assert.equal(toasts.length, 2);
});

test('a migration list that could not be read says so instead of “nothing found”', async () => {
  const c = vm.createContext({ coreadDialogBucket: () => 'cur::book',
    blobStore: { listReaderChatKeys: async () => ['a::book', 'b::book'], getReaderChat: async (key) => { if (key === 'a::book') throw new Error('disk'); return { messages: [{ text: 'x' }], updatedAt: 1 }; } } });
  vm.runInContext(section('coreadListMigratableChats'), c);
  const list = await c.coreadListMigratableChats('book');
  assert.equal(list.length, 1);assert.equal(list.failed, true);
  c.blobStore.listReaderChatKeys = async () => { throw new Error('disk'); };
  const none = await c.coreadListMigratableChats('book');
  assert.equal(none.length, 0);assert.equal(none.failed, true);
  c.blobStore = { listReaderChatKeys: async () => [], getReaderChat: async () => null };
  assert.equal((await c.coreadListMigratableChats('book')).failed, false);
});

test('when the comic page record fails to load, the recognise button asks to reopen instead of waiting forever', async () => {
  const toasts = [];
  const cache = { bookId: 'book', comicDescriptions: {} };
  const c = vm.createContext({ reader, console: { warn: () => {} }, MODULE_NAME: 'fixture', readerContentCache: cache,
    readerView: { bookId: 'book', chapterIndex: 0 }, readerDialog: { loaded: true, bookId: 'book' }, coreadComicVisionBusy: false, coreadComicFill: null,
    coreadBookMeta: () => ({ mode: 'comic' }), readerChatSync: { get: async () => { throw new Error('read failed'); } },
    toast: (message, level) => toasts.push({ message, level }), coreadComicSyncStatus: () => {}, rerenderMoreIfOpen: () => {}, coreadComicAuto: async () => {} });
  vm.runInContext(['coreadComicLoad', 'coreadComicRecord', 'coreadAnalyzeComicPages'].map(section).join('\n'), c);
  await c.coreadComicLoad('book');
  assert.equal(cache.comicLoadFailed, true);
  await c.coreadAnalyzeComicPages();
  assert.match(toasts.at(-1).message, /页稿没读出来，请关掉这本书再打开/);
  assert.doesNotMatch(toasts.at(-1).message, /正在载入/);
});
