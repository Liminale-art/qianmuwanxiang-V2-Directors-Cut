import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectorAutoRefresh } from '../qianmu-director-auto-refresh.js';
import { createDirectorHostState } from '../qianmu-director-host-state.js';

// Only the clock and native host boundary are synthetic. Both production
// coordinators run unchanged; there are no network, storage or model requests.
function fixture({ loadHost } = {}) {
  let time = 0, nextTimer = 0, sourceEpoch = 0, busy = false, runs = 0;
  let settings = { enabled: true, autoRefresh: true, autoRefreshEvery: 1 };
  let store = { lastPlanIdx: 0 };
  let runImpl = async () => { store.lastPlanIdx = context.chat.length - 1; };
  const timers = new Map(), sources = [], notices = [];
  const context = { chat: [
    { name: 'Synthetic', mes: 'Previous reply', is_user: false, is_system: false },
    { name: 'Synthetic', mes: 'New reply', is_user: false, is_system: false },
  ] };
  let generating = false;
  const nativeHost = { isGenerating: () => generating, isChatSaving: false, streamingProcessor: null,
    closeCurrentChat: async () => true };
  const host = createDirectorHostState({ loadHost: () => loadHost ? loadHost(nativeHost) : Promise.resolve(nativeHost) });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const f = {
    context, nativeHost, host, sources, notices,
    get settings() { return settings; }, set settings(value) { settings = value; },
    get store() { return store; }, set store(value) { store = value; },
    get runs() { return runs; }, get timerCount() { return timers.size; }, get time() { return time; },
    set busy(value) { busy = value; }, set generating(value) { generating = value; },
    set run(value) { runImpl = value; },
    changeSource() { sourceEpoch++; },
    async advance(ms) {
      const end = time + ms;
      let steps = 0;
      while (true) {
        const next = [...timers].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        assert.ok(++steps < 10_000, 'clock must not encounter an unbounded immediate timer loop');
        time = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
      }
      time = end; await flush();
    },
  };
  f.auto = createDirectorAutoRefresh({
    getContext: () => context, getStore: () => store, getSettings: () => settings,
    captureSource: () => {
      const epoch = sourceEpoch, chat = context.chat;
      const source = { closed: 0, isCurrent: () => epoch === sourceEpoch && context.chat === chat,
        close() { this.closed++; } };
      sources.push(source); return source;
    },
    host, isBusy: () => busy, run: async () => { runs++; await runImpl(); },
    notify: (...args) => notices.push(args), now: () => time,
    setTimer: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimer: id => timers.delete(id),
  });
  return f;
}

test('a stopped residual from an older stream does not discard a later non-streaming reply still being saved',async()=>{
  const f=fixture();f.generating=true;f.nativeHost.streamingProcessor={isFinished:false,isStopped:true};
  f.auto.received(1,'normal');await f.advance(250);assert.equal(f.runs,0);assert.equal(f.timerCount,1);
  f.nativeHost.streamingProcessor=null;f.generating=false;await f.advance(750);
  assert.equal(f.runs,1);assert.equal(f.timerCount,0);
});

test('host generation, finished stream tail and native save all precede two idle observations and one automatic run', async () => {
  const f = fixture(); f.generating = true;
  const processor = { isStopped: false, isFinished: false }; f.nativeHost.streamingProcessor = processor;
  f.auto.received(1, 'normal'); await f.advance(250); assert.equal(f.runs, 0);
  f.generating = false; processor.isFinished = true;
  await f.advance(500); assert.equal(f.runs, 0, 'finished stream still has a native finalizer tail');
  f.nativeHost.streamingProcessor = null; f.nativeHost.isChatSaving = true;
  await f.advance(500); assert.equal(f.runs, 0, 'native save is not yet finished');
  f.nativeHost.isChatSaving = false;
  await f.advance(500); assert.equal(f.runs, 0, 'one idle observation must not launch');
  await f.advance(249); assert.equal(f.runs, 0);
  await f.advance(1); assert.equal(f.runs, 1); assert.equal(f.store.lastPlanIdx, 1);
  assert.equal(f.timerCount, 0); assert.equal(f.sources[0].closed, 1);
  await f.advance(5000); assert.equal(f.runs, 1); f.auto.dispose();
});

test('body changes between idle observations restart stabilization without adopting a half-finished tail', async () => {
  const f = fixture(); f.auto.received(1); await f.advance(250);
  f.context.chat[1].mes = 'A late finalizer update';
  await f.advance(250); assert.equal(f.runs, 0);
  await f.advance(250); assert.equal(f.runs, 1); f.auto.dispose();
});

test('native save starting after the first idle observation resets stabilization', async () => {
  const f = fixture(); f.auto.received(1); await f.advance(250);
  f.nativeHost.isChatSaving = true;
  await f.advance(250); assert.equal(f.runs, 0);
  f.nativeHost.isChatSaving = false;
  await f.advance(500); assert.equal(f.runs, 0);
  await f.advance(250); assert.equal(f.runs, 1); f.auto.dispose();
});

