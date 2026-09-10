import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createFocusSpeechPlayer} from '../qianmu-focus-speech.js';
import {createFocusVoiceCache} from '../qianmu-focus-voice-cache.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

function fixture(){
  const audios=[],revoked=[],trace=[];let nextUrl=0;
  class Audio{
    constructor(src){this.src=src;this.events=new Map();this.paused=false;audios.push(this);}
    addEventListener(name,fn){this.events.set(name,fn);}
    pause(){this.paused=true;}
    play(){return Promise.resolve();}
    dispatch(name){this.events.get(name)?.();}
  }
  const c=vm.createContext({Audio,URL:{createObjectURL:()=>`blob:owned-${++nextUrl}`,revokeObjectURL:url=>revoked.push(url)},
    document:{querySelectorAll:()=>[]},applyQianmuIcons:()=>{},createFocusSpeechPlayer,focusClockSpeechPlayer:null,
    focusClockVoiceCache:createFocusVoiceCache({available:()=>false,read:async()=>null}),
    blobStore:{blobStoreAvailable:()=>true,getAudio:async()=>null},focusClockVoiceBindingActive:()=>true,
    ttsCurrentAudio:null,ttsCurrentUrl:'',ttsPlayCleanup:null,ttsSeqToken:0,
    focusClockPreparation:()=>({cancel:()=>trace.push('prepare-cancel')}),focusClockEntryEpoch:0,focusClockEntryBusy:false,focusClockLockConfirming:false,
    focusClockLockGuard:{dispose:()=>trace.push('guard-dispose')},focusClockRuntime:{stop:()=>trace.push('runtime-stop')},
    focusClockResetMedia:()=>trace.push('preview-stop'),focusClockCloseVoiceDrawer:()=>trace.push('drawer-close')});
  vm.runInContext(['ttsStopPlayback','ttsPlayBlob','focusClockSpeech','focusClockPlayVoiceCue','focusClockCancelVoiceWork','focusClockCancelEntry','stopFocusClockRuntime'].map(section).join('\n'),c);
  c.focusClockVoiceCache.remember('focus',new Blob(['focus']));
  return {c,audios,revoked,trace};
}

test('focus admission settles interrupted narration through the real shared channel cleanup',async()=>{
  const {c,audios,revoked}=fixture();let narrationDone=false;
  const narration=c.ttsPlayBlob(new Blob(['narration'])).then(()=>narrationDone=true),old=audios[0];
  assert.equal(await c.focusClockPlayVoiceCue({cacheKey:'focus'}),true);await narration;
  assert.equal(narrationDone,true);assert.equal(old.paused,true);assert.deepEqual(revoked,[old.src]);
  const current=audios[1],cleanup=c.ttsPlayCleanup;old.dispatch('ended');old.dispatch('error');
  assert.equal(c.ttsCurrentAudio,current);assert.equal(c.ttsPlayCleanup,cleanup);assert.equal(c.ttsCurrentUrl,current.src);
  current.dispatch('ended');assert.equal(c.ttsCurrentAudio,null);assert.equal(c.ttsPlayCleanup,null);assert.equal(c.ttsCurrentUrl,'');
  assert.deepEqual(revoked,[old.src,current.src]);
});

test('stopping focus cannot stop or release narration that has since taken ownership',async()=>{
  const {c,audios,revoked}=fixture();await c.focusClockPlayVoiceCue({cacheKey:'focus'});const old=audios[0];
  c.ttsStopPlayback(true);let narrationDone=false;
  const narration=c.ttsPlayBlob(new Blob(['narration'])).then(()=>narrationDone=true),current=audios[1],cleanup=c.ttsPlayCleanup;
  c.focusClockCancelVoiceWork();c.stopFocusClockRuntime();c.stopFocusClockRuntime();
  old.dispatch('ended');old.dispatch('error');await Promise.resolve();
  assert.equal(current.paused,false);assert.equal(narrationDone,false);assert.equal(c.ttsCurrentAudio,current);
  assert.equal(c.ttsCurrentUrl,current.src);assert.equal(c.ttsPlayCleanup,cleanup);assert.deepEqual(revoked,[old.src]);
  current.dispatch('ended');await narration;assert.equal(narrationDone,true);assert.deepEqual(revoked,[old.src,current.src]);
});

test('a newer narration request fences pending focus disk lookup before media creation',async()=>{
  const {c,audios,revoked}=fixture();let resolve;c.blobStore.getAudio=()=>new Promise(done=>resolve=done);
  const old=c.focusClockPlayVoiceCue({cacheKey:'disk'});c.ttsStopPlayback(true);
  const narration=c.ttsPlayBlob(new Blob(['narration'])),current=audios[0];resolve({blob:new Blob(['late'])});
  assert.equal(await old,false);assert.equal(audios.length,1);assert.equal(c.ttsCurrentAudio,current);assert.deepEqual(revoked,[]);
  current.dispatch('ended');await narration;assert.deepEqual(revoked,[current.src]);
});

test('stopping the focus runtime releases owned audio exactly once without persisting or deleting shared media',async()=>{
  const {c,audios,revoked,trace}=fixture();await c.focusClockPlayVoiceCue({cacheKey:'focus'});const audio=audios[0];
  c.stopFocusClockRuntime();c.stopFocusClockRuntime();audio.dispatch('ended');audio.dispatch('error');
  assert.equal(audio.paused,true);assert.equal(c.ttsCurrentAudio,null);assert.equal(c.ttsPlayCleanup,null);assert.equal(c.ttsCurrentUrl,'');
  assert.deepEqual(revoked,[audio.src]);assert.equal(c.focusClockVoiceCache.size,0);
  assert.equal(trace.filter(x=>x==='runtime-stop').length,2);assert.equal(trace.filter(x=>x==='guard-dispose').length,1);
});
