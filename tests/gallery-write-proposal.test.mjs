import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {createGalleryWriteProposal,inspectGalleryWriteProposal} from '../qianmu-gallery-write-proposal.js';
import {createHistoricalChatMutation,inspectHistoricalChatMutation} from '../qianmu-historical-chat-journal.js';
import {createNativeHistoricalJournal} from '../qianmu-historical-journal-native.js';
import {collectRestoreStorage,clearRestoreStorage} from '../qianmu-storyboard-restore-storage.js';
import {historicalChatSaveFixture} from './helpers/historical-chat-save-fixture.mjs';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';

// The paged gallery writer that produced these references was retired with the
// archive restore entry. The proposal contract and its journal handling remain
// live, so the inputs here are exact synthetic references instead.
async function setup(t){
  const f=await historicalChatSaveFixture(t),transport=streamCheckpointTransport(f.namespace),journals=[];
  const scope={namespace:f.namespace,ownerKey:'char:'+f.target.avatar,chatKey:f.target.chatId};
  const preparation={sha256:'1'.repeat(64),bytes:4096},write={sha256:'2'.repeat(64),bytes:8192};
  const prepared={reference:preparation,plan:{scope,target:f.target,evidenceDigest:'3'.repeat(64)}};
  const resolved={reference:write,plan:{preparation,scope}};
  const journal=()=>{const value=createNativeHistoricalJournal({createStorage:transport.createStorage,legacy:{
    loadHistoricalChatMutation:async()=>null,loadMutation:async()=>null,list:async()=>[],loadResource:async()=>null,close(){},
  }});journals.push(value);return value;};
  t.after(()=>journals.forEach(value=>value.close()));
  const originalFile=await fs.readFile(f.file),live=JSON.stringify(f.context.chatMetadata);
  return {...f,transport,scope,prepared,resolved,journal,originalFile,live};
}

test('paged proposal shares the real native pending slot, blocks imports, survives reopen and exposes only manager summary',async t=>{
  const f=await setup(t),proposal=createGalleryWriteProposal({prepared:f.prepared,resolved:f.resolved}),row=await createHistoricalChatMutation(proposal),a=f.journal();
  assert.ok(JSON.stringify(row).length<2048);assert.doesNotMatch(JSON.stringify(row),/storyboardImages|snapshot|fixture narrative|prompt/);
  await a.prepareHistoricalChatMutation(row,{confirmed:true});const b=f.journal();assert.deepEqual(await b.loadHistoricalChatMutation(f.namespace),row);
  await assert.rejects(b.assertNoHistoricalChatMutation(f.namespace));await assert.rejects(b.prepareHistoricalChatMutation(row,{confirmed:true}));
  const submitted=await b.updateHistoricalChatMutation(row,'submitted');assert.equal(submitted.revision,2);await assert.rejects(a.updateHistoricalChatMutation(row,'verified'));
  const options={journal:f.journal(),namespace:f.namespace,guard:async()=>true,isCurrent:()=>true,locks:{request:async(_,__,run)=>run({})}},summary=await collectRestoreStorage(options);
  assert.equal(summary.count,1);assert.equal(summary.items[0].fileHash,f.resolved.reference.sha256);assert.doesNotMatch(JSON.stringify(summary),/"proposal"|"preparation"|"scope"|"target"/);
  const selected=summary.items.map(({kind,key,fingerprint})=>({kind,key,fingerprint}));
  assert.equal((await clearRestoreStorage({...options,selected,confirmed:true,recoveryLossAccepted:true})).complete,true);
  assert.equal(await f.journal().loadHistoricalChatMutation(f.namespace),null);assert.deepEqual(await fs.readFile(f.file),f.originalFile);
});

test('legacy host writer fails closed on paged proposal before taking an intent or modifying data',async t=>{
  const f=await setup(t),row=await createHistoricalChatMutation(createGalleryWriteProposal({prepared:f.prepared,resolved:f.resolved})),journal=f.journal();
  await journal.prepareHistoricalChatMutation(row,{confirmed:true});
  const writer=f.open({journal});
  await assert.rejects(writer.recover(),/分页图库恢复记录/);assert.equal(writer.pending(),null);assert.equal(f.saves,0);assert.equal(JSON.stringify(f.context.chatMetadata),f.live);
});

test('proposal validates exact account, owner, target, digests, references and refuses raw bodies',async t=>{
  const f=await setup(t),proposal=createGalleryWriteProposal({prepared:f.prepared,resolved:f.resolved});
  assert.deepEqual(inspectGalleryWriteProposal(proposal),proposal);
  for(const change of [p=>p.namespace='st-user:other',p=>p.target.avatar='Bob.png',p=>p.target.chatId='other',p=>p.fileHash='a'.repeat(64),
    p=>p.write.bytes=200000,p=>p.before={},p=>p.evidenceDigest='invalid',p=>p.scope.ownerKey='group:0']){const bad=structuredClone(proposal);change(bad);assert.throws(()=>inspectGalleryWriteProposal(bad));}
  const row=await createHistoricalChatMutation(proposal);row.proposal.evidenceDigest='d'.repeat(64);await assert.rejects(inspectHistoricalChatMutation(row),/摘要不符/);
});

test('proposal refuses a write plan resolved against a different preparation or scope',async t=>{
  const f=await setup(t);
  assert.throws(()=>createGalleryWriteProposal({prepared:f.prepared,resolved:{...f.resolved,plan:{...f.resolved.plan,preparation:{sha256:'4'.repeat(64),bytes:4096}}}}),/来源不符/);
  assert.throws(()=>createGalleryWriteProposal({prepared:f.prepared,resolved:{...f.resolved,plan:{...f.resolved.plan,scope:{...f.scope,chatKey:'other'}}}}),/来源不符/);
});