for (const outcome of ['returned-failure', 'thrown-failure']) {
  test(`${outcome}: attempted floor is not marked adopted, repeated events do not retry it, and a new floor can run`, async () => {
    const f = fixture();
    f.run = async () => { if (outcome === 'thrown-failure') throw Error('synthetic failure'); };
    f.auto.received(1); await f.advance(500);
    assert.equal(f.runs, 1); assert.equal(f.store.lastPlanIdx, 0); assert.equal(f.timerCount, 0);
    f.auto.received(1); f.auto.received(1); await f.advance(1000);
    assert.equal(f.runs, 1); assert.equal(f.store.lastPlanIdx, 0);
    f.context.chat.push({ name: 'Synthetic', mes: 'Next reply' });
    f.auto.received(2); await f.advance(500);
    assert.equal(f.runs, 2); assert.equal(f.store.lastPlanIdx, 0); f.auto.dispose();
  });
}

test('repeated received events coalesce into one pending source and one request', async () => {
  const f = fixture();
  f.auto.received(1); await f.advance(100); f.auto.received(1); f.auto.received(1);
  assert.equal(f.timerCount, 1); assert.deepEqual(f.sources.map(source => source.closed), [1, 1, 0]);
  await f.advance(500); assert.equal(f.runs, 1); assert.equal(f.timerCount, 0);
  assert.deepEqual(f.sources.map(source => source.closed), [1, 1, 1]); f.auto.dispose();
});

test('closing or switching cancels a queued automatic trigger, including during its second idle wait', async () => {
  const f = fixture(); f.auto.received(1); await f.advance(250);
  f.auto.cancel(); f.auto.cancel(); await f.advance(5000);
  assert.equal(f.runs, 0); assert.equal(f.timerCount, 0); assert.equal(f.sources[0].closed, 1);
  // Cancellation is not an attempted model request; a fresh explicit event can establish a new trigger.
  f.auto.received(1); await f.advance(500); assert.equal(f.runs, 1); f.auto.dispose();
});

for (const change of ['disabled', 'auto-disabled', 'interval-changed', 'settings-replaced', 'source-changed', 'chat-replaced', 'disposed']) {
  test(`${change} discards a pending trigger without running or advancing the adopted floor`, async () => {
    const f = fixture(); f.auto.received(1); await f.advance(250);
    if (change === 'disabled') f.settings.enabled = false;
    if (change === 'auto-disabled') f.settings.autoRefresh = false;
    if (change === 'interval-changed') f.settings.autoRefreshEvery = 2;
    if (change === 'settings-replaced') f.settings = { ...f.settings };
    if (change === 'source-changed') f.changeSource();
    if (change === 'chat-replaced') f.context.chat = [...f.context.chat];
    if (change === 'disposed') f.auto.dispose();
    await f.advance(2000);
    assert.equal(f.runs, 0); assert.equal(f.store.lastPlanIdx, 0); assert.equal(f.timerCount, 0);
    assert.equal(f.sources[0].closed, 1); f.auto.dispose();
  });
}

test('disposed coordinator ignores subsequent received events without creating a source or timer', async () => {
  const f = fixture(); f.auto.dispose(); f.auto.received(1); await f.advance(1000);
  assert.equal(f.runs, 0); assert.equal(f.sources.length, 0); assert.equal(f.timerCount, 0);
});

test('unknown host state cancels without model work or changing the adopted floor', async () => {
  const f = fixture(); f.nativeHost.isChatSaving = undefined;
  f.auto.received(1); await f.advance(1000);
  assert.equal(f.runs, 0); assert.equal(f.store.lastPlanIdx, 0); assert.equal(f.timerCount, 0);
  assert.equal(f.sources[0].closed, 1); assert.match(f.notices[0][0], /自动推演未启动/); f.auto.dispose();
});

test('cancel while the read-only host module is loading cannot resurrect the queued inference', async () => {
  let completeLoad;
  const f = fixture({ loadHost: nativeHost => new Promise(resolve => { completeLoad = () => resolve(nativeHost); }) });
  f.auto.received(1); await f.advance(250);
  assert.equal(typeof completeLoad, 'function'); f.auto.cancel();
  completeLoad(); await f.advance(2000);
  assert.equal(f.runs, 0); assert.equal(f.timerCount, 0); assert.equal(f.sources[0].closed, 1); f.auto.dispose();
});

