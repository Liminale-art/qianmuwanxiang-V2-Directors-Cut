import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const functions=['focusClockMediaSource','focusClockStopPreviewFrame','focusClockRunPreviewFrame','focusClockAttachMediaEvents','focusClockEnsureMedia','focusClockResetMedia','focusClockPrimeSound','focusClockPlayDoneSound'];
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  const pending=[],audios=[],frames=new Map(),notices=[];let id=0,paints=0;
  class Audio {
    constructor(src){this.src=src;this.dataset={};this.volume=1;this.currentTime=0;this.duration=60;this.paused=true;this.ended=false;this.events=new Map();audios.push(this);}
    addEventListener(name,fn){const list=this.events.get(name)||[];list.push(fn);this.events.set(name,list);}
    dispatch(name){for(const fn of this.events.get(name)||[])fn();}
    pause(){this.paused=true;this.dispatch('pause');}
    play(){this.paused=false;this.dispatch('play');return new Promise((resolve,reject)=>pending.push({audio:this,resolve,reject}));}
  }
  const state={soundEnabled:true,soundSource:'builtin',soundPreset:'silverBell'};
  const c=vm.createContext({Audio,focusClockMedia:null,focusClockMediaSeq:0,focusClockPreviewMode:false,focusClockPreviewFrame:0,
    focusClockState:()=>state,FOCUS_CLOCK_SOUND_PRESETS:{silverBell:{url:'bell'},other:{url:'other'}},
    focusClockSyncPreviewButton:()=>paints++,requestAnimationFrame:fn=>{frames.set(++id,fn);return id;},cancelAnimationFrame:key=>frames.delete(key),
    toast:message=>notices.push(message)});
  vm.runInContext(functions.map(section).join('\n'),c);
  return {c,state,pending,audios,frames,notices,paintCount:()=>paints};
}

test('preview keeps one audio element and one frame, supports pause/resume without losing seek position',async()=>{
  const {c,pending,audios,frames}=fixture();let play=c.focusClockPlayDoneSound({preview:true});pending[0].resolve();assert.equal(await play,true);
  const audio=audios[0];audio.currentTime=17;assert.equal(frames.size,1);
  assert.equal(await c.focusClockPlayDoneSound({preview:true}),true);assert.equal(audio.paused,true);assert.equal(frames.size,0);
  play=c.focusClockPlayDoneSound({preview:true});pending[1].resolve();assert.equal(await play,true);
  assert.equal(audios.length,1);assert.equal(audio.currentTime,17);assert.equal(frames.size,1);
  audio.ended=true;audio.dispatch('ended');assert.equal(frames.size,0);assert.equal(audio.currentTime,0);assert.equal(c.focusClockPreviewMode,false);
});

test('late warmup cannot pause or seek a newly selected preview source',async()=>{
  const {c,state,pending,audios}=fixture();c.focusClockPrimeSound();state.soundPreset='other';
  const play=c.focusClockPlayDoneSound({preview:true});pending[1].resolve();await play;audios[1].currentTime=23;
  pending[0].resolve();await flush();assert.equal(audios[1].paused,false);assert.equal(audios[1].currentTime,23);assert.equal(audios[1].volume,1);
});

test('explicit preview wins over an older warmup even when both use the same audio element',async()=>{
  const {c,pending,audios}=fixture();c.focusClockPrimeSound();const play=c.focusClockPlayDoneSound({preview:true});pending[1].resolve();await play;
  audios[0].currentTime=9;pending[0].resolve();await flush();assert.equal(audios[0].paused,false);assert.equal(audios[0].currentTime,9);
});

test('reset invalidates pending warmup fulfillment and rejection without reviving or touching released media',async()=>{
  for(const rejected of [false,true]){
    const {c,pending,frames}=fixture();c.focusClockPrimeSound();c.focusClockResetMedia();
    if(rejected)pending[0].reject(new Error('denied'));else pending[0].resolve();await flush();
    assert.equal(c.focusClockMedia,null);assert.equal(frames.size,0);assert.equal(c.focusClockPreviewMode,false);
  }
});

test('late ended from an old source cannot reset a newer preview or cancel its frame',async()=>{
  const {c,state,pending,audios,frames}=fixture();let play=c.focusClockPlayDoneSound({preview:true});pending[0].resolve();await play;
  state.soundPreset='other';play=c.focusClockPlayDoneSound({preview:true});pending[1].resolve();await play;
  audios[0].dispatch('ended');assert.equal(c.focusClockPreviewMode,true);assert.equal(frames.size,1);
});

test('pending preview is discarded after reset and stale failures do not show misleading errors',async()=>{
  for(const rejected of [false,true]){
    const {c,pending,frames,notices,paintCount}=fixture();const play=c.focusClockPlayDoneSound({preview:true});c.focusClockResetMedia();const before=paintCount();
    if(rejected)pending[0].reject(new Error('late'));else pending[0].resolve();
    assert.equal(await play,false);assert.equal(frames.size,0);assert.equal(paintCount(),before);assert.equal(notices.length,0);
  }
});

test('disabled automatic sound does not allocate media; current preview failures still report an actionable error',async()=>{
  const {c,state,pending,audios,notices,frames}=fixture();state.soundEnabled=false;
  assert.equal(await c.focusClockPlayDoneSound(),false);assert.equal(audios.length,0);
  const play=c.focusClockPlayDoneSound({preview:true});pending[0].reject(new Error('denied'));assert.equal(await play,false);
  assert.equal(notices.length,1);assert.equal(frames.size,0);assert.equal(c.focusClockPreviewMode,false);
});
