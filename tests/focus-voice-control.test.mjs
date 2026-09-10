import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {focusFixture} from './helpers/focus-lock-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const names=['focusClockVoiceContext','focusClockVoiceBindingKey','focusClockVoiceBindingActive','focusClockCancelVoiceWork',
  'focusClockSetVoiceEnabled','focusClockSynthVoiceCue','focusClockPrepareVoiceCues','focusClockPlayVoiceCue','focusClockPlayCompletionAlert',
  'focusClockMaybePlayMidCue','focusClockCleanVoiceLine'];
function fixture(overrides={}){
  const env=focusFixture({status:'running',sessionToken:'round',endsAt:160000,voiceEnabledByChat:{chatA:true},...overrides});
  const {c}=env, counts={synth:0,put:0,play:0,stop:0,sound:0,revoke:0};
  const host={chatId:'chatA',characterId:0,characters:[{avatar:'A',name:'甲'},{avatar:'B',name:'乙'}]};
  const voices=[{name:'甲',voiceId:'voice-A'}];let provider='minimax';
  Object.assign(c,{ctx:()=>host,getChatKey:()=>host.chatId,getCharacterName:()=>host.characters[host.characterId]?.name,
    coreadHostPersona:()=>({key:'user-A'}),ttsActiveVoiceMap:()=>voices,ttsProviderId:()=>provider,
    FOCUS_CLOCK_RELATIONS:{neutral:{}},FOCUS_CLOCK_VOICE_FREQUENCIES:{low:{chance:.3}},focusClockVoicePrepareSeq:0,
    focusClockVoiceWork:null,focusClockVoicePlaybackSeq:0,focusClockVoiceAudio:null,focusClockVoiceBlobs:new Map(),
    focusClockMidCueProgresses:()=>[],focusClockPickStockLines:()=>['这一程已经完成。'],
    ttsBuildParams:()=>({providerId:provider,fileExtension:'mp3'}),ttsProviderHasCredentials:()=>true,getTtsProvider:()=>({label:'TTS'}),
    cacheKeyForTts:()=> 'cache',DOMException,Blob,focusClockGenerateSceneLines:async()=>['完成。'],
    blobStore:{blobStoreAvailable:()=>true,getAudio:async()=>null,putAudio:async()=>counts.put++,pruneAudio:async()=>{}},
    synthesizeTts:async()=>{counts.synth++;return {blob:new Blob(['audio'])};},MODULE_NAME:'test',
    ttsCurrentAudio:null,ttsCurrentUrl:'',ttsSeqToken:0,ttsPlayCleanup:null,
    ttsStopPlayback:()=>{counts.stop++;c.ttsSeqToken++;c.ttsCurrentAudio?.pause();c.ttsPlayCleanup?.();c.ttsCurrentAudio=null;},
    URL:{createObjectURL:()=> 'blob:test',revokeObjectURL:()=>counts.revoke++},
    Audio:class { addEventListener(){} pause(){this.paused=true;} async play(){counts.play++;} },
    focusClockPlayDoneSound:async()=>counts.sound++});
  vm.runInContext(names.map(section).join('\n'),c);
  return {...env,counts,host,voices,setProvider:value=>provider=value};
}
const pending=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:value=>resolve(value)};};
const cueFor=c=>({cacheKey:'cache',voiceBindingKey:c.focusClockVoiceBindingKey(c.focusClockVoiceContext())});

