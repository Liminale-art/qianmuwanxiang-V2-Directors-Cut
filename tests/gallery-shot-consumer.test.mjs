import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {createGalleryShotReader} from '../qianmu-gallery-shot-reader.js';
import {captureCurrentChatSource} from '../qianmu-current-chat-source.js';
import {normalizeStoryboardShotSpec} from '../qianmu-storyboard.js';
import * as drafts from '../qianmu-video-draft.js';
import {storyboardFunctionSource as fn} from './helpers/storyboard-form-fixture.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function until(check){for(let i=0;i<30&&!check();i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(check(),true);}
const original=id=>({id:'shot-'+id,characters:[{id:'a',name:'Original A',identity:['red hair']}],future:{keep:['',false,0,null],whole:'x'.repeat(26000)}});
function fixture(){
  const rows=['one','two'].map(id=>({id,chatKey:'chat',createdAt:1,source:'comfy',url:'/user/images/'+id+'.png',snapshotServerRef:{version:1}}));
  const events=new EventEmitter(),host={chatId:'chat',characterId:0,characters:[{avatar:'A.png',chat:'chat'}],chat:[],chatMetadata:{story_director_liminale:{storyboardImages:rows}},eventSource:events};
  const e={rows,host,events,reads:[],html:[],shots:[],workOrders:[],warnings:[],removed:0,
    read:async record=>({shotSpec:original(record.id)}),work:async()=>{},runtime:async()=>({draftModule:drafts,store:{load:async id=>drafts.createVideoDraftFromStoryboardFrame(rows.find(row=>row.id===id),{chatKey:'chat',now:1,clientNonce:id})}})};
  const c=vm.createContext({createGalleryShotReader,captureCurrentChatSource,normalizeStoryboardShotSpec,Set,Map,Number,String,Object,Array,
    storyboardSnapshotEpoch:0,storyboardVideoDraftOpenSequence:0,storyboardVideoDraftEditorEl:null,storyboardVideoDraftEditor:null,
    getChatKey:()=>host.chatId,ctx:()=>host,storyboardGalleryRecords:()=>e.rows,storyboardState:()=>({shotPlans:[]}),
    storyboardReadSnapshotForRecord:async record=>{e.reads.push(record.id);return e.read(record);},
    storyboardEnsureVideoDraftRuntime:()=>e.runtime(),storyboardDirectorWorkOrderForRecord:async record=>{e.workOrders.push(record.id);return e.work(record);},
    storyboardVideoDraftCandidateRecords:()=>e.rows,storyboardSafeUrl:value=>value||'',htmlEscape:value=>String(value??''),
    STORYBOARD_VIDEO_DRAFT_MODE_LABELS:{auto:'自动'},STORYBOARD_VIDEO_REFERENCE_ROLE_LABELS:{subject_reference:'主体'},
    storyboardVideoOperationIssueLabel:value=>value,toast:message=>e.warnings.push(message),
    document:{createElement(){return {set innerHTML(value){e.html.push(value);throw Error('fixture_render_boundary');}};}}});
  vm.runInContext(['storyboardCloseVideoDraftEditor','storyboardVideoDraftSourceRecord','storyboardVideoDraftShotReader','storyboardVideoDraftEditorMarkup','storyboardOpenVideoDraftEditor'].map(fn).join('\n'),c);
  const markup=c.storyboardVideoDraftEditorMarkup;c.storyboardVideoDraftEditorMarkup=(draft,shot)=>{e.shots.push(structuredClone(shot));return markup(draft,shot);};
  e.c=c;e.open=id=>c.storyboardOpenVideoDraftEditor(id||'one');e.listenerCount=()=>events.eventNames().reduce((n,event)=>n+events.listenerCount(event),0);return e;
}

