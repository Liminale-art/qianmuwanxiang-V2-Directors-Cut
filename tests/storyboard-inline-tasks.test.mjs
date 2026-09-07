import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as core from '../qianmu-storyboard.js';
import { htmlEscape, hashText } from '../qianmu-storyboard-utils.js';
import { storyboardFunctionSource as section } from './helpers/storyboard-form-fixture.mjs';
const message = () => ({ mes: '灯亮起。他站在窗前。', name: 'Alice', send_date: '2026-09-07T12:00:00Z', swipe_id: 0 });
const inlineOrder = (shotIndex = 0, requestIndex = 1) => ({ version: 1, batchId: 'batch-a', batchStartedAt: 100, shotIndex, requestIndex });
const copy = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const chat = [message()], chatKey = 'chat-a';
  const ref = core.createStoryboardMessageReference({ message: chat[0], chatKey, floor: 0, now: 1 });
  const task = (id = 'one', extra = {}) => core.createStoryboardTaskState({ id, logId: `log-${id}`, planId: 'plan-a', shotId: id,
    chatKey, floor: 0, messageRef: ref, messageHash: hashText(chat[0].mes), swipeId: 0, uiVisible: true, inlineOrder: inlineOrder(),
    paragraphAnchor: core.createStoryboardParagraphAnchor({ paragraphIndex: 0, paragraphText: chat[0].mes, messageText: chat[0].mes }),
    now: 100, ...extra });
  const options = { chatKey, chat, logs: [], records: [], activeIds: new Set(), waitingIds: new Set() };
  return { chat, chatKey, ref, task, options, build: tasks => core.buildStoryboardInlineTasks(tasks, options) };
}

test('inline task metadata roundtrips independently of full jobs and source prompts', () => {
  const f = fixture(), task = f.task('one', { inlineOrder: inlineOrder(2, 3), attempt: 4 });
  const normalized = core.normalizeStoryboardState({ taskStates: [task] }).taskStates[0];
  assert.deepEqual(normalized.inlineOrder, inlineOrder(2, 3)); assert.equal(normalized.attempt, 4);
  assert.equal(normalized.messageHash, hashText(f.chat[0].mes)); assert.equal(normalized.uiVisible, true);
  assert.equal(core.normalizeStoryboardTaskState({}).inlineOrder, null);
});

test('live task stage is accurate; absent live handles never masquerade as generating after reload', () => {
  const f = fixture(); f.options.waitingIds.add('one');
  assert.equal(f.build([f.task()])[0].label, '等待生图'); assert.equal(f.build([f.task()])[0].action, 'cancel-task');
  f.options.waitingIds.clear(); f.options.activeIds.add('one');
  for (const [stage, label] of [['provider', '正在生成画面'], ['persistence', '正在保存画面'], ['attachment', '正在回填画面']]) {
    assert.equal(f.build([f.task('one', { status: 'generating', stage })])[0].label, label);
  }
  f.options.activeIds.clear();
  for (const status of ['queued', 'generating']) {
    const entry = f.build([f.task('one', { status })])[0]; assert.equal(entry.status, 'unconfirmed'); assert.equal(entry.action, '');
  }
});

test('only a known failed, not-submitted/rejected request offers retry; accepted or uncertain work goes to logs', () => {
  const f = fixture(), failed = f.task('one', { status: 'failed', error: 'HTTP 429；long diagnostic' });
  for (const submissionState of ['not_submitted', 'rejected', 'unknown', 'accepted', '']) {
    f.options.logs = [{ id: 'log-one', status: 'failed', submissionState }];
    const entry = f.build([failed])[0];
    assert.equal(entry.action, ['not_submitted', 'rejected'].includes(submissionState) ? 'retry-task' : '');
    if (entry.status === 'failed') assert.equal(entry.detail, 'HTTP 429');
  }
  f.options.logs = []; assert.equal(f.build([failed])[0].status, 'unconfirmed');
});

test('new retry supersedes old failure by request time, not late status timestamps; success/cancel dismisses old marker', () => {
  const f = fixture(), old = f.task('old', { status: 'failed', requestedAt: 100, updatedAt: 5000 });
  const retry = f.task('retry', { requestedAt: 200, attempt: 2 }); f.options.waitingIds.add('retry');
  assert.deepEqual(f.build([retry, old]).map(row => row.taskId), ['retry']);
  for (const status of ['completed', 'cancelled']) assert.deepEqual(f.build([old, { ...retry, status }]), []);
  assert.deepEqual(f.build([{ ...old, requestedAt: 200 }, retry]).map(row => row.taskId), ['retry']);
});

