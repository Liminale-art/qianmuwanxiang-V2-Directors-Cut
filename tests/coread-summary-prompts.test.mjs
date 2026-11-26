import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as reader from '../qianmu-reader.js';
import { extractJson, isPlainObject, uniqueClean } from '../qianmu-storyboard-utils.js';
import { storyboardFunctionSource as section } from './helpers/storyboard-form-fixture.mjs';

const {
  COREAD_PROMPT_KINDS, defaultCoreadSummaryPrompts, normalizeCoreadSummaryPrompts, restoreCoreadSummaryPrompts,
  buildCoreadSummaryPrompt, coreadSummaryTooLong, coreadSummaryRetryNote,
} = reader;

test('three prompt groups ship with the user-approved texts; length and output format live in the protocol only', () => {
  const d = defaultCoreadSummaryPrompts();
  assert.deepEqual(Object.keys(d), ['dialog', 'book', 'stage']);
  for (const kind of COREAD_PROMPT_KINDS) assert.equal(d[kind].length, 1), assert.equal(d[kind][0].builtin, true);
  assert.equal(d.dialog[0].title, '总结要求');
  for (const kind of COREAD_PROMPT_KINDS) assert.doesNotMatch(d[kind][0].text, /200 至 300|【输出要求】|"summary"/, kind);
  assert.match(d.dialog[0].text, /^将读者与书友的共读对话/);
  assert.match(d.dialog[0].text, /不遗漏影响后续共读理解的关键信息。\n4\. 行文禁用破折号/);
  assert.match(d.book[0].text, /未完结的情节与伏笔保持开放，不替原作下结论。/);
  assert.match(d.stage[0].text, /^把按顺序排列的多条伴读记忆整理为一条阶段记忆/);
  assert.match(d.stage[0].text, /6\. 行文禁用破折号（——）。$/);
  d.dialog[0].text = 'changed';
  assert.notEqual(defaultCoreadSummaryPrompts().dialog[0].text, 'changed', 'defaults are copied, never shared');
});

test('normalizing fills missing or empty groups with defaults and orders items', () => {
  const d = defaultCoreadSummaryPrompts();
  assert.deepEqual(normalizeCoreadSummaryPrompts(undefined), d);
  let n = 0;
  const p = normalizeCoreadSummaryPrompts({ dialog: [{ title: 'b', text: 'B', order: 5 }, { id: 'a', title: 'a', text: 'A', order: 1, builtin: true }, 'junk'], book: [] }, () => `id${++n}`);
  assert.deepEqual(p.dialog.map(it => [it.id, it.order, it.builtin]), [['a', 0, true], ['id1', 1, false]]);
  assert.deepEqual(p.book, d.book);
  assert.deepEqual(p.stage, d.stage);
});

test('restore puts the built-in texts back and keeps custom items after them', () => {
  const p = normalizeCoreadSummaryPrompts({
    dialog: [{ id: 'sum-format', builtin: true, order: 0, title: '改过', text: '改过' }, { id: 'c', order: 1, title: '自定义', text: 'x' }],
    stage: [{ id: 'stage-rule', builtin: true, order: 0, title: 't', text: 'y' }],
  });
  const r = restoreCoreadSummaryPrompts(p);
  const d = defaultCoreadSummaryPrompts();
  assert.deepEqual(r.dialog.map(it => [it.id, it.text]), [['sum-format', d.dialog[0].text], ['c', 'x']]);
  assert.equal(r.stage[0].text, d.stage[0].text);
});

test('the protocol adds the opening line, date rule and output format with the length limit', () => {
  const items = [{ id: '2', order: 1, title: '二', text: '第二条' }, { id: '1', order: 0, title: '一', text: '第一条' }, { id: '3', order: 2, title: '空', text: '  ' }];
  const dialog = buildCoreadSummaryPrompt('dialog', { items, user: '我', char: '书友甲', title: '某书', progress: '读至第 3 章 · 40%', chars: 300 });
  assert.match(dialog, /^你是伴读记忆整理助手。下面是「我」伴读《某书》（读至第 3 章 · 40%）时与书友「书友甲」讨论这本书的一段对话。/);
  assert.match(dialog, /【一】\n第一条\n\n【二】\n第二条\n\n/, 'each item is its own titled block, no outer numbering');
  assert.doesNotMatch(dialog, /【空】|【整理要求】/, 'blank items are left out');
  assert.match(dialog, /"summary": "不超过 300 字的第三人称记忆正文"/);
  assert.doesNotMatch(dialog, /站在|主线剧情|发生于/, 'dropped sentences; no date rule unless asked');
  assert.match(buildCoreadSummaryPrompt('dialog', { items, date: '2026年11月26日', progress: '读至 40%' }), /这段对话发生于2026年11月26日，读至 40%；请在总结开头自然带出年月日与读至进度。/);
  const book = buildCoreadSummaryPrompt('book', { items, title: '某书', part: 2, total: 5, date: '2026年11月26日' });
  assert.match(book, /下面是《某书》中已读过的一段正文原文（第 2／5 段）。请把它整理成第三人称客观的情节记忆。/);
  assert.match(book, /这段阅读发生于2026年11月26日；/);
  assert.doesNotMatch(buildCoreadSummaryPrompt('book', { items, total: 1 }), /第 1／1 段/);
  const stage = buildCoreadSummaryPrompt('stage', { items, user: '我', title: '某书', count: 100, source: 'book', date: 'x' });
  assert.match(stage, /按顺序排列的 100 条书中内容记忆。请把它们整理成一条阶段记忆。/);
  assert.match(stage, /不超过 800 字/, 'stage default limit');
  assert.doesNotMatch(stage, /发生于/, 'a stage spans many days: no date rule');
  assert.match(buildCoreadSummaryPrompt('stage', { count: 3 }), /3 条共读交流记忆/);
  assert.throws(() => buildCoreadSummaryPrompt('other', {}));
});