// Run the actual opening path and actual markup. Stop at DOM insertion so these
// tests cannot enter any frozen readiness, pricing, prompt or generation path.
test('actual opening waits for the one selected original before rendering character bindings',async()=>{
  const e=fixture(),gate=deferred();e.read=()=>gate.promise;const pending=e.open();await until(()=>e.reads.length===1);
  assert.equal(e.html.length,0);assert.equal(e.workOrders.length,0);assert.ok(e.listenerCount()>0);
  gate.resolve({shotSpec:original('one')});await pending;assert.deepEqual(e.shots,[original('one')]);assert.equal(e.html.length,1);
  assert.match(e.html[0],/Original A/);assert.deepEqual(e.workOrders,['one']);assert.equal(e.listenerCount(),0);
  assert.equal(Object.hasOwn(e.rows[0],'shotSpec'),false);assert.deepEqual(e.warnings,['fixture_render_boundary']);
});
test('closing while an original is loading cannot reopen the old editor',async()=>{
  const e=fixture(),gate=deferred();e.read=()=>gate.promise;const pending=e.open();await until(()=>e.reads.length===1);
  e.c.storyboardCloseVideoDraftEditor();gate.resolve({shotSpec:original('one')});await pending;
  assert.equal(e.html.length,0);assert.equal(e.workOrders.length,0);assert.equal(e.listenerCount(),0);assert.equal(e.warnings.length,0);
});
test('switching host scope during original reads prevents old markup',async()=>{
  for(const mode of ['epoch','metadata','event']){
    const e=fixture(),gate=deferred();e.read=()=>gate.promise;const pending=e.open();await until(()=>e.reads.length===1);
    if(mode==='epoch')e.c.storyboardSnapshotEpoch++;if(mode==='metadata')e.host.chatMetadata={};if(mode==='event')e.events.emit('chat_changed');
    gate.resolve({shotSpec:original('one')});await pending;assert.equal(e.html.length,0,mode);assert.equal(e.workOrders.length,0);assert.equal(e.listenerCount(),0);
  }
});
test('a superseded opener cannot render or close the newer editor when its old read resolves',async()=>{
  const e=fixture(),first=deferred(),second=deferred();e.read=record=>record.id==='one'?first.promise:second.promise;
  const a=e.open('one');await until(()=>e.reads.length===1);const b=e.open('two');await until(()=>e.reads.length===2);
  second.resolve({shotSpec:original('two')});await b;const marker={remove(){e.removed++;}};e.c.storyboardVideoDraftEditorEl=marker;
  first.resolve({shotSpec:original('one')});await a;assert.deepEqual(e.shots,[original('two')]);assert.equal(e.removed,0);
  assert.equal(e.c.storyboardVideoDraftEditorEl,marker);assert.equal(e.listenerCount(),0);
});
test('an older failed read cannot close another active editor or emit its stale warning',async()=>{
  const e=fixture(),gate=deferred();e.read=record=>record.id==='one'?gate.promise:Promise.resolve({shotSpec:original('two')});
  const pending=e.open('one');await until(()=>e.reads.length===1);await e.open('two');const warnings=e.warnings.length;
  const marker={remove(){e.removed++;}};e.c.storyboardVideoDraftEditorEl=marker;gate.reject(Error('old failed'));await pending;
  assert.equal(e.c.storyboardVideoDraftEditorEl,marker);assert.equal(e.removed,0);assert.equal(e.warnings.length,warnings);assert.equal(e.listenerCount(),0);
});
test('editing the selected image during existing work-order validation invalidates the prepared shot',async()=>{
  const e=fixture(),gate=deferred();e.work=()=>gate.promise;const pending=e.open();await until(()=>e.workOrders.length===1);
  e.rows[0].future='newer image edit';gate.resolve();await pending;assert.equal(e.html.length,0);assert.equal(e.listenerCount(),0);assert.match(e.warnings[0],/资料已变化/);
});
test('closing during the existing runtime load never starts original reading',async()=>{
  const e=fixture(),gate=deferred(),runtime=e.runtime;e.runtime=()=>gate.promise;const pending=e.open();e.c.storyboardCloseVideoDraftEditor();
  gate.resolve(await runtime());await pending;assert.equal(e.reads.length,0);assert.equal(e.html.length,0);assert.equal(e.listenerCount(),0);assert.equal(e.warnings.length,0);
});
