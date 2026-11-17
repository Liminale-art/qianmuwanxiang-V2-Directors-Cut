import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const [source, centerView, css, bridge, yimuRuntime, yimuView] = await Promise.all(['../index.js', '../qianmu-reader-center-view.js',
  '../style.css', '../qianmu-yimu-companion.js', '../yimu/companion-runtime.mjs', '../yimu/companion-view.mjs'].map(read));

test('the reader no longer injects its own memory into the story chat', () => {
  for (const removed of ['coreadBuildMainlineInjection', 'coreadMainlinePool', 'coreadPoolCache', 'coreadInvalidatePool', 'coreadRefreshContainer',
    'coreadBoundBuckets', 'coreadListAllArchives', 'coreadToggleBind', 'renderCoreadArchivePage', 'coreadOpenArchivePage', 'coreadArchivePageItems',
    'coreadSelfTest', 'qmCoreadSelfTest', 'store.coreadBound', '主线联动', '反哺主线', '绑定档案', '管理档案']) {
    assert.equal(source.includes(removed), false, removed);
  }
  const interceptor = source.slice(source.indexOf('async function qianmuDirectorInterceptor(chat)'), source.indexOf('function directorMainlineStarted'));
  assert.ok(interceptor.length > 0);
  assert.doesNotMatch(interceptor, /coread/i);
});

test('the four mainline settings have no default, control or handler, and stored values are only dropped', () => {
  const mentions = source.split('\n').filter(line => /mainline(Feedback|Recall|Recent|Depth)/.test(line));
  assert.equal(mentions.length, 1);
  assert.match(mentions[0], /for \(const k of \[[^\]]*'mainlineFeedback', 'mainlineRecall', 'mainlineRecent', 'mainlineDepth'\]\) delete m\[k\];/);
  assert.doesNotMatch(source + centerView, /sd-reader-mainline-/);
  assert.doesNotMatch(centerView, /mainline|主线联动|boundN|绑定档案|管理档案|liChannelLabel/);
});

test('the archive binding page, its route and its styles are gone', () => {
  assert.doesNotMatch(source + centerView + css, /sd-reader-archive-|sd-reader-arch-/);
  assert.doesNotMatch(source, /coreadCenterPage === 'archives'/);
});

test('moving a book over from another chat stays available on the slice page', () => {
  const slicePage = source.slice(source.indexOf('function renderCoreadSlicePage'), source.indexOf('async function coreadOpenSliceManagerDialog'));
  assert.match(slicePage, /class="sd-reader-textbtn sd-reader-slice-migrate"[^<]*<i [^>]*><\/i>从其他聊天迁移这本书<\/button>/);
  assert.match(source, /if \(e\.target\.closest\('\.sd-reader-slice-migrate'\)\) \{ coreadOpenMigrateDialog\(\); return; \}/);
  assert.match(source, /async function coreadOpenMigrateDialog\(\)[\s\S]*?coreadListMigratableChats\(bookId\)[\s\S]*?coreadMigrateFromChat\(list\[picked\]\.rec\)/);
  assert.match(css, /\.sd-reader-slice-secondary\s*\{/);
});

test('what stays: story context for the book friend, chat-bound dictionaries and old mainline-sourced slices', () => {
  assert.match(source, /function getMainlineCharContext\(floors\)/);
  assert.match(source, /cp\.chatCtxEnabled && coreadCompanionMatchesChat\(\) \? getMainlineCharContext\(cp\.chatCtxFloors\)/);
  assert.match(source, /function coreadBoundDicts\(\)[\s\S]*?store\.coreadDictBound/);
  assert.match(source, /function coreadSliceSourceLabel[\s\S]*?source === 'mainline'\) return '正文回响'/);
});

test('reader and story meet only through the Yimu bridge, named 关联伴读', () => {
  assert.match(source, /const yimuCompanionBridge = createYimuCompanionBridge\(/);
  assert.match(source, /yimuCompanionBridge\.consume\(\{key:coreadDialogBucket\(id\)[\s\S]{0,260}?'companion', \{query:recallQuery\}\)/);
  assert.match(source, /linkAvailable: yimuCompanionBridge\.linkAvailable\(\)/);
  assert.match(source, /closest\('\.sd-reader-yimu-link'\)\) \{ toast\('在忆幕的导览页点「关联伴读」。', 'info'\); return; \}/);
  assert.match(centerView, /\$\{linkAvailable \? '<button type="button" class="sd-reader-mbtn sd-reader-yimu-link">[^']*关联伴读<\/button>' : ''\}/);
  assert.doesNotMatch(bridge, /filterMainline|mainline|companionOwner/);
  assert.match(bridge, /linkAvailable: \(\) => !!consumer/);
  assert.doesNotMatch(yimuRuntime, /mainline/);
  assert.match(yimuRuntime, /context\?\.purpose !== 'companion'/);
  assert.match(yimuView, /button\(linked \? '更新关联' : '关联伴读'/);
  assert.doesNotMatch(yimuView, /选择伴读记忆/);
});
