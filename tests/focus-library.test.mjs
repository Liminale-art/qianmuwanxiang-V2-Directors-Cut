import test from 'node:test';
import assert from 'node:assert/strict';
import {focusVoiceCharacterKey} from '../qianmu-focus-voice.js';
import {normalizeFocusLibraryClip,focusLibraryClipKey,createFocusLibraryPicker,FOCUS_LIBRARY_MOMENTS} from '../qianmu-focus-library.js';
import {createFocusLibraryStore} from '../qianmu-focus-library-store.js';
const scope={namespace:'st-user:test',characterKey:focusVoiceCharacterKey('A.png')};
const clip=(id='one')=>({...scope,schemaVersion:1,id,text:'这一程做得很好',speaker:'A',moments:['focus:complete'],revision:1});

test('focus library identity is account plus stable character, never a chat or display name',()=>{
  assert.notEqual(focusLibraryClipKey(scope,'one'),focusLibraryClipKey({...scope,namespace:'st-user:other'},'one'));
  assert.notEqual(focusLibraryClipKey(scope,'one'),focusLibraryClipKey({...scope,characterKey:focusVoiceCharacterKey('B.png')},'one'));
  const source={...clip(),chatKey:'private-chat',apiKey:'secret',voice:{voiceId:'voice',apiKey:'never-save'},text:' saved '};
  const record=normalizeFocusLibraryClip(source,scope);source.moments.push('focus:mid');
  assert.equal(record.text,'saved');assert.deepEqual(record.moments,['focus:complete']);
  assert.ok(!('chatKey' in record));assert.ok(!JSON.stringify(record).includes('secret'));assert.ok(!JSON.stringify(record).includes('never-save'));
});
test('unknown schemas, identities and moments cannot silently become usable recordings',()=>{
  for(const patch of [{schemaVersion:2},{characterKey:focusVoiceCharacterKey('B.png')},{namespace:'st-user:other'},{id:'../file'},{text:''},{moments:[]},{moments:['pause']}] ){
    assert.throws(()=>normalizeFocusLibraryClip({...clip(),...patch},scope),undefined,JSON.stringify(patch));
  }
  assert.deepEqual(normalizeFocusLibraryClip({...clip(),moments:[...FOCUS_LIBRARY_MOMENTS,'focus:mid']},scope).moments,[...FOCUS_LIBRARY_MOMENTS]);
});
test('random replay never crosses account, role or moment and prefers not repeating a usable clip',async()=>{
  const rows=[clip('last'),clip('next'),{...clip('wrong-role'),characterKey:focusVoiceCharacterKey('B.png')},{...clip('wrong-account'),namespace:'st-user:other'},{...clip('rest'),moments:['shortBreak:complete']}];
  const calls=[],blob=new Blob(['audio']);
  const pick=createFocusLibraryPicker({list:async()=>rows,readAudio:async(owner,id)=>{calls.push([owner,id]);return {status:'ready',blob};},random:()=>0});
  const result=await pick(scope,'focus:complete',{previousId:'last'});assert.equal(result.clip.id,'next');assert.deepEqual(calls,[[scope,'next']]);assert.equal(result.blob,blob);
});
test('missing or revised audio is skipped without generation, with previous usable clip as last resort',async()=>{
  const calls=[],pick=createFocusLibraryPicker({list:async()=>[clip('last'),clip('gone'),clip('revised')],random:()=>0,
    readAudio:async(owner,id,revision)=>{calls.push([id,revision]);return {status:id==='gone'?'missing':id==='revised'?'conflict':'ready',blob:new Blob(['a'])};}});
  const result=await pick(scope,'focus:complete',{previousId:'last'});assert.equal(result.clip.id,'last');assert.equal(calls.at(-1)[0],'last');assert.equal(calls.length,3);
});
test('empty library is silent; storage failure and scope cancellation are not disguised as emptiness',async()=>{
  let reads=0;const empty=createFocusLibraryPicker({list:async()=>[],readAudio:async()=>{reads++;}});
  assert.deepEqual(await empty(scope,'focus:complete'),{status:'empty'});assert.equal(reads,0);
  const failed=createFocusLibraryPicker({list:async()=>{throw Error('unavailable');}});assert.equal((await failed(scope,'focus:complete')).status,'failed');
  let current=true;const late=createFocusLibraryPicker({list:async()=>[clip()],readAudio:async()=>{current=false;return {status:'ready',blob:new Blob(['a'])};}});
  assert.deepEqual(await late(scope,'focus:complete',{isCurrent:()=>current}),{status:'stale'});
});
test('store construction is lazy and invalid operations never open or migrate shared storage',async()=>{
  let opens=0;const store=createFocusLibraryStore({indexedDB:{open:()=>{opens++;throw Error('must not open');}}});
  assert.equal(opens,0);await assert.rejects(store.save(scope,clip(),new Blob(['x'],{type:'text/html'})),/音频/);
  await assert.rejects(store.save(scope,clip(),new Blob(['x'],{type:'audio/wav'}),{isCurrent:()=>false}),/已变化/);
  assert.equal(opens,0);store.close();await assert.rejects(store.list(scope.namespace),/已变化/);assert.equal(opens,0);
});

test('the selected text and role snapshot cannot change while its audio is loading',async()=>{
  const original=clip();let release,entered;const started=new Promise(r=>entered=r);
  const pick=createFocusLibraryPicker({list:async()=>[original],readAudio:async()=>{entered();return new Promise(r=>release=r);}});
  const pending=pick(scope,'focus:complete');await started;
  original.text='New text';original.characterKey='character:B.png';original.revision=2;
  release({status:'ready',blob:new Blob(['original audio'])});const result=await pending;
  assert.equal(result.clip.text,'这一程做得很好');assert.equal(result.clip.characterKey,scope.characterKey);assert.equal(result.clip.revision,1);
});

test('closing during a blocked database open releases the caller immediately without creating stores later',async()=>{
  const request={},store=createFocusLibraryStore({indexedDB:{open:()=>request}});
  const pending=store.list(scope.namespace);store.close();await assert.rejects(pending,/已变化/);
  let aborted=false;request.transaction={abort:()=>{aborted=true;}};request.onupgradeneeded();assert.equal(aborted,true);
});

test('a database open timeout remains a failure and a late upgrade is aborted',async()=>{
  const request={},store=createFocusLibraryStore({indexedDB:{open:()=>request},timeoutMs:100});
  await assert.rejects(store.list(scope.namespace),error=>error.code==='focus_library_timeout');
  let aborted=false;request.transaction={abort:()=>{aborted=true;}};request.onupgradeneeded();assert.equal(aborted,true);store.close();
});