test('a newer received event owns the shared host load; its predecessor cannot cancel or duplicate it', async () => {
  let completeLoad;
  const f = fixture({ loadHost: nativeHost => new Promise(resolve => { completeLoad = () => resolve(nativeHost); }) });
  f.auto.received(1); await f.advance(250);
  f.auto.received(1); await f.advance(250);
  completeLoad(); await f.advance(0);
  assert.equal(f.runs, 0); assert.deepEqual(f.sources.map(source => source.closed), [1, 0]);
  assert.equal(f.timerCount, 1);
  await f.advance(250);
  assert.equal(f.runs, 1); assert.deepEqual(f.sources.map(source => source.closed), [1, 1]); f.auto.dispose();
});

test('source changes while host readiness is pending discard the trigger before any stabilization or model work', async () => {
  let completeLoad;
  const f = fixture({ loadHost: nativeHost => new Promise(resolve => { completeLoad = () => resolve(nativeHost); }) });
  f.auto.received(1); await f.advance(250); f.changeSource();
  completeLoad(); await f.advance(2000);
  assert.equal(f.runs, 0); assert.equal(f.timerCount, 0); assert.equal(f.sources[0].closed, 1); f.auto.dispose();
});

test('failed or stopped stream residue does not produce an automatic run despite manual host admission being idle', async () => {
  const f = fixture(); f.nativeHost.streamingProcessor = { isStopped: true, isFinished: false };
  f.auto.received(1); await f.advance(1000);
  assert.equal(f.host.read().idle, true); assert.equal(f.runs, 0); assert.equal(f.timerCount, 0);
  assert.equal(f.store.lastPlanIdx, 0); f.auto.dispose();
});

test('an active Q operation delays the pending run and requires two fresh idle observations afterward', async () => {
  const f = fixture(); f.busy = true; f.auto.received(1);
  await f.advance(1250); assert.equal(f.runs, 0); assert.equal(f.timerCount, 1);
  f.busy = false;
  await f.advance(500); assert.equal(f.runs, 0);
  await f.advance(250); assert.equal(f.runs, 1); f.auto.dispose();
});

test('successful manual Q adoption while the automatic trigger waits consumes the floor without another request', async () => {
  const f = fixture(); f.busy = true; f.auto.received(1); await f.advance(250);
  f.store.lastPlanIdx = 1; f.busy = false;
  await f.advance(1000);
  assert.equal(f.runs, 0); assert.equal(f.timerCount, 0); assert.equal(f.sources[0].closed, 1); f.auto.dispose();
});

for (const type of ['quiet', 'impersonate']) test(`${type} event does not start a trigger`, async () => {
  const f = fixture(); f.auto.received(1, type); await f.advance(1000);
  assert.equal(f.runs, 0); assert.equal(f.sources.length, 0); assert.equal(f.timerCount, 0); f.auto.dispose();
});

for (const kind of ['user', 'system']) test(`${kind} message is neither a trigger nor an eligible response layer`, async () => {
  const f = fixture(); f.context.chat[1][kind === 'user' ? 'is_user' : 'is_system'] = true;
  f.auto.received(1); await f.advance(1000);
  assert.equal(f.runs, 0); assert.equal(f.sources.length, 0);
  f.settings.autoRefreshEvery = 2;
  f.context.chat.push({ name: 'Synthetic', mes: 'One actual response' });
  f.auto.received(2); await f.advance(1000);
  assert.equal(f.runs, 0); assert.equal(f.store.lastPlanIdx, 0); f.auto.dispose();
});

test('response interval counts only actual assistant replies and adopts only after the configured threshold', async () => {
  const f = fixture(); f.settings.autoRefreshEvery = 2;
  f.auto.received(1); await f.advance(1000); assert.equal(f.runs, 0);
  f.context.chat.push({ is_user: true, mes: 'User input' }, { is_system: true, mes: 'System entry' }, { name: 'Synthetic', mes: 'Second response' });
  f.auto.received(4); await f.advance(500);
  assert.equal(f.runs, 1); assert.equal(f.store.lastPlanIdx, 4); f.auto.dispose();
});

for (const mark of [-1, 99, NaN]) test(`initial or rewound mark ${mark} initializes without treating current history as new replies`, async () => {
  const f = fixture(); f.store.lastPlanIdx = mark; f.auto.received(1); await f.advance(1000);
  assert.equal(f.runs, 0); assert.equal(f.store.lastPlanIdx, 1); assert.equal(f.timerCount, 0); f.auto.dispose();
});

test('a continuously busy host expires the pending trigger after 15 minutes without timer leaks or model requests', async () => {
  const f = fixture(); f.generating = true; f.auto.received(1);
  await f.advance(15 * 60 * 1000); assert.equal(f.runs, 0); assert.equal(f.timerCount, 1);
  await f.advance(1000); assert.equal(f.runs, 0); assert.equal(f.timerCount, 0);
  assert.equal(f.sources[0].closed, 1); assert.equal(f.store.lastPlanIdx, 0);
  f.generating = false; await f.advance(5000); assert.equal(f.runs, 0);
  f.auto.received(1); await f.advance(500); assert.equal(f.runs, 1); f.auto.dispose();
});