test('over the limit means more than 1.5 times the limit', () => {
  assert.equal(coreadSummaryTooLong('x'.repeat(450), 300), false);
  assert.equal(coreadSummaryTooLong('x'.repeat(451), 300), true);
  assert.match(coreadSummaryRetryNote('long', 300), /压到 300 字以内/);
  assert.match(coreadSummaryRetryNote('format', 300), /无法解析为 JSON/);
});

// 真实的切片总结函数（index.js 里的源码）：超长先重问压短，问完还超就整批失败、不截断也不保底落地。
function distillFixture(replies) {
  const calls = [], toasts = [];
  const c = vm.createContext({
    reader, extractJson, isPlainObject, uniqueClean, console, MODULE_NAME: 'fixture', DOMException, COREAD_DISTILL_RETRY: 2,
    toast: (message, level) => toasts.push([message, level]),
    callCoreadModel: async (system, user) => { calls.push({ system, user }); const next = replies.shift(); if (next instanceof Error) throw next; return next; },
  });
  vm.runInContext(['coreadIsTransientError', 'coreadTranscriptLine', 'coreadSummarySystemPrompt', 'coreadProgressHint', 'coreadDateHint',
    'coreadDistillSegment', 'coreadTooLongReason', 'coreadBuildSliceFromParsed', 'coreadSalvageSummary', 'coreadNormalizeSynonyms', 'coreadDistillText'].map(section).join('\n'), c);
  return { c, calls, toasts };
}
const memory = { sliceChars: 10, summaryPrompts: defaultCoreadSummaryPrompts(), readDateInSummary: false };
const reply = summary => JSON.stringify({ summary, keywords: ['k'], synonyms: {} });
const msgs = [{ role: 'user', text: '你好' }, { role: 'friend', text: '在读' }];

test('a dialog summary over the limit is asked again to shorten, and kept once it fits', async () => {
  const { c, calls } = distillFixture([reply('x'.repeat(16)), reply('短一些')]);
  const res = await c.coreadDistillSegment(msgs, memory, { title: '某书', progress: 40 }, { user: '我', char: '书友' });
  assert.equal(res.summary, '短一些');
  assert.equal(calls.length, 2);
  assert.match(calls[0].system, /不超过 10 字/);
  assert.match(calls[0].system, /【总结要求】\n将读者与书友/);
  assert.doesNotMatch(calls[0].user, /【重要】/);
  assert.match(calls[1].user, /^【对话】\n我：你好\n书友：在读\n\n【重要】上一次的 summary 超出字数上限。请压到 10 字以内/);
});

test('a dialog summary still over the limit after the retries fails the batch without cutting it', async () => {
  const { c, calls } = distillFixture([reply('x'.repeat(16)), reply('y'.repeat(16)), reply('z'.repeat(16))]);
  await assert.rejects(c.coreadDistillSegment(msgs, memory, { title: '某书' }, { user: '我', char: '书友' }), /总结超出字数上限（16 字，上限 10 字），未保存/);
  assert.equal(calls.length, 3);
  // 解析不出 JSON、只能抢救出一段长文时同样不收。
  const salvage = distillFixture(['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)]);
  await assert.rejects(salvage.c.coreadDistillSegment(msgs, memory, { title: '某书' }, { user: '我', char: '书友' }), /超出字数上限/);
});

test('book summaries use the same limit and retry note', async () => {
  const { c, calls } = distillFixture([reply('x'.repeat(16)), reply('正好')]);
  const res = await c.coreadDistillText('正文一段', 'SYSTEM', memory);
  assert.equal(res.summary, '正好');
  assert.equal(calls[0].system, 'SYSTEM');
  assert.match(calls[1].user, /^【待整理内容】\n正文一段\n\n【重要】上一次的 summary 超出字数上限。请压到 10 字以内/);
  const stage = distillFixture([reply('x'.repeat(16)), reply('y'.repeat(16)), reply('z'.repeat(16))]);
  await assert.rejects(stage.c.coreadDistillText('材料', 'S', memory, { chars: 10, label: '【记忆】' }), /上限 10 字/);
  assert.match(stage.calls[0].user, /^【记忆】\n材料$/);
});