test('per-request slots keep failed variants separate and one failed shot survives a partially completed plan', () => {
  const f = fixture(), failed = f.task('failed', { status: 'failed', inlineOrder: inlineOrder(0, 1) });
  f.options.logs = [{ id: 'log-failed', status: 'failed', submissionState: 'rejected' }];
  const success = f.task('ok', { status: 'completed', inlineOrder: inlineOrder(0, 2) });
  assert.deepEqual(f.build([success, failed]).map(row => row.taskId), ['failed']);
  const picture = { id: 'image', taskId: 'ok', chatKey: f.chatKey, floor: 0, swipeId: 0, messageHash: failed.messageHash,
    inlineOrder: inlineOrder(0, 2), imageIndex: 0 };
  assert.deepEqual(core.sortStoryboardInlineRecords([picture, ...f.build([success, failed])]).map(row => row.id), ['inline-task:failed', 'image']);
});

test('unrelated chats, disabled visibility, missing order/reference, changed prose and inactive swipes do not show slots', () => {
  const f = fixture(), task = f.task(); f.options.waitingIds.add('one');
  for (const extra of [{ uiVisible: false }, { chatKey: 'other' }, { inlineOrder: null }, { messageRef: null }]) assert.deepEqual(f.build([{ ...task, ...extra }]), []);
  f.chat[0].mes += '改写'; assert.deepEqual(f.build([task]), []);
  f.chat[0] = message(); f.chat[0].swipe_id = 1; assert.deepEqual(f.build([task]), []);
  f.chat.length = 0; assert.deepEqual(f.build([task]), []);
});

test('stable message relocation is honored without mutating task floor or guessing missing prose', () => {
  const f = fixture(), task = f.task(); f.options.waitingIds.add('one');
  f.chat.unshift({ mes: 'other', is_user: true, send_date: '2026-09-07T11:00:00Z' });
  assert.equal(f.build([task])[0].floor, 1); assert.equal(task.floor, 0);
});

test('image arriving before task completion removes its waiting marker but a partial failure remains visible', () => {
  const f = fixture(), task = f.task(); f.options.waitingIds.add('one'); f.options.records = [{ taskId: 'one' }];
  assert.deepEqual(f.build([task]), []);
  assert.equal(f.build([{ ...task, status: 'failed' }]).length, 1);
});

test('render planning never reads snapshots, workflow bodies, image URLs or current provider settings', () => {
  const f = fixture(), task = f.task(), log = { id: 'log-one', status: 'failed', submissionState: 'rejected' };
  for (const object of [task, log]) for (const key of ['snapshot', 'workflow', 'payload', 'url']) Object.defineProperty(object, key, { get() { throw Error('heavy read'); } });
  f.options.logs = [log]; f.options.waitingIds.add('one'); assert.equal(f.build([task]).length, 1);
});

test('actual task sync only enables inline jobs; gallery and disabled inline output stay silent', () => {
  const f = fixture(), state = core.createStoryboardDefaults();
  const context = vm.createContext({ ...core, storyboardState: () => state }); vm.runInContext(section('storyboardSyncTaskState'), context);
  for (const [target, inlineByDefault, visible] of [['floor', true, true], ['gallery', true, false], ['floor', false, false]]) {
    const job = { ...f.task(), planShotId: 'shot', target, inlineByDefault };
    state.taskStates = [];
    const result = context.storyboardSyncTaskState(job, 'queued'); assert.equal(result.uiVisible, visible);
    assert.deepEqual(copy(result.inlineOrder), inlineOrder());
  }
});

test('task markup escapes diagnosis and identities and uses task controls, not image edit controls', () => {
  const f = fixture(); f.options.logs = [{ id: 'log-one', status: 'failed', submissionState: 'rejected' }];
  const entry = f.build([f.task('one', { status: 'failed', error: '<img src=x onerror=alert(1)>' })])[0];
  const context = vm.createContext({ htmlEscape }); vm.runInContext(section('storyboardInlineTaskMarkup'), context);
  const html = context.storyboardInlineTaskMarkup(entry);
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img|data-storyboard-record=/);
  assert.match(html, /data-storyboard-chat-action="retry-task"/); assert.match(html, /data-storyboard-inline-slot=/);
});

