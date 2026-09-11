import test from 'node:test';
import assert from 'node:assert/strict';
import {createFocusLibraryEditor} from '../qianmu-focus-library-editor.js';
import {exportFocusLibrary,inspectFocusLibraryBackup} from '../qianmu-focus-library-backup.js';
import {createFocusVoicePreparation} from '../qianmu-focus-preparation.js';
import {createFocusSpeechPlayer} from '../qianmu-focus-speech.js';
import {focusFixture} from './helpers/focus-lock-fixture.mjs';
import {pickFocusStockLines} from '../qianmu-focus-scene-prompts.js';
const scope={namespace:'st-user:tester',characterKey:'character:a.png'};
const initial={...scope,id:'clip',text:'这一程完成了',moments:['focus:complete'],voice:{voiceId:'v'},revision:1};
const blob=new Blob(['sound'],{type:'audio/wav'});
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
test('scene fallback refactor preserves repeated draws without consuming the source bank',()=>{
  const bank=['a','b'];const result=pickFocusStockLines(bank,5);assert.equal(result.length,5);assert.ok(result.every(x=>bank.includes(x)));assert.notEqual(result[0],result[1]);assert.deepEqual(bank,['a','b']);
});

test('wording and voice edits invalidate the audio, but title and moments keep it',async()=>{
  let writes=0;const editor=createFocusLibraryEditor({scope,initial,blob,save:async()=>{writes++;return {status:'conflict'};}});
  editor.update({title:'标题',moments:['shortBreak:complete']});assert.equal(editor.snapshot().audio,blob);
  editor.update({text:'新内容'});await assert.rejects(editor.save(),/请先生成/);assert.equal(writes,0);
});
test('explicit regeneration never overwrites the saved original until save is clicked',async()=>{
  let writes=0;const editor=createFocusLibraryEditor({scope,initial,blob,generate:async()=>blob,save:async(_s,clip,_b,opts)=>{
    writes++;assert.equal(opts.expectedRevision,1);return {status:'saved',clip:{...clip,revision:2}};}});
  await editor.generate();assert.equal(writes,0);await editor.save();assert.equal(writes,1);assert.equal(editor.snapshot().draft.revision,2);
});
test('generation is single-flight and a closed editor cannot accept the late audio',async()=>{
  const wait=deferred(),editor=createFocusLibraryEditor({scope,initial,generate:()=>wait.promise});
  const run=editor.generate();await assert.rejects(editor.generate(),/等待/);assert.throws(()=>editor.update({text:'changed'}),/等待/);
  editor.close();wait.resolve(blob);assert.equal((await run).status,'stale');assert.equal(editor.snapshot().audio,null);
});
test('save conflicts keep the user draft and never silently overwrite',async()=>{
  const editor=createFocusLibraryEditor({scope,initial,blob,save:async()=>({status:'conflict'})});
  editor.update({title:'My changes'});assert.equal((await editor.save()).status,'conflict');assert.equal(editor.snapshot().draft.title,'My changes');
});
const rows=[{...initial,audioBytes:blob.size,mimeType:blob.type}];
test('backup round trip contains originals but not account credentials',async()=>{
  const file=await exportFocusLibrary(rows,{readAudio:async()=>({status:'ready',blob})});
  const restored=await inspectFocusLibraryBackup(file);assert.equal(restored.length,1);assert.equal(await restored[0].blob.text(),'sound');
  assert.equal(restored[0].clip.characterKey,scope.characterKey);assert.equal(restored[0].clip.text,initial.text);
  assert.equal(JSON.parse(await file.text()).credentialsIncluded,false);
});
test('changed or missing audio never produces a plausible incomplete backup',async()=>{
  for(const status of ['missing','conflict'])await assert.rejects(exportFocusLibrary(rows,{readAudio:async()=>({status})}),/未输出缺件/);
});
test('oversized selection is rejected before reading originals',async()=>{
  let reads=0;await assert.rejects(exportFocusLibrary(Array.from({length:5},(_,i)=>({...rows[0],id:`c${i}`,audioBytes:8*1024*1024})),{readAudio:()=>reads++}),/分批选择/);assert.equal(reads,0);
});
test('backup detects audio corruption, metadata alteration, duplicate keys and unknown credentials',async()=>{
  const file=await exportFocusLibrary(rows,{readAudio:async()=>({status:'ready',blob})}),source=JSON.parse(await file.text());
  for(const change of [p=>p.items[0].clip.text='altered',p=>p.items[0].data=btoa('noise'),p=>p.items[0].apiKey='secret',p=>p.items.push(p.items[0])]){
    const value=structuredClone(source);change(value);await assert.rejects(inspectFocusLibraryBackup(new Blob([JSON.stringify(value)])));
  }
  await assert.rejects(inspectFocusLibraryBackup(new Blob(['{"schema":"first","schema":"second"}'])),/重复/);
});
test('backup cancellation never yields a downloadable partial success',async()=>{
  let count=0;await assert.rejects(exportFocusLibrary(rows,{readAudio:async()=>({status:'ready',blob}),guard:async()=>{if(++count>1)throw Error('closed');}}),/closed/);
});
for(const phase of ['focus','shortBreak','longBreak'])test(`custom ${phase} selects stage text and synthesizes with the current bound voice`,async()=>{
  let used;const state={voiceMode:'custom',phase,status:'running',sessionToken:'t',sessionPlannedMs:3600000,sessionVoiceCues:[]};
  let synths=0;const prohibited=()=>{throw Error('must not call the scene LLM');};
  const prep=createFocusVoicePreparation({enabled:()=>true,getState:()=>state,voice:{context:()=>({hasCharacter:true,enabled:true,voice:{voiceId:'v'}}),key:()=> 'k',active:()=>true,params:()=>({providerId:'minimax'}),credentials:()=>true},
    frequencies:{low:{chance:1}},midpoints:()=>[.5],library:{lines:async spec=>{used=spec;return spec.specs.map(()=> '用户的完整台词'.repeat(30));}},
    textSource:{generate:prohibited,fallback:prohibited},synthesize:async(_binding,text)=>{assert.ok(text.length>80);synths++;return 'cache';},uid:()=>String(synths),save:()=>{},now:()=>1});
  await prep.prepare('t');assert.ok(used.isCurrent());assert.equal(used.specs.at(-1).type,'complete');assert.equal(used.specs.length,phase==='focus'?2:1);
  assert.equal(synths,used.specs.length);assert.equal(state.sessionVoiceCues.length,synths);
  prep.cancel();assert.equal(used.isCurrent(),false);
});
for(const phase of ['shortBreak','longBreak'])test(`${phase} completion uses its own custom cue and does not write a fake focus history`,async()=>{
  const {c,f}=focusFixture({voiceMode:'custom',phase,status:'idle'});let prepared='',played;
  c.focusClockVoiceContext=()=>({enabled:true});c.focusClockPrepareVoiceCues=async token=>prepared=token;
  c.focusClockVoiceBindingActive=()=>true;c.focusClockPlayCompletionAlert=async cue=>played=cue;
  c.focusClockStart();assert.ok(prepared);f.sessionVoiceCues=[{type:'complete',cacheKey:'library',voiceBindingKey:'k',text:'休息结束'}];
  c.focusClockComplete();assert.equal(played.text,'休息结束');assert.equal(f.history.length,0);assert.equal(f.phase,'focus');
});
test('custom playback reads the immutable original and never substitutes a stale cache hit',async()=>{
  let played=0,revoked=0;const player=createFocusSpeechPlayer({Audio:class{addEventListener(){}async play(){played++;}},URL:{createObjectURL:()=> 'blob:test',revokeObjectURL:()=>revoked++},
    memory:()=>blob,cacheAvailable:()=>{throw Error('no shared cache');},readLibrary:async()=>null,bindingActive:()=>true,
    channel:{epoch:()=>0,current:()=>null,stop(){},adopt(){},release(){}}});
  assert.equal(await player.play({cacheKey:'library',library:{...scope,id:'c',revision:1}}),false);assert.equal(played,0);assert.equal(revoked,0);
});
