import assert from 'node:assert/strict';
import { test } from 'node:test';
import { focusRuntimeFixture } from './helpers/focus-runtime-fixture.mjs';

test('repeated runtime reconciliation owns exactly one ticker and one copy of each listener', () => {
  const e=focusRuntimeFixture(),before=JSON.stringify(e.state);
  for(let i=0;i<100;i++) e.c.startFocusClockRuntime({prepareVoice:false});
  assert.equal(e.timers.size,1);
  assert.equal([...e.timers.values()][0].ms,500);
  assert.equal(e.document.count(),1);assert.equal(e.window.count(),2);
  assert.equal(e.prepared.length,0);assert.equal(JSON.stringify(e.state),before);
});

test('idle and paused reconciliation removes background polling and wake listeners', () => {
  for(const status of ['idle','paused']){
    const e=focusRuntimeFixture();e.c.startFocusClockRuntime({prepareVoice:false});
    e.state.status=status;e.c.startFocusClockRuntime();
    assert.equal(e.timers.size,0);assert.equal(e.document.count()+e.window.count(),0);
    assert.equal(e.c.focusClockRuntime.active,false);assert.equal(e.prepared.length,0);
  }
});

test('completion during startup may reconcile the next phase without recursively installing runtimes', () => {
  const e=focusRuntimeFixture({remainingMs:0});
  e.c.focusClockComplete=()=>{
    e.trace.push('complete');Object.assign(e.state,{phase:'shortBreak',remainingMs:1000,sessionToken:''});
    e.c.startFocusClockRuntime({prepareVoice:false});
  };
  e.c.startFocusClockRuntime();
  assert.equal(e.trace.filter(x=>x==='complete').length,1);
  assert.equal(e.timers.size,1);assert.equal(e.document.count()+e.window.count(),3);
  assert.equal(e.prepared.length,0);assert.equal(e.c.focusClockRuntime.syncing,false);
});

test('visible/pageshow/focus wakeups reconcile current time, hidden visibility alone does not', () => {
  const e=focusRuntimeFixture();e.c.startFocusClockRuntime({prepareVoice:false});e.trace.length=0;
  e.document.visibilityState='hidden';e.document.dispatch('visibilitychange');assert.equal(e.trace.length,0);
  e.document.visibilityState='visible';e.document.dispatch('visibilitychange');
  e.window.dispatch('pageshow');e.window.dispatch('focus');assert.equal(e.trace.length,3);
  e.state.remainingMs=0;e.document.dispatch('visibilitychange');e.window.dispatch('focus');
  assert.equal(e.trace.filter(x=>x==='complete').length,1);
});

test('startup voice preparation obeys its existing phase/token/cache/enabled and explicit suppression gates', () => {
  for(const patch of [{phase:'shortBreak'},{sessionToken:''},{sessionVoiceCues:[{type:'complete'}]}]){
    const e=focusRuntimeFixture(patch);e.c.startFocusClockRuntime();assert.equal(e.prepared.length,0);
  }
  const off=focusRuntimeFixture();off.c.focusClockVoiceContext=()=>({enabled:false});off.c.startFocusClockRuntime();assert.equal(off.prepared.length,0);
  const suppressed=focusRuntimeFixture();suppressed.c.startFocusClockRuntime({prepareVoice:false});assert.equal(suppressed.prepared.length,0);
  const enabled=focusRuntimeFixture();enabled.c.startFocusClockRuntime();assert.deepEqual(enabled.prepared,['original']);
});

test('stop is repeatable, releases owned resources, and leaves unrelated timers/listeners intact', () => {
  const e=focusRuntimeFixture(),other=()=>{};
  e.window.addEventListener('focus',other);e.document.addEventListener('visibilitychange',other);
  const otherTimer=e.c.setInterval(other,1000);e.c.startFocusClockRuntime({prepareVoice:false});e.trace.length=0;
  e.c.stopFocusClockRuntime();e.c.stopFocusClockRuntime();
  assert.deepEqual(e.trace,['cancel','unlock','media','cancel','media']);
  assert.deepEqual([...e.timers.keys()],[otherTimer]);
  assert.equal(e.document.count(),1);assert.equal(e.window.count(),1);
  assert.ok(e.window.listeners.get('focus').has(other));
  assert.equal(e.c.focusClockRuntime.active,false);assert.equal(e.c.focusClockLockGuard,null);assert.equal(e.c.focusClockVoiceCache.size,0);
});

test('a failed startup tick releases the reentrancy guard so an explicit retry can succeed', () => {
  const e=focusRuntimeFixture(),paint=e.c.focusClockUpdateDom;
  e.c.focusClockUpdateDom=()=>{throw new Error('render failed');};
  assert.throws(()=>e.c.startFocusClockRuntime(),/render failed/);
  assert.equal(e.c.focusClockRuntime.syncing,false);assert.equal(e.timers.size,0);
  e.c.focusClockUpdateDom=paint;e.c.startFocusClockRuntime({prepareVoice:false});assert.equal(e.timers.size,1);
});

test('an installed ticker reads the latest state rather than keeping the starting session snapshot', () => {
  const e=focusRuntimeFixture();e.c.startFocusClockRuntime({prepareVoice:false});
  const replacement={...e.state,sessionToken:'replacement'};e.setState(replacement);
  [...e.timers.values()][0].fn();assert.equal(e.seen.at(-1),replacement);
});