test('task text controls and hidden reels override legacy inline icon-only sizing', () => {
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  assert.match(css, /#chat \.mes \.sd-storyboard-inline \.sd-storyboard-inline-task-actions button\s*\{\s*width: auto; height: auto; min-height: 32px;/);
  assert.match(css, /\.sd-storyboard-inline > :is\(\.sd-storyboard-inline-title,\.sd-storyboard-inline-reel\)\[hidden\] \{ display: none; \}/);
});

function actionFixture() {
  const state = core.createStoryboardDefaults(), calls = [], entry = { taskId: 'task', logId: 'log', action: 'retry-task' };
  state.enabled = true; state.logs = [{ id: 'log', status: 'failed', snapshot: { source: 'novel', target: 'floor', floor: 0, chatKey: 'chat-a',
    profile: { model: 'nai-diffusion-5-full' }, payload: { prompt: 'original' }, connection: { baseUrl: 'https://example.test', credentialId: 'ref-only' }, inlineOrder: inlineOrder() } }];
  const wrapper = { dataset: { storyboardChatKey: 'chat-a' } };
  const button = { dataset: { storyboardChatAction: 'retry-task' }, isConnected: true,
    closest: selector => selector === '.sd-storyboard-inline' ? wrapper : { dataset: { storyboardTask: 'task' } } };
  const context = vm.createContext({ ...core, clone: structuredClone, uid: () => 'new-job',
    storyboardState: () => state, getChatKey: () => 'chat-a', storyboardAdmissionEpoch: 0,
    storyboardInlineTaskActions: new Set(), storyboardCurrentInlineTasks: () => [entry], storyboardGalleryRecords: () => [],
    toast: (...args) => { calls.push(['notice', ...args]); return false; },
    storyboardQueueJob: async (job, valid) => { if (!valid()) return false; calls.push(['queue', job]); return true; },
    storyboardRemoveQueuedLog: log => calls.push(['remove', log.id]),
    document: { getElementById: () => null, querySelectorAll: () => [] }, MODAL_ID: 'modal',
    storyboardRememberPageScroll() {}, saveSettings() {}, openModal: tab => calls.push(['open', tab]),
  });
  vm.runInContext([section('storyboardOnInlineTaskAction'), section('storyboardRetryLog'), section('storyboardJobFromLog')].join('\n'), context);
  return { state, calls, entry, wrapper, button, context };
}

test('inline retry uses the exact original snapshot and adds one request, not a new extraction/whole plan', async () => {
  const f = actionFixture(); assert.equal(await f.context.storyboardOnInlineTaskAction(f.button), true);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 'queue');
  const job = f.calls[0][1]; assert.equal(job.payload.prompt, 'original'); assert.deepEqual(copy(job.inlineOrder), inlineOrder());
  assert.equal(f.button.disabled, false);
});

test('double clicks are suppressed and late chat, epoch or task changes prevent retry submission', async () => {
  for (const change of [f => { f.entry.action = ''; }, f => { f.context.storyboardAdmissionEpoch++; }, f => { f.context.getChatKey = () => 'chat-b'; }]) {
    const f = actionFixture(); let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    f.context.storyboardQueueJob = async (_job, valid) => { started(); await new Promise(resolve => { release = resolve; }); return valid(); };
    const first = f.context.storyboardOnInlineTaskAction(f.button); await ready;
    assert.equal(await f.context.storyboardOnInlineTaskAction(f.button), false);
    change(f); release(); assert.equal(await first, false); assert.equal(f.context.storyboardInlineTaskActions.size, 0);
  }
});

test('only waiting task can be removed; unknown results and missing frozen recipes never create a retry', async () => {
  const f = actionFixture(); f.entry.action = 'cancel-task'; f.button.dataset.storyboardChatAction = 'cancel-task';
  assert.equal(await f.context.storyboardOnInlineTaskAction(f.button), true); assert.deepEqual(f.calls, [['remove', 'log']]);
  f.calls.length = 0; f.entry.action = ''; f.button.dataset.storyboardChatAction = 'retry-task';
  assert.equal(await f.context.storyboardOnInlineTaskAction(f.button), false); assert.equal(f.calls.length, 0);
  f.entry.action = 'retry-task'; delete f.state.logs[0].snapshot;
  assert.equal(await f.context.storyboardOnInlineTaskAction(f.button), false); assert.equal(f.calls.some(row => row[0] === 'queue'), false);
});

test('log navigation works without a surviving log and never generates or loads current workbench settings', async () => {
  const f = actionFixture(); f.button.dataset.storyboardChatAction = 'task-log'; f.state.logs = [];
  assert.equal(await f.context.storyboardOnInlineTaskAction(f.button), true); assert.equal(f.state.view, 'logs');
  assert.deepEqual(f.calls[0], ['open', 'imagegen']); assert.equal(f.calls.some(row => row[0] === 'queue'), false);
});
