import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as profiles from '../qianmu-focus-voice.js';
import {focusFixture} from './helpers/focus-lock-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const names=['focusClockVoiceContext','focusClockVoiceBindingKey','focusClockVoiceBindingActive','focusClockCancelVoiceWork',
  'focusClockSetVoiceEnabled','focusClockSynthVoiceCue','focusClockPrepareVoiceCues','focusClockPlayVoiceCue','focusClockPlayCompletionAlert',
  'focusClockMaybePlayMidCue','focusClockCleanVoiceLine','focusClockBuildVoiceParams','focusClockBindVoice'];
function fixture(overrides={}){
  const env=focusFixture({status:'running',sessionToken:'round',endsAt:160000,voiceProfiles:{'character:A':{minimax:{enabled:true,voice:{name:'甲',voiceId:'voice-A'},revision:1}}},...overrides});
  const {c}=env, counts={synth:0,put:0,play:0,stop:0,sound:0,revoke:0};
  const host={chatId:'chatA',characterId:0,characters:[{avatar:'A',name:'甲'},{avatar:'B',name:'乙'}]};
  const voices=[{name:'甲',voiceId:'voice-A'}];let provider='minimax';
  Object.assign(c,profiles,{ctx:()=>host,getChatKey:()=>host.chatId,getCharacterName:()=>host.characters[host.characterId]?.name,
    coreadHostPersona:()=>({key:'user-A'}),coreadPersona:()=>({key:'user-A'}),coreadCompanionSession:()=>null,
    coreadCompanionChoices:()=>host.characters,coreadCompanionCharacter:()=>host.characters.find(ch=>ch.avatar===(c.readerView?.companionAvatar||host.characters[host.characterId]?.avatar)),
    ttsProviderConfig:()=>({voiceLibrary:[]}),ttsActiveVoiceMap:()=>voices,ttsProviderId:()=>provider,ttsDoubaoVoiceModel:value=>value||'auto',
    FOCUS_CLOCK_RELATIONS:{neutral:{}},FOCUS_CLOCK_VOICE_FREQUENCIES:{low:{chance:.3}},focusClockVoicePrepareSeq:0,
    focusClockVoiceWork:null,focusClockVoicePlaybackSeq:0,focusClockVoiceAudio:null,focusClockVoiceBlobs:new Map(),
    focusClockMidCueProgresses:()=>[],focusClockPickStockLines:()=>['这一程已经完成。'],
    ttsBuildParams:(_line,voice)=>({providerId:provider,fileExtension:'mp3',voiceId:voice?.voiceId}),ttsProviderHasCredentials:()=>true,getTtsProvider:()=>({label:'TTS'}),
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
    assert.equal(f.voiceProfiles['character:A'].minimax.enabled,false);assert.equal(f.endsAt,end);assert.equal(f.status,status);
    assert.deepEqual(Array.from(f.sessionVoiceCues,cue=>cue.id),['heard']);assert.equal(c.focusClockVoicePrepareSeq,1);
  }
});
test('switching off remains possible after the configured voice disappears',()=>{
  const {c,f}=fixture();f.voiceProfiles['character:A'].minimax.voice=null;c.focusClockSetVoiceEnabled(false);assert.equal(f.voiceProfiles['character:A'].minimax.enabled,false);
  c.focusClockSetVoiceEnabled(true);assert.equal(f.voiceProfiles['character:A'].minimax.enabled,false);
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
test('independent reader identities use their own bound voice, and USER changes do not change the role voice',()=>{
  const {c}=fixture({activity:'reading'});c.readerView={companionAvatar:'B',userPersona:{key:'user-A'}};
  assert.equal(c.focusClockVoiceContext().voice,null);c.readerView={companionAvatar:'A',userPersona:{key:'user-B'}};
  assert.equal(c.focusClockVoiceContext().voice.voiceId,'voice-A');c.readerView.userPersona.key='user-A';assert.equal(c.focusClockVoiceContext().speaker,'甲');
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
  const {c,counts}=fixture();c.focusClockSetVoiceEnabled(false);c.focusClockVoiceBlobs.set('cache',new Blob(['audio']));
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
  const body=section('focusClockGenerateSceneLines');assert.match(body,/await coreadResolveCompanionMacro[\s\S]*if \(!isCurrent\(\)\)[\s\S]*await callExternalApi/);
  assert.match(section('stopFocusClockRuntime'),/focusClockCancelVoiceWork\(\)/);
});

test('role profiles share one voice across chats but keep same-name characters and providers separate',()=>{
  const {c,f,host,setProvider}=fixture();host.chatId='chatB';assert.equal(c.focusClockVoiceContext().voice.voiceId,'voice-A');
  host.characters[1].name='甲';host.characterId=1;assert.equal(c.focusClockVoiceContext().voice,null);
  profiles.saveFocusVoiceProfile(f,'character:B','minimax',{voiceId:'voice-B',name:'甲'},true);
  assert.equal(c.focusClockVoiceContext().voice.voiceId,'voice-B');setProvider('doubao');assert.equal(c.focusClockVoiceContext().voice,null);
  setProvider('minimax');assert.equal(c.focusClockVoiceContext().voice.voiceId,'voice-B');
});
test('chatless reading follows the selected companion without adopting host voices or modifying the host',()=>{
  const {c,f,host}=fixture({activity:'reading'});host.characterId=null;host.chatId='';
  c.readerView={bookId:'book',companionAvatar:'B',companionScope:'B:user-Z',userPersona:{key:'user-Z'}};
  profiles.saveFocusVoiceProfile(f,'character:B','minimax',{voiceId:'B',name:'书友音色'},true);
  const voice=c.focusClockVoiceContext();assert.equal(voice.characterKey,'character:B');assert.equal(voice.voice.voiceId,'B');assert.equal(voice.persona.key,'user-Z');
  c.focusClockSetVoiceEnabled(false);assert.equal(f.voiceProfiles['character:B'].minimax.enabled,false);assert.equal(host.characterId,null);
  host.characters.pop();assert.equal(c.focusClockVoiceContext().hasCharacter,false);assert.ok(f.voiceProfiles['character:B']);
});
test('old chat settings remain untouched and require explicit selection, never guessed ownership',()=>{
  const legacy={chatA:true},saved={chatA:'甲'};
  const {c,f}=fixture({status:'idle',voiceProfiles:{},voiceEnabledByChat:legacy,voiceSpeakerByChat:saved});
  const context=c.focusClockVoiceContext();assert.equal(context.voice,null);assert.equal(context.enabled,false);assert.equal(context.options.length,1);
  c.focusClockBindVoice(context.options[0].key,context.characterKey,context.providerId);
  assert.equal(c.focusClockVoiceContext().voice.voiceId,'voice-A');assert.equal(c.focusClockVoiceContext().enabled,false);
  assert.equal(f.voiceEnabledByChat,legacy);assert.equal(f.voiceSpeakerByChat,saved);
});
test('stale selection events cannot attach the displayed voice to a newly active character',()=>{
  const {c,f,host}=fixture({status:'idle',voiceProfiles:{}}),before=c.focusClockVoiceContext();host.characterId=1;
  c.focusClockBindVoice(before.options[0].key,before.characterKey,before.providerId);assert.equal(Object.keys(f.voiceProfiles).length,0);
});
test('saved voice is a safe snapshot and does not disappear or change with the source library',()=>{
  const source={name:'柔和',voiceId:'id',model:'auto',speed:1.1,apiKey:'not-persisted',endpoint:'not-persisted',extra:{}};
  const state={};profiles.saveFocusVoiceProfile(state,'character:A','doubao',source,true);source.voiceId='changed';
  assert.equal(state.voiceProfiles['character:A'].doubao.voice.voiceId,'id');assert.doesNotMatch(JSON.stringify(state),/not-persisted/);
  assert.equal(profiles.focusVoiceOptions({current:state.voiceProfiles['character:A'].doubao.voice}).length,1);
  assert.equal(profiles.cleanFocusVoice({voiceId:{}}),null);assert.equal(profiles.saveFocusVoiceProfile(state,'__proto__','minimax',source),null);
  assert.equal(profiles.saveFocusVoiceProfile(state,'character:A','__proto__',source),null);
});
test('explicit focus parameters reuse the provider builder without resolving a voice by chat speaker name',()=>{
  const {c}=fixture();c.ttsResolveVoice=()=>{throw Error('must not consult chat voice mapping');};
  c.ttsVoiceFx=()=>null;c.ttsPronunciationTone=()=>[];c.outputExtensionForTts=()=> 'mp3';
  c.ttsProviderConfig=()=>({apiKey:'ephemeral-key',model:'speech-test',defaultSpeed:1});vm.runInContext(section('ttsBuildParams'),c);
  const p=c.focusClockBuildVoiceParams(c.focusClockVoiceContext(),'你好');assert.equal(p.voiceId,'voice-A');assert.equal(p.text,'你好');assert.equal(p.apiKey,'ephemeral-key');
  assert.equal(p.voiceSourceType,'focus-character');assert.equal(p.voiceSourceId,'character:A');
});
test('resolved Doubao model updates only its matching role revision, never another chat map',()=>{
  const {c,f,setProvider}=fixture();setProvider('doubao');profiles.saveFocusVoiceProfile(f,'character:A','doubao',{voiceId:'A',model:'auto'},true);
  vm.runInContext(section('ttsPersistResolvedDoubaoModel'),c);
  const params={providerId:'doubao',model:'auto',voiceId:'A',voiceSourceType:'focus-character',voiceSourceId:'character:A',focusVoiceRevision:1};
  assert.equal(c.ttsPersistResolvedDoubaoModel(params,'resolved'),true);assert.equal(f.voiceProfiles['character:A'].doubao.voice.model,'resolved');
  profiles.saveFocusVoiceProfile(f,'character:A','doubao',{voiceId:'A',model:'auto'},true);
  assert.equal(c.ttsPersistResolvedDoubaoModel(params,'stale'),false);assert.equal(f.voiceProfiles['character:A'].doubao.voice.model,'auto');
});

test('damaged source lists cannot break a saved role binding and JSON settings round trips keep identity',()=>{
  const {c,f,voices}=fixture();voices.push(null);c.ttsProviderConfig=()=>({voiceLibrary:{bad:true}});
  assert.equal(c.focusClockVoiceContext().voice.voiceId,'voice-A');
  const restored=JSON.parse(JSON.stringify(f));assert.equal(profiles.focusVoiceProfile(restored,'character:A','minimax').voice.voiceId,'voice-A');
});
test('narration keeps its original chat resolver when no focus override is supplied',()=>{
  const {c}=fixture();c.ttsResolveVoice=()=>({voiceId:'narration',speed:1.2,emotion:'happy'});
  c.ttsVoiceFx=()=>null;c.ttsPronunciationTone=()=>[];c.outputExtensionForTts=()=> 'mp3';vm.runInContext(section('ttsBuildParams'),c);
  const params=c.ttsBuildParams({speaker:'原正文角色',text:'原句'});assert.equal(params.voiceId,'narration');assert.equal(params.speed,1.2);assert.equal(params.emotion,'happy');
});
test('scene prompts use the selected stable character and reader USER, not a same-name host description',async()=>{
  const {c,f,host}=fixture({activity:'reading'});host.characters[1].name='甲';host.characters[1].description='B description';
  c.readerView={companionAvatar:'B',userPersona:{key:'user-B',name:'乙方'}};profiles.saveFocusVoiceProfile(f,'character:B','minimax',{voiceId:'B'},true);
  let received;c.coreadResolveCompanionMacro=async(text,ch,persona)=>{received={text,ch,persona};return 'resolved B';};
  c.cleanContextText=x=>x;c.callSillyTavernModel=async()=>'{"lines":["完成了这一程。"]}';c.extractJson=JSON.parse;
  vm.runInContext(section('focusClockGenerateSceneLines'),c);await c.focusClockGenerateSceneLines(c.focusClockVoiceContext(),1,'读书');
  assert.equal(received.ch.avatar,'B');assert.equal(received.text,'B description');assert.equal(received.persona.key,'user-B');
});
