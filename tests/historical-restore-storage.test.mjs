import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { historicalChatSaveFixture } from './helpers/historical-chat-save-fixture.mjs';
import { createHistoricalChatMutation, historicalChatMutationNext } from '../qianmu-historical-chat-journal.js';
import { collectRestoreStorage, clearRestoreStorage, validateRestoreStorageSummary } from '../qianmu-storyboard-restore-storage.js';
import { renderRestoreStorageReview } from '../qianmu-storyboard-restore-storage-view.js';
import { vibeDigest } from '../qianmu-vibe-file.js';
import { createPackageImportFixture } from './helpers/storyboard-package-fixture.mjs';
import { storyboardFunctionSource } from './helpers/storyboard-form-fixture.mjs';
const consent={confirmed:true,recoveryLossAccepted:true}, pick=row=>({kind:row.kind,key:row.key,fingerprint:row.fingerprint});
async function fixture(t) {
  const f=await historicalChatSaveFixture(t); f.row=await createHistoricalChatMutation(f.proposal,{now:()=>5}); f.deleted=0;f.locks=[];
  const journal={list:async()=>[],loadMutation:async()=>null,loadResource:async()=>null,
    loadHistoricalChatMutation:async()=>structuredClone(f.row),
    dismissHistoricalChatMutation:async(row,options)=>{assert.equal(options.confirmed,true);assert.ok(options.isCurrent());assert.deepEqual(row,f.row);f.row=null;f.deleted++;},
    dismissMutation:()=>assert.fail('wrong store'),dismissCheckpoint:()=>assert.fail('wrong store'),dismissResource:()=>assert.fail('wrong store')};
  f.storage={journal,namespace:f.namespace,guard:async()=>{if(!f.active)throw Error('closed');},isCurrent:()=>f.active,
    locks:{request:async(name,_options,run)=>{f.locks.push(name);return run(f.locked?null:{});}}};
  return f;
}
test('new historical pending row is counted exactly once without exposing raw before/after or source names',async t=>{
  const f=await fixture(t),summary=await collectRestoreStorage(f.storage),row=summary.items[0];
  assert.equal(summary.count,1);assert.equal(summary.bytes,Buffer.byteLength(JSON.stringify(f.row)));assert.equal(row.kind,'historical-chat');assert.equal(row.key,f.namespace);
  assert.equal(row.fileHash,f.row.proposal.fileHash);assert.equal(row.targetHash,await vibeDigest(JSON.stringify(f.row.proposal.target)));assert.equal(row.chatHash,'');
  assert.deepEqual(validateRestoreStorageSummary(summary,f.namespace),summary);
  assert.doesNotMatch(JSON.stringify(summary),/storyboardImages|characterDrafts|silver hair|original extension|PRIVATE_|"before"|"after"/);
  assert.ok(!JSON.stringify(summary).includes(f.proposal.target.avatar));assert.equal(f.deleted,0);
});
test('record bytes include raw character drafts and unknown fields but not the referenced files',async t=>{
  const f=await fixture(t),first=await collectRestoreStorage(f.storage),proposal=structuredClone(f.proposal);
  proposal.after.characterDrafts.items[0].future.note+=' '.repeat(4096);f.row=await createHistoricalChatMutation(proposal,{now:()=>5});
  const second=await collectRestoreStorage(f.storage);assert.equal(second.bytes-first.bytes,4096);assert.equal(second.count,1);
});
test('same chat name on different characters has distinct exact-target summary and no current-chat guess',async t=>{
  const f=await fixture(t),left=await collectRestoreStorage(f.storage);f.row=await createHistoricalChatMutation({...f.proposal,target:{...f.proposal.target,avatar:'Other.png'}});
  const right=await collectRestoreStorage(f.storage);assert.notEqual(left.items[0].targetHash,right.items[0].targetHash);
  const html=renderRestoreStorageReview({summary:right,busy:false,selected:new Set(),accepted:false,chatHash:right.items[0].targetHash},String);
  assert.match(html,/原聊天定位/);assert.doesNotMatch(html,/当前聊天|账户级角色库/);
});
test('all four historical phases have precise labels and verified never claims originals restored',async t=>{
  const f=await fixture(t);
  for(const phase of ['prepared','submitted','uncertain','verified']){
    if(phase!=='prepared')f.row=historicalChatMutationNext(f.row,phase,6);
    const summary=await collectRestoreStorage(f.storage);assert.doesNotThrow(()=>validateRestoreStorageSummary(summary,f.namespace));
    const html=renderRestoreStorageReview({summary,busy:false,selected:new Set(),accepted:false},String);
    assert.match(html,/原聊天恢复记录|只在此浏览器|失去中断核对/);assert.doesNotMatch(html,/undefined|原件已核对/);
    if(phase==='verified')assert.match(html,/聊天资料已核对；原件仍需检查/);
  }
});
test('explicit end removes only the selected local record while native chat bytes and live metadata stay intact',async t=>{
  const f=await fixture(t),before=await fs.readFile(f.file),metadata=structuredClone(f.context.chatMetadata);
  const selected=(await collectRestoreStorage(f.storage)).items.map(pick),result=await clearRestoreStorage({...f.storage,...consent,selected});
  assert.equal(result.complete,true);assert.equal(f.deleted,1);assert.equal((await collectRestoreStorage(f.storage)).count,0);assert.equal(f.saves,0);
  assert.deepEqual(await fs.readFile(f.file),before);assert.deepEqual(f.context.chatMetadata,metadata);
  assert.deepEqual(f.locks,[`qianmu:package-import:${f.namespace}`,`qianmu:character-restore:${f.namespace}`]);
});
test('missing separate loss consent, forged selection and duplicate choices never dismiss a row',async t=>{
  const f=await fixture(t),selected=(await collectRestoreStorage(f.storage)).items.map(pick);
  for(const patch of [{confirmed:false},{recoveryLossAccepted:false},{selected:[...selected,...selected]},
    {selected:[{...selected[0],key:'st-user:bob'}]},{selected:[{...selected[0],kind:'configuration'}]},
    {selected:[{...selected[0],targetHash:'a'.repeat(64)}]},{selected:[{...selected[0],fingerprint:'f'.repeat(64)}]}]){
    await assert.rejects(clearRestoreStorage({...f.storage,...consent,selected,...patch}));assert.equal(f.deleted,0);
  }
});
test('stale inspection after a phase/revision update cannot end a newer operation',async t=>{
  const f=await fixture(t),selected=(await collectRestoreStorage(f.storage)).items.map(pick);
  f.row=historicalChatMutationNext(f.row,'submitted',6);await assert.rejects(clearRestoreStorage({...f.storage,...consent,selected}),/已变化/);assert.equal(f.deleted,0);
});
test('CAS stops a change between fresh selection validation and actual record dismissal',async t=>{
  const f=await fixture(t),selected=(await collectRestoreStorage(f.storage)).items.map(pick),dismiss=f.storage.journal.dismissHistoricalChatMutation;
  f.storage.journal.dismissHistoricalChatMutation=async(...args)=>{f.row=historicalChatMutationNext(f.row,'submitted',6);return dismiss(...args);};
  const result=await clearRestoreStorage({...f.storage,...consent,selected});assert.equal(result.complete,false);assert.equal(result.removed.length,0);assert.equal(result.remaining,1);assert.equal(f.deleted,0);
});
test('account change or active restore lock stops historical record closure',async t=>{
  const f=await fixture(t),selected=(await collectRestoreStorage(f.storage)).items.map(pick);
  f.locked=true;await assert.rejects(clearRestoreStorage({...f.storage,...consent,selected}),/另一页面/);f.locked=false;f.active=false;
  await assert.rejects(clearRestoreStorage({...f.storage,...consent,selected}),/页面/);assert.equal(f.deleted,0);
});
test('old journal adapters, corrupt records and mismatched namespaces fail closed rather than reporting empty',async t=>{
  const f=await fixture(t),load=f.storage.journal.loadHistoricalChatMutation;delete f.storage.journal.loadHistoricalChatMutation;
  await assert.rejects(collectRestoreStorage(f.storage));f.storage.journal.loadHistoricalChatMutation=load;
  f.row.proposalDigest='c'.repeat(64);await assert.rejects(collectRestoreStorage(f.storage));assert.equal(f.deleted,0);
  f.row=await createHistoricalChatMutation(f.proposal);await assert.rejects(collectRestoreStorage({...f.storage,namespace:'st-user:bob'}),/账户/);
});
test('worker summary validation rejects source leaks and cross-kind or incomplete historical descriptors',async t=>{
  const f=await fixture(t),good=await collectRestoreStorage(f.storage);
  for(const patch of [{targetHash:undefined},{targetHash:'bad'},{chatHash:'a'.repeat(64)},{phase:'assets_ready'},{proposal:f.proposal},
    {key:JSON.stringify([f.namespace,'historical-chat'])},{kind:'configuration'},{kind:'bundle'}]){
    const bad=structuredClone(good);Object.assign(bad.items[0],patch);assert.throws(()=>validateRestoreStorageSummary(bad,f.namespace));
  }
});
test('manager starts unselected, explains recovery loss, and renders no raw or executable user data',async t=>{
  const f=await fixture(t),summary=await collectRestoreStorage(f.storage),html=renderRestoreStorageReview({summary,busy:false,selected:new Set(),accepted:false,notice:'<img onerror=alert(1)>'},String);
  assert.match(html,/data-restore-storage="clear" disabled/);assert.doesNotMatch(html,/ checked|<img|PRIVATE_|silver hair/);
  assert.match(html,/不会删除服务器聊天或原图/);assert.match(html,/对应引用的续接依据/);assert.match(html,/&lt;img/);
});

test('actual check-import action directs historical pending records to existing data management instead of claiming empty',async()=>{
  const f=createPackageImportFixture();f.e.historical=true;await f.recover();
  assert.match(f.e.notices[0][0],/原聊天恢复记录.*数据管理/);assert.doesNotMatch(f.e.notices[0][0],/没有待核对/);
  assert.deepEqual(f.e.events,[]);assert.equal(f.context.storyboardImportPackage.busy,false);
});
test('legacy JSON and bundle paths gate historical pending intent before reading/importing another package',async()=>{
  const f=createPackageImportFixture();f.e.historical=true;await f.import(new Blob(['invalid package that must never be read']));
  assert.match(f.e.notices[0][0],/原聊天恢复记录/);assert.deepEqual(f.e.events,[]);
  const bundle=storyboardFunctionSource('storyboardImportBundle');
  assert.ok(bundle.indexOf('assertNoHistoricalChatMutation')<bundle.indexOf('openStoryboardBundleReview'));
  assert.ok(bundle.indexOf('assertNoHistoricalChatMutation')<bundle.indexOf('createStoryboardBundleConfiguration'));
});