test('all three phases allow switching off while running or paused, without changing timing',()=>{
  for(const phase of ['focus','shortBreak','longBreak']) for(const status of ['running','paused']){
    const {c,f}=fixture({phase,status});const end=f.endsAt;
    f.sessionVoiceCues=[{played:true,id:'heard'},{played:false,id:'pending'}];c.focusClockSetVoiceEnabled(false);
    assert.equal(f.voiceEnabledByChat.chatA,false);assert.equal(f.endsAt,end);assert.equal(f.status,status);
    assert.deepEqual(Array.from(f.sessionVoiceCues,cue=>cue.id),['heard']);assert.equal(c.focusClockVoicePrepareSeq,1);
  }
});
test('switching off remains possible after the configured voice disappears',()=>{
  const {c,f,voices}=fixture();voices.length=0;c.focusClockSetVoiceEnabled(false);assert.equal(f.voiceEnabledByChat.chatA,false);
  c.focusClockSetVoiceEnabled(true);assert.equal(f.voiceEnabledByChat.chatA,false);
});
test('repeated preparation is deduplicated, and turning off during LLM work prevents TTS',async()=>{
  const {c,f,counts}=fixture({voiceMode:'scene'}),wait=pending();let calls=0;
  c.focusClockGenerateSceneLines=()=>{calls++;return wait.promise;};
  const run=c.focusClockPrepareVoiceCues('round');await c.focusClockPrepareVoiceCues('round');assert.equal(calls,1);
  c.focusClockSetVoiceEnabled(false);wait.resolve(['完成。']);await run;
  assert.equal(counts.synth,0);assert.equal(f.sessionVoiceCues.length,0);assert.equal(c.focusClockVoiceWork,null);
});
test('turning off during an audio cache lookup prevents submitting a new synthesis',async()=>{
  const {c,counts}=fixture(),wait=pending();c.blobStore.getAudio=()=>wait.promise;
  const run=c.focusClockPrepareVoiceCues('round');c.focusClockSetVoiceEnabled(false);wait.resolve(null);await run;
  assert.equal(counts.synth,0);assert.equal(counts.put,0);
});
test('a paid response returning after mute is discarded without caching, metadata changes or playback',async()=>{
  const {c,f,counts}=fixture(),wait=pending();c.blobStore.blobStoreAvailable=()=>false;
  c.synthesizeTts=()=>{counts.synth++;return wait.promise;};const run=c.focusClockPrepareVoiceCues('round');
  assert.equal(counts.synth,1);c.focusClockSetVoiceEnabled(false);wait.resolve({blob:new Blob(['late'])});await run;
  assert.equal(f.sessionVoiceCues.length,0);assert.equal(c.focusClockVoiceBlobs.size,0);assert.equal(counts.play,0);
});
test('changing the chat or provider while preparing cannot bind old results to the new context',async()=>{
  for(const change of ['chat','provider']){
    const {c,f,counts,host,setProvider}=fixture({voiceMode:'scene'}),wait=pending();c.focusClockGenerateSceneLines=()=>wait.promise;
    const run=c.focusClockPrepareVoiceCues('round');if(change==='chat') host.chatId='chatB';else setProvider('doubao');
    wait.resolve(['完成。']);await run;assert.equal(counts.synth,0);assert.equal(f.sessionVoiceCues.length,0);
  }
});
test('turning off then on cannot let the older response erase the newer generation ticket',async()=>{
  const {c,f,counts}=fixture(),old=pending(),fresh=pending();c.blobStore.blobStoreAvailable=()=>false;
  c.synthesizeTts=()=>{counts.synth++;return counts.synth===1?old.promise:fresh.promise;};
  const first=c.focusClockPrepareVoiceCues('round');c.focusClockSetVoiceEnabled(false);c.focusClockSetVoiceEnabled(true);
  const ticket=c.focusClockVoiceWork;old.resolve({blob:new Blob(['old'])});await first;
  assert.equal(c.focusClockVoiceWork,ticket);assert.equal(f.sessionVoiceCues.length,0);
  fresh.resolve({blob:new Blob(['fresh'])});await new Promise(r=>setImmediate(r));
  assert.equal(f.sessionVoiceCues.length,1);assert.equal(await c.focusClockVoiceBlobs.get('cache').text(),'fresh');
});
test('normal enabled preparation still produces a usable completion cue without serializing credentials',async()=>{
  const {c,f,counts}=fixture();c.ttsBuildParams=()=>({providerId:'minimax',apiKey:'fixture-only-secret'});
  await c.focusClockPrepareVoiceCues('round');assert.equal(counts.synth,1);assert.equal(counts.put,1);
  assert.equal(f.sessionVoiceCues[0].type,'complete');assert.ok(f.sessionVoiceCues[0].voiceBindingKey);
  assert.doesNotMatch(JSON.stringify(f),/fixture-only-secret/);
});
test('independent reader identities cannot borrow the host chat voice before role-level binding lands',()=>{
  const {c}=fixture({activity:'reading'});c.readerView={companionAvatar:'B',userPersona:{key:'user-A'}};
  assert.equal(c.focusClockVoiceContext().speaker,'');c.readerView={companionAvatar:'A',userPersona:{key:'user-B'}};
  assert.equal(c.focusClockVoiceContext().speaker,'');c.readerView.userPersona.key='user-A';assert.equal(c.focusClockVoiceContext().speaker,'甲');
});
test('mute after async playback lookup prevents both voice and surprise completion fallback',async()=>{
  const {c,counts}=fixture(),wait=pending();c.blobStore.getAudio=()=>wait.promise;
  const play=c.focusClockPlayCompletionAlert(cueFor(c));c.focusClockSetVoiceEnabled(false);wait.resolve({blob:new Blob(['audio'])});await play;
  assert.equal(counts.play,0);assert.equal(counts.sound,0);
});
test('mute stops and releases focus audio but does not stop unrelated narration',async()=>{
  const {c,counts}=fixture();c.focusClockVoiceBlobs.set('cache',new Blob(['audio']));await c.focusClockPlayVoiceCue(cueFor(c),{automatic:true});
  const audio=c.focusClockVoiceAudio;c.focusClockSetVoiceEnabled(false);assert.equal(audio.paused,true);assert.equal(counts.revoke,1);
  const other={pause(){throw Error('must not stop narration');}};c.ttsCurrentAudio=other;c.focusClockSetVoiceEnabled(false);assert.equal(c.ttsCurrentAudio,other);
});
test('a newer user playback wins over an older focus cache lookup',async()=>{
  const {c,counts}=fixture(),wait=pending();c.blobStore.getAudio=()=>wait.promise;const run=c.focusClockPlayVoiceCue(cueFor(c));
  c.ttsSeqToken++;wait.resolve({blob:new Blob(['old'])});assert.equal(await run,false);assert.equal(counts.play,0);
});
test('manual replay remains an explicit action while automatic voice is off; ordinary done sound is independent',async()=>{
  const {c,counts}=fixture({voiceEnabledByChat:{chatA:false}});c.focusClockVoiceBlobs.set('cache',new Blob(['audio']));
  assert.equal(await c.focusClockPlayVoiceCue(cueFor(c),{automatic:true}),false);
  assert.equal(await c.focusClockPlayVoiceCue({cacheKey:'cache'}),true);await c.focusClockPlayCompletionAlert(null);assert.equal(counts.sound,1);
});
test('pause cancels pending preparation; resume can prepare missing cues without restarting the timer',async()=>{
  const {c,f,counts}=fixture({voiceMode:'scene'}),wait=pending();c.focusClockGenerateSceneLines=()=>wait.promise;
  const run=c.focusClockPrepareVoiceCues('round');c.focusClockPause();wait.resolve(['完成。']);await run;assert.equal(counts.synth,0);
  c.focusClockGenerateSceneLines=async()=>['完成。'];c.focusClockStart();await new Promise(r=>setImmediate(r));
  assert.equal(f.status,'running');assert.equal(f.sessionToken,'round');assert.equal(f.sessionVoiceCues.length,1);
});
test('scene admission is checked after asynchronous macro resolution, before either model transport',()=>{
  const body=section('focusClockGenerateSceneLines');assert.match(body,/await resolveMacro[\s\S]*if \(!isCurrent\(\)\)[\s\S]*await callExternalApi/);
  assert.match(section('stopFocusClockRuntime'),/focusClockCancelVoiceWork\(\)/);
});
