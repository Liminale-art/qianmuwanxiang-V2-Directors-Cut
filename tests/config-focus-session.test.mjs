import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareConfigRestore,resetRestoredFocusSession,configRestoreSummary} from '../qianmu-config-connections.js';
import {createFocusClockRuntime} from '../qianmu-focus-runtime.js';
import {inspectFocusLock} from '../qianmu-focus-lock.js';
import {clone,mergeDefaults} from '../qianmu-storyboard-utils.js';
const options={clone,mergeDefaults,normalizeStoryboardState:clone};
const liveFocus=()=>({phase:'focus',status:'running',focusMinutes:35,endsAt:9999999999999,runStartedAt:1,sessionStartedAt:1,sessionElapsedMs:999,
  lock:{owner:'device',version:1,startedAt:1,endsAt:9999999999999},sessionToken:'old-token',readingExitPaused:true,sessionBookId:'book',sessionProgressStart:20,
  sessionVoiceCues:[{text:'pending',cacheKey:'focus-round:other-key',played:false}],voiceRoundId:'old-round',voiceReplayCues:[{cacheKey:'focus-round:other-key'}],voiceCleanupCues:[{cacheKey:'focus-round:other-key'}],
  task:'阅读',bookId:'book',activity:'reading',history:[{id:'done',kind:'focus',durationMs:1000,voiceCues:[{text:'completed'}]}],focusCycle:2,lastCompletionId:'done',voiceProfiles:{character:{voice:'saved'}},autoStartNext:true});
test('only explicit config preparation resets foreign session authority without touching source or local state',()=>{
  const incoming={focusClock:liveFocus()},current={focusClock:{status:'idle',task:'local'}};
  const before=structuredClone(incoming),local=structuredClone(current),out=prepareConfigRestore(incoming,current,{},true,options),f=out.focusClock;
  assert.equal(f.status,'idle');assert.equal(f.lock,null);assert.equal(f.endsAt,0);assert.equal(f.readingExitPaused,false);assert.equal(f.sessionToken,'');
  assert.equal(f.sessionElapsedMs,0);assert.equal(f.sessionBookId,'');assert.equal(f.remainingMs,35*60000);assert.equal(f.sessionPlannedMs,f.remainingMs);
  for(const field of ['sessionVoiceCues','voiceReplayCues','voiceCleanupCues'])assert.deepEqual(f[field],[]);
  for(const field of ['task','bookId','activity','history','focusCycle','lastCompletionId','voiceProfiles','autoStartNext'])assert.deepEqual(f[field],before.focusClock[field]);
  assert.deepEqual(incoming,before);assert.deepEqual(current,local);
});
test('running and paused focus cannot restart a timer, prepare voice or establish a lock after import',()=>{
  for(const status of ['running','paused']){
    const state={focusClock:{...liveFocus(),status}};resetRestoredFocusSession(state);let intervals=0,voices=0;
    const events={addEventListener(){},removeEventListener(){}};
    const runtime=createFocusClockRuntime({document:events,window:events,setInterval(){intervals++;return 1;},clearInterval(){},tick(){},getState:()=>state.focusClock,prepare(){voices++;}});
    runtime.start();assert.equal(runtime.active,false);assert.equal(intervals,0);assert.equal(voices,0);assert.equal(inspectFocusLock(state.focusClock,'device').active,false);
  }
});
test('reset uses selected phase duration while preserving cycle settings and does not fabricate missing focus settings',()=>{
  for(const [phase,field,value,minutes] of [['shortBreak','shortBreakMinutes',12,12],['longBreak','longBreakMinutes',999,120],['bad','focusMinutes',-3,1]]){
    const settings={focusClock:{phase,[field]:value}};resetRestoredFocusSession(settings);assert.equal(settings.focusClock.remainingMs,minutes*60000);assert.equal(settings.focusClock[field],value);
  }
  const empty={};assert.equal(resetRestoredFocusSession(empty),empty);assert.deepEqual(empty,{});
});
test('legacy migration cannot refill runtime state after it is neutralized and preview describes the boundary',()=>{
  const out=prepareConfigRestore({}, {}, {},true,{...options,migrateSettings:s=>{s.focusClock=liveFocus();}});
  assert.equal(out.focusClock.status,'idle');assert.deepEqual(out.focusClock.voiceCleanupCues,[]);
  assert.match(configRestoreSummary({},true),/不恢复旧锁屏/);
});
