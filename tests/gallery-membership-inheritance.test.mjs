import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../qianmu-storyboard.js';
import {galleryMembershipSnapshot,galleryMembershipChange} from '../qianmu-gallery-membership.js';
import {storyboardFunctionSource as fn} from './helpers/storyboard-form-fixture.mjs';

const ids=(n=140)=>Array.from({length:n},(_,i)=>'collection-'+i);
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(){
  const record={id:'image',collectionIds:ids(),collectionId:'legacy-primary'},log={id:'log',recordId:'image',snapshot:{source:'novel',target:'gallery',chatKey:'chat',profile:{model:'nai-diffusion-5-full'},payload:{prompt:'test'},connection:{baseUrl:'https://fixture.invalid',credentialId:'local-reference'}}};
  const state={logs:[log]},e={record,log,records:[record],jobs:[],guards:[],chatKey:'chat'};
  const c=vm.createContext({...core,galleryMembershipSnapshot,clone:structuredClone,uid:()=> 'new',uniqueClean:values=>[...new Set(values)],
    storyboardState:()=>state,getChatKey:()=>e.chatKey,storyboardGalleryRecords:()=>e.records,storyboardGalleryGroupId:()=> 'root',
    storyboardQueueJob:(job,guard)=>{e.jobs.push(job);e.guards.push(guard);return guard();},toast:()=>false,
    storyboardLoadLogToWorkbench:()=>{},storyboardFloorTakeReceipts:()=>[],hashText:()=> 'hash'});
  vm.runInContext(['storyboardJobFromLog','storyboardRetryLog','storyboardCreateRecord'].map(fn).join('\n'),c);e.c=c;return e;
}
test('snapshot inheritance preserves full IDs, legacy primary, empty and independent arrays',()=>{
  const record={collectionIds:ids(),collectionId:'legacy'},value=galleryMembershipSnapshot(record);
  assert.deepEqual(value.collectionIds,[...ids(),'legacy']);assert.equal(value.collectionId,'legacy');
  value.collectionIds.push('new');assert.equal(record.collectionIds.length,140);
  assert.deepEqual(galleryMembershipSnapshot({collectionId:'one'}),{collectionId:'one',collectionIds:['one']});
  assert.deepEqual(galleryMembershipSnapshot({}),{collectionId:'',collectionIds:[]});
  assert.throws(()=>galleryMembershipChange(record,'new',true),/最多归入 30/);
});
test('typed snapshot preservation bypasses only generic array clipping, not validation',()=>{
  const original={source:'novel',collectionIds:ids(),collectionId:'legacy',unrelated:ids()};
  const saved=core.sanitizeStoryboardSnapshot(original);
  assert.equal(saved.collectionIds.length,141);assert.equal(saved.unrelated.length,100);assert.equal(original.collectionIds.length,140);
  assert.deepEqual(galleryMembershipSnapshot(saved),galleryMembershipSnapshot(original));
  const state=core.createStoryboardDefaults();state.logs=[{id:'log',source:'novel',status:'failed',snapshot:saved}];core.normalizeStoryboardState(state);
  assert.deepEqual(state.logs[0].snapshot.collectionIds,saved.collectionIds);
  for(const collectionIds of [ids(10001),['x'.repeat(241)],['bad\nvalue']])assert.throws(()=>core.sanitizeStoryboardSnapshot({collectionIds}),/未截断/);
});
test('actual retry -> saved snapshot -> restored job -> new record retains all inherited memberships',async()=>{
  const e=fixture(),before=plain(e.record);assert.equal(await e.c.storyboardRetryLog(e.log),true);
  const saved=core.sanitizeStoryboardSnapshot(e.jobs[0]);assert.equal(saved.collectionIds.length,141);
  const restored=e.c.storyboardJobFromLog({...e.log,snapshot:saved});
  const result=e.c.storyboardCreateRecord(restored,{snapshot:saved},'/fixture.png',0,{floor:null,message:null,valid:false},{});
  assert.deepEqual(plain(result.collectionIds),[...ids(),'legacy-primary']);assert.equal(result.collectionId,'legacy-primary');assert.deepEqual(e.record,before);
  result.collectionIds.pop();assert.equal(restored.collectionIds.length,141);assert.equal(e.record.collectionIds.length,140);
});
for(const changed of ['membership','replacement','chat'])test(`retry guard refuses changed ${changed} before submission`,async()=>{
  const e=fixture();assert.equal(await e.c.storyboardRetryLog(e.log),true);assert.equal(e.guards[0](),true);
  if(changed==='membership')e.record.collectionIds.push('later');else if(changed==='replacement')e.records=[{...e.record}];else e.chatKey='other';
  assert.equal(e.guards[0](),false);
});
test('retry without surviving image retains the full saved job membership',async()=>{
  const e=fixture();e.records=[];Object.assign(e.log.snapshot,galleryMembershipSnapshot(e.record));
  assert.equal(await e.c.storyboardRetryLog(e.log),true);assert.equal(e.jobs[0].collectionIds.length,141);
});
