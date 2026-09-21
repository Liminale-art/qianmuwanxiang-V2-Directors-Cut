import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as board from '../qianmu-storyboard.js';
import {repairStoryboardContract, storyboardContractFailure} from '../qianmu-storyboard-contract.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
function section(name) {
  const found = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(found, name);
  const tail = source.slice(found.index), next = tail.slice(1).search(/^(?:async )?function /m);
  return next < 0 ? tail : tail.slice(0, next + 1);
}
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
async function tick() { for (let n = 0; n < 40; n++) await Promise.resolve(); }
function environment() {
  const state = board.createStoryboardDefaults(); state.enabled = true; state.initialized = true;
  Object.assign(state.automation, { autoGenerate: true }); state.promptCompiler.enabled = true;
  const chat = [{ mes: 'first garden', send_date: '2026-09-06T01:00:00Z', swipe_id: 0 }];
  let chatKey = 'chat-a', seq = 0; const timers = new Map(), calls = [], notices = [], errors = [];
  const context = vm.createContext({
    ...board, MODULE_NAME: 'test', STORYBOARD_QUEUE_LIMIT: 8,storyboardContinuationRuntime:null,storyboardStreamRuntime:null,
    storyboardAutomaticPending: new Map(), storyboardAutomaticCurrent: null, storyboardAutomaticTimer: null, storyboardAutomaticEpoch: 0, storyboardCompilerBusy: false,
    storyboardState: () => state, getChatKey: () => chatKey, ctx: () => ({ chat }), storyboardCurrentAssistantFloor: () => chat.length - 1,
    storyboardPlanCompilerSignature: () => 'compiler', storyboardDeletePlanArchives: async () => {}, uid: () => `id-${++seq}`,
    saveSettings: () => {}, storyboardScheduleInlineRender: () => {}, toast: message => notices.push(message), console: { warn: (...args) => errors.push(args) },
    storyboardReleasePlanArchive: async plan => { delete plan.archiveRef; },
    storyboardFinishStreamCapture: async () => null,
    storyboardCompilePrompt: async (_root, { plan }) => { calls.push(['compile', Number(state.floor)]); plan.status = 'prompt_ready'; return true; },
    storyboardGenerate: async (_root, { plan, automatic }) => { calls.push(['generate', plan.floor, automatic]); plan.status = 'queued'; return true; },
    setTimeout: (fn, ms) => { assert.equal(ms, 0, 'no busy-poll interval'); const id = ++seq; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(['storyboardPlanForMessage', 'storyboardEnsurePlan', 'storyboardResetAutomaticCapture', 'storyboardAutomaticTicketFloor', 'storyboardScheduleAutomaticCapture', 'storyboardDrainAutomaticCapture', 'storyboardHandleAutomaticCapture', 'storyboardPerformAutomaticCapture'].map(section).join('\n'), context);
  async function flush() {
    for (let n = 0; timers.size && n < 30; n++) { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); await tick(); }
    assert.equal(timers.size, 0, 'queue does not spin');
  }
  return { state, chat, calls, notices, errors, timers, context, flush, setChat: value => { chatKey = value; } };
}

test('duplicate notifications queue once, preserve the received floor and yield the host event', async () => {
  const e = environment();
  assert.equal(await e.context.storyboardHandleAutomaticCapture('0'), true);
  assert.equal(e.calls.length, 0, 'notification itself does no LLM work');
  assert.equal(await e.context.storyboardHandleAutomaticCapture(0), false);
  e.chat.push({ mes: 'a newer scene', send_date: '2026-09-06T01:01:00Z' });
  await e.flush();
  assert.deepEqual(e.calls, [['compile', 0], ['generate', 0, true]]);
  assert.equal(await e.context.storyboardHandleAutomaticCapture(0), false, 'queued plan is not re-extracted');
});

test('a migrated old extraction-off account extracts the new floor once without auto-generating images',async()=>{
  const e=environment();e.state.automation=board.normalizeStoryboardAutomation({autoCapture:false,autoGenerate:true});
  assert.equal(await e.context.storyboardHandleAutomaticCapture(0),true);await e.flush();
  assert.deepEqual(e.calls,[['compile',0]]);assert.equal(await e.context.storyboardHandleAutomaticCapture(0),false);
});

test('actual automatic entry waits for a continuation save barrier before reserving any task and does not expand an extraction-only authorization',async()=>{
  const e=environment(),gate=deferred(),seen=[];e.state.automation.autoGenerate=false;
  e.context.storyboardContinuationRuntime={beforeAutomatic:(floor,message,type)=>{seen.push([floor,message===e.chat[0],type]);return gate.promise;}};
  const pending=e.context.storyboardHandleAutomaticCapture(0,'continue');assert.equal(e.context.storyboardAutomaticPending.size,0);assert.equal(e.calls.length,0);
  e.state.automation.autoGenerate=true;gate.resolve(true);assert.equal(await pending,true);await e.flush();
  assert.deepEqual(seen,[[0,true,'continue']]);assert.deepEqual(e.calls,[['compile',0]]);
});

test('a failed continuation barrier stops the actual automatic path without an ordinary fallback',async()=>{
  const e=environment();e.context.storyboardContinuationRuntime={beforeAutomatic:()=>Promise.resolve(false)};
  assert.equal(await e.context.storyboardHandleAutomaticCapture(0,'continue'),false);await e.flush();assert.equal(e.state.shotPlans.length,0);assert.deepEqual(e.calls,[]);
});

test('actual final notification waits for early jobs before creating any automatic ticket',async()=>{
  const e=environment(),gate=deferred();e.context.storyboardStreamRuntime={beforeAutomatic:()=>gate.promise,wake(){}};
  const pending=e.context.storyboardHandleAutomaticCapture(0);assert.equal(e.context.storyboardAutomaticPending.size,0);assert.equal(e.calls.length,0);
  gate.resolve(true);assert.equal(await pending,true);await e.flush();assert.deepEqual(e.calls,[['compile',0],['generate',0,true]]);
});

test('a failed or taken-over early stream cannot fall through to ordinary fresh extraction',async()=>{
  for(const value of [false,Promise.resolve(false)]){
    const e=environment();e.context.storyboardStreamRuntime={beforeAutomatic:()=>value};
    assert.equal(await e.context.storyboardHandleAutomaticCapture(0),false);assert.equal(e.state.shotPlans.length,0);assert.deepEqual(e.calls,[]);
  }
});

test('switching chats while awaiting early stream completion cannot create a late automatic ticket',async()=>{
  const e=environment(),gate=deferred();e.context.storyboardStreamRuntime={beforeAutomatic:()=>gate.promise,reset(){}};
  const pending=e.context.storyboardHandleAutomaticCapture(0);e.context.storyboardResetAutomaticCapture();gate.resolve(true);
  assert.equal(await pending,false);assert.equal(e.context.storyboardAutomaticPending.size,0);assert.deepEqual(e.calls,[]);
});

test('source changes or manual takeover while awaiting a continuation save cannot reserve an automatic plan',async()=>{
  for(const change of [e=>e.context.storyboardAutomaticEpoch++,e=>e.chat[0]={...e.chat[0]},e=>e.context.storyboardEnsurePlan(e.state,0,e.chat[0],{origin:'manual'})]){
    const e=environment(),gate=deferred();e.context.storyboardContinuationRuntime={beforeAutomatic:()=>gate.promise};
    const pending=e.context.storyboardHandleAutomaticCapture(0,'continue');change(e);gate.resolve(true);assert.equal(await pending,false);await e.flush();assert.deepEqual(e.calls,[]);
  }
});

test('manual ownership acquired while checking stream history is rechecked before reserving an ordinary automatic plan',async()=>{
  const e=environment();e.context.storyboardFinishStreamCapture=async()=>{
    e.context.storyboardEnsurePlan(e.state,0,e.chat[0],{origin:'manual'});return null;
  };
  assert.equal(await e.context.storyboardHandleAutomaticCapture(0),true);await e.flush();
  assert.deepEqual(e.calls,[]);assert.equal(e.state.shotPlans[0].origin,'manual');assert.equal(e.state.shotPlans[0].status,'idle');
});

test('busy compiler stores bounded tickets without timers and completion starts one drain', async () => {
  const e = environment(); e.context.storyboardCompilerBusy = true;
  for (let n = 1; n < 12; n++) e.chat.push({ mes: `scene ${n}`, send_date: `scene-time-${n}` });
  for (let n = 0; n < 12; n++) await e.context.storyboardHandleAutomaticCapture(n);
  assert.equal(e.context.storyboardAutomaticPending.size, 8); assert.equal(e.timers.size, 0); assert.equal(e.calls.length, 0);
  assert.equal(e.notices.length, 4);
  e.context.storyboardCompilerBusy = false;
  e.context.storyboardScheduleAutomaticCapture(); e.context.storyboardScheduleAutomaticCapture();
  assert.equal(e.timers.size, 1);
  await e.flush();
  assert.deepEqual(e.calls.filter(call => call[0] === 'compile').map(call => call[1]), [0,1,2,3,4,5,6,7]);
  assert.equal(e.context.storyboardAutomaticPending.size, 0);
});

for (const [name, change] of [
  ['chat change without host reset', e => e.setChat('chat-b')],
  ['source text edit', e => { e.chat[0].mes = 'edited original'; }],
  ['swipe version change', e => { e.chat[0].swipe_id = 1; }],
  ['source deletion', e => { e.chat.splice(0, 1); }],
  ['replacement with a similar message', e => { e.chat[0] = { ...e.chat[0] }; }],
  ['master switch off', e => { e.state.enabled = false; }],
  ['compiler unavailable', e => { e.state.promptCompiler.enabled = false; }],
  ['settings object replaced', e => { e.context.storyboardState = () => ({ ...e.state }); }],
  ['expired pending notification', e => { for (const ticket of e.context.storyboardAutomaticPending.values()) ticket.createdAt -= 6 * 60_000; }],
]) test(`${name} invalidates waiting capture without targeting a different scene`, async () => {
  const e = environment(); await e.context.storyboardHandleAutomaticCapture(0); change(e); await e.flush();
  assert.deepEqual(e.calls, []); assert.equal(e.context.storyboardAutomaticPending.size, 0);
});

test('deleting an earlier floor relocates the exact source object without changing the intended scene', async () => {
  const e = environment(); e.chat.unshift({ is_user: true, mes: 'question' });
  await e.context.storyboardHandleAutomaticCapture(1); e.chat.shift(); await e.flush();
  assert.deepEqual(e.calls, [['compile', 0], ['generate', 0, true]]);
});

test('empty, user, system and absent floors never reserve a task', async () => {
  const e = environment();
  e.chat.splice(0, 1, { mes: '' }, { mes: '  ' }, { mes: 'user', is_user: true }, { mes: 'system', is_system: true });
  for (const index of [-1,0,1,2,3,20]) assert.equal(await e.context.storyboardHandleAutomaticCapture(index), false);
  assert.equal(e.timers.size, 0); assert.equal(e.context.storyboardAutomaticPending.size, 0);
});

test('manual ownership acquired during wait is respected and manual paragraph selections do not leak into a later automatic floor', async () => {
  const e = environment(); await e.context.storyboardHandleAutomaticCapture(0);
  e.context.storyboardEnsurePlan(e.state, 0, e.chat[0], { origin: 'manual' });
  await e.flush(); assert.deepEqual(e.calls, []);
  e.chat.push({ mes: 'new automatic scene', send_date: 'later' });
  e.state.pendingParagraphSelection = { paragraphIds: ['old-manual-paragraph'] };
  await e.context.storyboardHandleAutomaticCapture(1); await e.flush();
  assert.equal(e.state.pendingParagraphSelection, null);
  assert.deepEqual(e.calls, [['compile', 1], ['generate', 1, true]]);
});

test('a reserved plan blocks duplicate notifications during archive I/O', async () => {
  const e = environment(), gate = deferred();
  const plan = e.context.storyboardEnsurePlan(e.state, 0, e.chat[0], { origin: 'automatic' }); plan.archiveRef = 'archive';
  e.context.storyboardReleasePlanArchive = async () => gate.promise;
  await e.context.storyboardHandleAutomaticCapture(0); await e.flush();
  assert.equal(plan.status, 'screening'); assert.equal(e.calls.length, 0);
  assert.equal(await e.context.storyboardHandleAutomaticCapture(0), false);
  gate.resolve(); await tick(); await e.flush();
  assert.deepEqual(e.calls, [['compile', 0], ['generate', 0, true]]);
});

test('archive wait cannot clear the new draft after source changes', async () => {
  const e = environment(), gate = deferred();
  const plan = e.context.storyboardEnsurePlan(e.state, 0, e.chat[0], { origin: 'automatic' }); plan.archiveRef = 'archive';
  e.context.storyboardReleasePlanArchive = async () => gate.promise;
  e.state.prompt = 'manual draft';
  await e.context.storyboardHandleAutomaticCapture(0); await e.flush();
  e.chat[0].mes = 'edited during archive I/O'; gate.resolve(); await tick();
  assert.equal(e.state.prompt, 'manual draft'); assert.equal(plan.status, 'cancelled'); assert.deepEqual(e.calls, []);
});

test('chat-away-and-back epoch invalidates an active preparation and clears all timers', async () => {
  const e = environment(), gate = deferred();
  e.context.storyboardCompilePrompt = async (_root, { plan }) => { plan.status = 'compiling'; await gate.promise; return true; };
  await e.context.storyboardHandleAutomaticCapture(0); await e.flush();
  const plan = e.state.shotPlans[0];
  e.setChat('chat-b'); e.context.storyboardResetAutomaticCapture(); e.setChat('chat-a'); e.context.storyboardResetAutomaticCapture();
  assert.equal(plan.status, 'cancelled'); assert.equal(e.timers.size, 0); assert.equal(e.context.storyboardAutomaticPending.size, 0);
  gate.resolve(); await tick(); assert.deepEqual(e.calls, []); assert.equal(e.context.storyboardAutomaticCurrent, null);
});

test('automatic tickets are processed serially through generation preparation', async () => {
  const e = environment(), gate = deferred();
  e.chat.push({ mes: 'second scene', send_date: 'second-time' });
  const generate = e.context.storyboardGenerate;
  e.context.storyboardGenerate = async (root, options) => { if (options.plan.floor === 0) await gate.promise; return generate(root, options); };
  await e.context.storyboardHandleAutomaticCapture(0); await e.context.storyboardHandleAutomaticCapture(1); await e.flush();
  assert.deepEqual(e.calls, [['compile', 0]], 'second compile cannot overwrite first preparation inputs');
  gate.resolve(); await tick(); await e.flush();
  assert.deepEqual(e.calls, [['compile', 0], ['generate', 0, true], ['compile', 1], ['generate', 1, true]]);
});

test('enabling auto-generation later does not expand a pending extraction-only authorization', async () => {
  const e = environment(); e.state.automation.autoGenerate = false;
  await e.context.storyboardHandleAutomaticCapture(0); e.state.automation.autoGenerate = true; await e.flush();
  assert.deepEqual(e.calls, [['compile', 0]]);
});

test('waiting automatic tasks are discarded on teardown without canceling already queued image work', async () => {
  const e = environment(); await e.context.storyboardHandleAutomaticCapture(0);
  const plan = { origin: 'automatic', status: 'queued' }; e.context.storyboardAutomaticCurrent = { plan };
  e.context.storyboardResetAutomaticCapture(); assert.equal(plan.status, 'queued');
  assert.equal(e.timers.size, 0); assert.equal(e.context.storyboardAutomaticPending.size, 0);
  assert.match(section('cleanupRuntime'), /storyboardResetAutomaticCapture\(\)/);
  assert.match(section('storyboardCompilePrompt'), /finally[\s\S]*storyboardCompilerBusy = false;\s*storyboardScheduleAutomaticCapture\(\)/);
  assert.doesNotMatch(section('storyboardHandleAutomaticCapture'), /setTimeout|900/);
});

test('cold reload cancels only unfinished extraction plans and does not auto-resume paid work', () => {
  const state = board.createStoryboardDefaults(); state.initialized = true;
  state.shotPlans = ['screening', 'compiling', 'prompt_ready', 'success'].map((status, id) => ({ id: String(id), status }));
  const context = vm.createContext({
    ...board, settings: { imagegen: state }, isPlainObject: value => value && typeof value === 'object',
    storyboardNormalizedStates: new WeakSet([state]), storyboardRuntimeReconciled: false, queueMicrotask: fn => fn(), saveSettings: () => {},
  });
  vm.runInContext(section('storyboardState'), context); context.storyboardState();
  assert.deepEqual(state.shotPlans.map(plan => plan.status), ['cancelled', 'cancelled', 'prompt_ready', 'success']);
});

test('abandoned archive I/O cannot hold a new chat hostage or release its active preparation lock', async () => {
  const e = environment(), archive = deferred(), nextCompile = deferred();
  const original = e.context.storyboardEnsurePlan(e.state, 0, e.chat[0], { origin: 'automatic' }); original.archiveRef = 'archive';
  e.context.storyboardReleasePlanArchive = async () => archive.promise;
  await e.context.storyboardHandleAutomaticCapture(0); await e.flush();
  e.setChat('chat-b'); e.context.storyboardResetAutomaticCapture(); e.chat[0] = { mes: 'new chat scene', send_date: 'new-chat-date' };
  e.context.storyboardCompilePrompt = async (_root, { plan }) => { plan.status = 'compiling'; await nextCompile.promise; plan.status = 'prompt_ready'; return true; };
  await e.context.storyboardHandleAutomaticCapture(0); await e.flush();
  const current = e.context.storyboardAutomaticCurrent;
  assert.ok(current); assert.equal(current.chatKey, 'chat-b');
  archive.resolve(); await tick(); assert.equal(e.context.storyboardAutomaticCurrent, current);
  nextCompile.resolve(); await tick(); assert.deepEqual(e.calls, [['generate', 0, true]]);
});

test('preparation rejection and early compiler refusal terminate their plans without spinning', async () => {
  for (const mode of ['archive', 'compiler']) {
    const e = environment();
    if (mode === 'archive') {
      const plan = e.context.storyboardEnsurePlan(e.state, 0, e.chat[0], { origin: 'automatic' }); plan.archiveRef = 'archive';
      e.context.storyboardReleasePlanArchive = async () => { throw new Error('mock archive failure'); };
    } else e.context.storyboardCompilePrompt = async () => false;
    await e.context.storyboardHandleAutomaticCapture(0); await e.flush();
    assert.equal(e.state.shotPlans[0].status, 'failed'); assert.equal(e.context.storyboardAutomaticCurrent, null);
    assert.equal(await e.context.storyboardHandleAutomaticCapture(0), false);
    assert.deepEqual(e.calls, []);
  }
});

test('automatic extraction failure retains the accepted draft and restores the prior workbench target',async()=>{
  const e=environment();Object.assign(e.state,{target:'gallery',floor:'',prompt:'accepted draft',negative:'accepted negative'});
  e.state.promptDraft.compiled='accepted draft';const draft=structuredClone(e.state.promptDraft);
  e.context.storyboardCompilePrompt=async()=>false;
  await e.context.storyboardHandleAutomaticCapture(0);await e.flush();
  assert.equal(e.state.target,'gallery');assert.equal(e.state.floor,'');assert.equal(e.state.prompt,'accepted draft');assert.equal(e.state.negative,'accepted negative');assert.deepEqual(e.state.promptDraft,draft);assert.deepEqual(e.calls,[]);
});

test('an exhausted format-repair batch stays terminal on duplicate host events while the next floor still runs', async () => {
  const e = environment(), requests = [];
  e.chat.push({mes: 'second independent scene', send_date: 'second-floor'});
  e.context.storyboardCompilePrompt = async (_root, {plan}) => {
    const floor = plan.floor;
    requests.push(['extract', floor]);
    plan.status = 'compiling';
    if (floor === 0) {
      const result = await repairStoryboardContract({raw: '{ invalid', request: async () => {
        requests.push(['repair', floor]); return '{ invalid';
      }});
      assert.equal(result.repairCalls, 3);
      plan.status = 'failed';
      plan.error = storyboardContractFailure(result).message;
      return false;
    }
    plan.status = 'prompt_ready'; return true;
  };
  await e.context.storyboardHandleAutomaticCapture(0);
  await e.context.storyboardHandleAutomaticCapture(1);
  await e.flush();
  assert.deepEqual(requests, [['extract', 0], ['repair', 0], ['repair', 0], ['repair', 0], ['extract', 1]]);
  assert.deepEqual(e.calls, [['generate', 1, true]], 'failed extraction must never submit a picture');
  assert.equal(e.state.shotPlans.find(plan => plan.floor === 0).status, 'failed');
  assert.match(e.state.shotPlans.find(plan => plan.floor === 0).error, /已修复3次/);
  for (let n = 0; n < 5; n++) assert.equal(await e.context.storyboardHandleAutomaticCapture(0), false);
  e.context.storyboardScheduleAutomaticCapture(); await e.flush();
  assert.equal(requests.length, 5, 'repeated receipts and a compiler wakeup cannot buy another repair budget');
  assert.equal(e.context.storyboardAutomaticPending.size, 0);
  assert.equal(e.context.storyboardAutomaticCurrent, null);
  assert.equal(e.timers.size, 0);
});
