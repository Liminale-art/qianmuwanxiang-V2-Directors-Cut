import test from 'node:test';
import assert from 'node:assert/strict';
import {createFocusDialogueLibrary} from '../qianmu-focus-dialogue.js';
import {createFocusVoiceCache} from '../qianmu-focus-voice-cache.js';
import {createFocusVoicePreparation} from '../qianmu-focus-preparation.js';
import {focusFixture} from './helpers/focus-lock-fixture.mjs';
import {focusVoiceOptions} from '../qianmu-focus-voice.js';
const row={characterKey:'character:A.png',speaker:'甲',text:'慢慢来',moments:['focus:complete']};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function libraryFixture(legacy=async()=>[]){let owner={focusClock:{}},saved=0,id=0;const library=createFocusDialogueLibrary({owner:()=>owner,legacy,save:()=>saved++,uid:()=>`id${++id}`,random:()=>0});return {library,get owner(){return owner;},switch(){owner={focusClock:{}};},get saves(){return saved;}};}
test('first use copies only legacy text once, keeps originals intact and persists text without TTS',async()=>{
  let reads=0;const original={...row,voice:{voiceId:'v'},audioBytes:200};const f=libraryFixture(async()=>{reads++;return [original];});
  const [a,b]=await Promise.all([f.library.snapshot(),f.library.snapshot()]);assert.deepEqual(a,b);assert.equal(reads,1);assert.equal(f.saves,1);
  assert.equal(a.rows[0].voice,undefined);assert.equal(original.audioBytes,200);
  await f.library.put({...row,text:'另一句话'},a.revision);assert.equal((await f.library.snapshot()).rows.length,2);assert.equal(reads,1);
});
test('account change during legacy read cannot import the previous account into the new one',async()=>{
  let finish;const f=libraryFixture(()=>new Promise(resolve=>finish=resolve));const pending=f.library.snapshot();f.switch();finish([row]);await assert.rejects(pending,/账户/);assert.equal(f.owner.focusClock.dialogueLibrary,undefined);
});
test('legacy storage failure is not silently treated as an empty successful migration',async()=>{
  const f=libraryFixture(async()=>{throw Error('storage unavailable');});await assert.rejects(f.library.snapshot());assert.equal(f.saves,0);assert.equal(f.owner.focusClock.dialogueLibrary,undefined);
});
test('empty text and invalid moments do not save; edits compare revisions instead of overwriting a newer editor',async()=>{
  const f=libraryFixture(),a=await f.library.snapshot();await assert.rejects(f.library.put({...row,text:''},a.revision));await assert.rejects(f.library.put({...row,moments:['any']},a.revision));
  const b=await f.library.put(row,a.revision);await assert.rejects(f.library.put(row,a.revision),/已变化/);
  await f.library.remove(b.rows[0].id,b.revision);await assert.rejects(f.library.put(b.rows[0],b.revision+1),/已被删除/);
});
test('selection is scoped by stable character and phase, with no paid fallback for an empty stage',async()=>{
  const f=libraryFixture(async()=>[row,{...row,characterKey:'character:B.png',text:'乙'},{...row,moments:['shortBreak:complete'],text:'小憩'}]);
  const lines=await f.library.lines({characterKey:row.characterKey,phase:'focus',specs:[{type:'mid'},{type:'complete'}]});assert.deepEqual(lines,['','慢慢来']);
  assert.deepEqual(await f.library.lines({characterKey:row.characterKey,phase:'shortBreak',specs:[{type:'complete'}]}),['小憩']);
});
test('batch deletion removes only selected text in one revision, without touching replay or originals',async()=>{
  const f=libraryFixture(async()=>[row,{...row,text:'keep'},{...row,characterKey:'character:B.png',text:'other'}]);
  const before=await f.library.snapshot();f.owner.focusClock.voiceReplayCues=[{id:'audio',cacheKey:'keep'}];
  const after=await f.library.removeMany([before.rows[0].id,before.rows[2].id],before.revision);
  assert.equal(after.revision,before.revision+1);assert.deepEqual(after.rows.map(row=>row.text),['keep']);assert.equal(f.saves,2);
  assert.deepEqual(f.owner.focusClock.voiceReplayCues,[{id:'audio',cacheKey:'keep'}]);
});
test('missing or stale batch selection cannot produce a partial delete',async()=>{
  const f=libraryFixture(async()=>[row,{...row,text:'keep'}]),before=await f.library.snapshot();
  await assert.rejects(f.library.removeMany([before.rows[0].id,'missing'],before.revision),/已被删除/);
  assert.deepEqual(await f.library.snapshot(),before);
  const next=await f.library.put({...before.rows[1],text:'new edit'},before.revision);
  await assert.rejects(f.library.removeMany(before.rows.map(row=>row.id),before.revision),/已变化/);
  assert.deepEqual(await f.library.snapshot(),next);
});
test('simultaneous save and batch delete cannot both commit from the same revision',async()=>{
  const f=libraryFixture(async()=>[row]),before=await f.library.snapshot();
  const results=await Promise.allSettled([f.library.put({...before.rows[0],text:'newer'},before.revision),f.library.removeMany([before.rows[0].id],before.revision)]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal((await f.library.snapshot()).revision,before.revision+1);
});
test('voice labels omit backend identifiers without changing the selected identity or deduplication',()=>{
  const current={voiceId:'internal-key-123456789012',name:'清雅',model:'m'},second={voiceId:'another-key-123456789013',name:'清雅',model:'m'};
  const options=focusVoiceOptions({current,library:[current,second,{voiceId:'unnamed-id'}]});
  assert.equal(options.length,3);assert.equal(options[0].label,'清雅 · 已绑定');assert.equal(options[1].label,'清雅 · 音色库');assert.equal(options[2].label,'未命名音色 · 音色库');
  assert.equal(options[0].voiceId,current.voiceId);assert.notEqual(options[0].key,options[1].key);assert.ok(options.every(option=>!option.label.includes(option.voiceId)));
});
test('custom text needs voice credentials but never sends text to the scene LLM',async()=>{
  for(const credentials of [false,true]){
    const f={voiceMode:'custom',phase:'focus',status:'running',sessionToken:'t',sessionVoiceCues:[],voiceReplayCues:[],sessionPlannedMs:60000};let calls=0;
    const prep=createFocusVoicePreparation({enabled:()=>true,getState:()=>f,voice:{context:()=>({hasCharacter:true,enabled:true,voice:'v'}),key:()=> 'k',active:()=>true,params:()=>({providerId:'p'}),credentials:()=>credentials},
      frequencies:{low:{chance:0}},midpoints:()=>[],library:{lines:async()=>['台词']},textSource:{generate:()=>{throw Error('scene is forbidden');}},synthesize:async()=>{calls++;return 'key';},uid:()=> 'cue',save(){},now:()=>1});
    await prep.prepare('t');assert.equal(calls,credentials?1:0);assert.equal(f.voiceReplayCues.length,calls);
  }
});
test('next round expires only focus-owned audio, preserves favorites and leaves legacy shared audio alone',async()=>{
  const f={sessionToken:'next',voiceReplayCues:[{id:'a',cacheKey:'focus-round:old:a'},{id:'b',cacheKey:'focus-round:old:b'},{id:'legacy',cacheKey:'tts-shared'}]};
  const removed=[];const cache=createFocusVoiceCache({available:()=>true,round:{state:()=>f,hasFavorite:async key=>key.endsWith(':b'),remove:async key=>removed.push(key),save(){},warn(){throw Error('unexpected');}}});
  cache.remember('focus-round:old:a',new Blob(['a']));await cache.beginRound(f);
  assert.deepEqual(removed,['focus-round:old:a']);assert.deepEqual(f.voiceReplayCues.map(x=>x.id),['b']);assert.equal(cache.peek('focus-round:old:a'),undefined);assert.deepEqual(f.voiceCleanupCues,[]);
});
test('cleanup errors are retained for retry and reported, not silently counted as deleted',async()=>{
  const f={sessionToken:'new',voiceReplayCues:[{cacheKey:'focus-round:old:a'}]};let warnings=0;
  const cache=createFocusVoiceCache({available:()=>true,round:{state:()=>f,hasFavorite:async()=>false,remove:async()=>{throw Error('disk');},save(){},warn:()=>warnings++}});
  await cache.beginRound(f);assert.equal(f.voiceCleanupCues.length,1);assert.equal(warnings,1);
});
test('newly generated replay audio uses a focus-only round key rather than overwriting shared TTS keys',async()=>{
  const f={sessionToken:'round',voiceReplayCues:[]},writes=[];
  const cache=createFocusVoiceCache({available:()=>true,read:async()=>null,write:async key=>writes.push(key),prune:async()=>{},cacheLimit:()=>200,
    tts:{provider:()=>({}),hasCredentials:()=>true,key:()=> 'shared-key',synthesize:async()=>({blob:new Blob(['audio'])})},
    round:{state:()=>f,hasFavorite:async()=>false,remove:async()=>{},save(){},warn(){}}});
  await cache.beginRound(f);assert.equal(await cache.synthesize({params:{providerId:'p'}},'hello'),'focus-round:round:shared-key');assert.deepEqual(writes,['focus-round:round:shared-key']);
});
test('resume does not expire replay; auto next round waits for break alert before cleanup and preparation',async()=>{
  const {c,f,setNow}=focusFixture({voiceMode:'custom'}),trace=[];
  c.focusClockVoiceCache.beginRound=()=>trace.push('clear');c.focusClockVoiceContext=()=>({enabled:true});c.focusClockPrepareVoiceCues=async()=>trace.push('prepare');
  c.focusClockStart();c.focusClockPause();c.focusClockStart();assert.equal(trace.filter(x=>x==='clear').length,1);
  f.phase='shortBreak';f.autoStartNext=true;let finish;c.focusClockPlayCompletionAlert=()=>new Promise(resolve=>{trace.push('alert');finish=resolve;});
  setNow(f.endsAt);trace.length=0;c.focusClockComplete();assert.deepEqual(trace,['alert']);finish();await tick();assert.deepEqual(trace,['alert','clear','prepare']);
});
