import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {galleryPreparedAssetsFixture as fixture} from './helpers/gallery-prepared-assets-fixture.mjs';
import {createGalleryWritePlanStorage,galleryRecipeResolution} from '../qianmu-gallery-write-plan.js';
import {resolvePreparedGalleryWrite,readResolvedGalleryWrite,scanResolvedGalleryWrite} from '../qianmu-gallery-resolved-write.js';
import {createGalleryWriteProposal,inspectGalleryWriteProposal} from '../qianmu-gallery-write-proposal.js';
import {createHistoricalChatMutation,inspectHistoricalChatMutation} from '../qianmu-historical-chat-journal.js';
import {createNativeHistoricalJournal} from '../qianmu-historical-journal-native.js';
import {createHistoricalChatSaveSession} from '../qianmu-historical-chat-save.js';
import {collectRestoreStorage,clearRestoreStorage} from '../qianmu-storyboard-restore-storage.js';
import {chatGalleryDigest} from '../qianmu-chat-gallery-digest.js';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';

async function setup(t,options){
  const f=await fixture(t,options);
  const storage=()=>createGalleryWritePlanStorage({scope:f.selection.scope,guard:f.options.guard,createStorage:f.transport.createStorage}).then(f.own);
  const verifyCurrent=async()=>f.state.active&&JSON.stringify(f.context.chatMetadata)===f.live&&(await fs.readFile(f.file)).equals(f.originalFile);
  const base={source:f.source,guard:f.options.guard,verifyCurrent};
  const resolve=async(extra={})=>{const assets=f.open(),preview=await assets.preview();return resolvePreparedGalleryWrite({...base,assets,preview,confirmed:true,writeStorage:await storage(),...extra});};
  const journal=()=>f.own(createNativeHistoricalJournal({createStorage:f.transport.createStorage,legacy:{
    loadHistoricalChatMutation:async()=>null,loadMutation:async()=>null,list:async()=>[],loadResource:async()=>null,close(){},
  }}));
  return {...f,base,storage,resolve,journal};
}

test('real file restore publishes a reference-only plan; independent read reconstructs exact ordered records, not a chat save',async t=>{
  const f=await setup(t);await fs.unlink(f.recipePath);await fs.unlink(f.image);
  const result=await f.resolve();assert.equal(result.proof,'write-plan-readback-only');assert.equal(result.metadataRestored,false);assert.equal(result.canPrune,false);
  assert.equal(result.originalsVerified,1);assert.equal(result.recipesResolved,1);
  const reopened=await readResolvedGalleryWrite({reference:result.reference,source:f.source,writeStorage:await f.storage(),guard:f.options.guard}),records=[];
  await scanResolvedGalleryWrite({source:f.source,resolutions:reopened.resolutions,guard:f.options.guard,visit:row=>records.push(row)});
  const expected=structuredClone(f.rows);expected[0].snapshotServerRef=reopened.resolutions[0].reference;
  assert.deepEqual(records,expected);assert.notEqual(expected[0].snapshotServerRef.id,f.rows[0].snapshotServerRef.id);
  assert.deepEqual(chatGalleryDigest(records),result.plan.gallery);assert.equal('snapshot' in records[0],false);
  assert.equal(JSON.stringify(f.context.chatMetadata),f.live);assert.deepEqual(await fs.readFile(f.file),f.originalFile);
  const files=[...f.transport.files.values()].map(text=>JSON.parse(text)).filter(doc=>doc.value?.schema?.startsWith('qianmu.gallery.write-'));
  assert.ok(files.length>=2);assert.doesNotMatch(JSON.stringify(files),/fixture narrative|original"|"snapshot"|"storyboardImages"|"future"/);
  const uploads=f.transport.calls.filter(c=>c.path==='/api/files/upload').length;
  await readResolvedGalleryWrite({reference:result.reference,source:f.source,writeStorage:await f.storage(),guard:f.options.guard});
  assert.equal(f.transport.calls.filter(c=>c.path==='/api/files/upload').length,uploads);
});

test('inline and empty sources persist no override pages; no generation or metadata writes',async t=>{
  for(const count of [0,2]){const f=await setup(t,{count,serverRecipe:false}),result=await f.resolve();
    assert.equal(result.plan.resolutions,0);assert.deepEqual(result.plan.pages,[]);assert.deepEqual(result.plan.gallery,chatGalleryDigest(f.rows));
    assert.equal(JSON.stringify(f.context.chatMetadata),f.live);assert.equal(f.calls.some(c=>/restore\/restore|recipe\/restore/.test(c.url)),false);
  }
});

test('missing, extra, duplicate and different-content recipe resolutions cannot produce a verified digest',async t=>{
  const f=await setup(t),result=await f.resolve(),read=await readResolvedGalleryWrite({reference:result.reference,source:f.source,writeStorage:await f.storage(),guard:f.options.guard});
  const row=read.resolutions[0],invalid=[[],[row,row],[{...row,recordId:'unknown'}],[{...row,createdAt:999}],[{...row,record:{sha256:'f'.repeat(64),bytes:row.record.bytes}}]];
  for(const resolutions of invalid)await assert.rejects(scanResolvedGalleryWrite({source:f.source,resolutions,guard:f.options.guard}));
  const changed=structuredClone(row);changed.reference.sha256='a'.repeat(64);changed.reference.id=changed.reference.sha256+changed.reference.id.slice(64);
  assert.throws(()=>galleryRecipeResolution(changed),/不得更改/);assert.equal(JSON.stringify(f.context.chatMetadata),f.live);
});

test('caller mutations cannot change detached resolution rows across asynchronous scans',async t=>{
  const f=await setup(t),result=await f.resolve(),read=await readResolvedGalleryWrite({reference:result.reference,source:f.source,writeStorage:await f.storage(),guard:f.options.guard});
  const resolutions=structuredClone(read.resolutions),work=scanResolvedGalleryWrite({source:f.source,resolutions,guard:f.options.guard});resolutions[0].recordId='mutated';
  assert.deepEqual((await work).gallery,result.plan.gallery);
});

test('missing confirmation never starts asset or plan writes',async t=>{
  const f=await setup(t),storage=await f.storage(),start=f.transport.files.size,calls=f.calls.length;
  await assert.rejects(resolvePreparedGalleryWrite({...f.base,writeStorage:storage,confirmed:false,assets:{restore(){assert.fail('not authorized');}},preview:{ready:true}}),/确认/);
  assert.equal(f.transport.files.size,start);assert.equal(f.calls.length,calls);
});

test('lost plan acknowledgement retains restored files and immutable plan, never retries or edits current chat',async t=>{
  const f=await setup(t);await fs.unlink(f.image);let lost=0;
  f.transport.hook=({path,options,files})=>{if(path==='/api/files/upload'){const {name,data}=JSON.parse(options.body);
    const text=Buffer.from(data,'base64').toString();
    if(name.includes('-gallery-write-plan-')&&JSON.parse(text).schema==='qianmu.st-account-head.v1'){files.set(name,text);lost++;throw Error('lost plan acknowledgement');}}};
  await assert.rejects(f.resolve());assert.equal(lost,1);assert.deepEqual(await fs.readFile(f.image),f.png);assert.deepEqual(await fs.readFile(f.file),f.originalFile);
  f.transport.hook=null;const count=f.transport.files.size;const result=await f.resolve();assert.equal(result.metadataRestored,false);assert.equal(f.transport.files.size,count);
});

test('changed baseline before publication preserves file copies but returns no successful write plan',async t=>{
  const f=await setup(t);await assert.rejects(f.resolve({onProgress:()=>{f.store.unrelated='edited';}}),/聊天或归档已变化/);
  assert.equal(f.store.unrelated,'edited');assert.ok(![...f.transport.files.values()].some(text=>JSON.parse(text).value?.schema==='qianmu.gallery.write-plan.v1'));
  assert.deepEqual(await fs.readFile(f.file),f.originalFile);
});

test('missing/corrupt persisted override pages are not silently rebuilt or treated as empty',async t=>{
  for(const corrupt of [false,true]){const f=await setup(t),result=await f.resolve();
    const key=[...f.transport.files].find(([,text])=>JSON.parse(text).value?.schema==='qianmu.gallery.write-page.v1')[0];
    corrupt?f.transport.files.set(key,f.transport.files.get(key).replace('record-2','record-X')):f.transport.files.delete(key);
    const writes=f.transport.calls.filter(c=>c.path==='/api/files/upload').length;
    await assert.rejects(readResolvedGalleryWrite({reference:result.reference,source:f.source,writeStorage:await f.storage(),guard:f.options.guard}));
    assert.equal(f.transport.calls.filter(c=>c.path==='/api/files/upload').length,writes);
  }
});

test('paged proposal shares the real native pending slot, blocks imports, survives reopen and exposes only manager summary',async t=>{
  const f=await setup(t),resolved=await f.resolve(),proposal=createGalleryWriteProposal({prepared:f.source.metadata,resolved}),row=await createHistoricalChatMutation(proposal),a=f.journal();
  assert.ok(JSON.stringify(row).length<2048);assert.doesNotMatch(JSON.stringify(row),/storyboardImages|snapshot|fixture narrative|prompt/);
  await a.prepareHistoricalChatMutation(row,{confirmed:true});const b=f.journal();assert.deepEqual(await b.loadHistoricalChatMutation(f.account),row);
  await assert.rejects(b.assertNoHistoricalChatMutation(f.account));await assert.rejects(b.prepareHistoricalChatMutation(row,{confirmed:true}));
  const submitted=await b.updateHistoricalChatMutation(row,'submitted');assert.equal(submitted.revision,2);await assert.rejects(a.updateHistoricalChatMutation(row,'verified'));
  const options={journal:f.journal(),namespace:f.account,guard:async()=>true,isCurrent:()=>true,locks:{request:async(_,__,run)=>run({})}},summary=await collectRestoreStorage(options);
  assert.equal(summary.count,1);assert.equal(summary.items[0].fileHash,resolved.reference.sha256);assert.doesNotMatch(JSON.stringify(summary),/"proposal"|"preparation"|"scope"|"target"/);
  const selected=summary.items.map(({kind,key,fingerprint})=>({kind,key,fingerprint}));
  assert.equal((await clearRestoreStorage({...options,selected,confirmed:true,recoveryLossAccepted:true})).complete,true);
  assert.equal(await f.journal().loadHistoricalChatMutation(f.account),null);assert.deepEqual(await fs.readFile(f.file),f.originalFile);
});

test('legacy host writer fails closed on paged proposal before taking an intent or modifying data',async t=>{
  const f=await setup(t),resolved=await f.resolve(),row=await createHistoricalChatMutation(createGalleryWriteProposal({prepared:f.source.metadata,resolved})),journal=f.journal();
  await journal.prepareHistoricalChatMutation(row,{confirmed:true});let saves=0;f.context.saveMetadata=()=>{saves++;};
  const writer=f.own(createHistoricalChatSaveSession({...f.options,namespace:f.account,journal}));
  await assert.rejects(writer.recover(),/分页图库恢复记录/);assert.equal(writer.pending(),null);assert.equal(saves,0);assert.equal(JSON.stringify(f.context.chatMetadata),f.live);
});

test('proposal validates exact account, owner, target, digests, references and refuses raw bodies',async t=>{
  const f=await setup(t),resolved=await f.resolve(),proposal=createGalleryWriteProposal({prepared:f.source.metadata,resolved});
  assert.deepEqual(inspectGalleryWriteProposal(proposal),proposal);
  for(const change of [p=>p.namespace='st-user:other',p=>p.target.avatar='Bob.png',p=>p.target.chatId='other',p=>p.fileHash='a'.repeat(64),
    p=>p.write.bytes=200000,p=>p.before={},p=>p.evidenceDigest='invalid',p=>p.scope.ownerKey='group:0']){const bad=structuredClone(proposal);change(bad);assert.throws(()=>inspectGalleryWriteProposal(bad));}
  const row=await createHistoricalChatMutation(proposal);row.proposal.evidenceDigest='d'.repeat(64);await assert.rejects(inspectHistoricalChatMutation(row),/摘要不符/);
});

test('reference-only pages cover over 400 large records without the legacy aggregate limit',async t=>{
  const scope={namespace:'st-user:large',ownerKey:'char:Alice.png',chatKey:'chat'},transport=streamCheckpointTransport(scope.namespace),storage=await createGalleryWritePlanStorage({scope,guard:()=>true,createStorage:transport.createStorage});t.after(()=>storage.close());
  const rows=Array.from({length:451},(_,i)=>({id:'record-'+i,createdAt:i,url:'/user/images/test.png',future:'x'.repeat(5000),
    snapshotServerRef:{version:1,id:'a'.repeat(64)+'-00000000-0000-4000-8000-000000000000',sha256:'a'.repeat(64),bytes:500}}));
  const refs=rows.map((_,i)=>({sha256:i.toString(16).padStart(64,'0'),bytes:6000})),reference={sha256:'c'.repeat(64),bytes:1000};
  const source={metadata:{reference,plan:{scope,gallery:{count:rows.length}}},scan:async({visit})=>{for(let i=0;i<rows.length;i++)await visit({record:rows[i],reference:refs[i],origin:'source',outputIndex:i,kept:false});}};
  const resolutions=rows.map((row,i)=>({recordId:row.id,createdAt:row.createdAt,record:refs[i],originalReference:row.snapshotServerRef,reference:row.snapshotServerRef})),pages=[];
  for(let i=0;i<resolutions.length;i+=128)pages.push(await storage.stagePage(resolutions.slice(i,i+128),i));
  const checked=await scanResolvedGalleryWrite({source,resolutions,guard:()=>true});assert.ok(checked.gallery.bytes>2*1048576);
  const stored=await storage.publish({preparation:reference,gallery:checked.gallery,pages,resolutions:resolutions.length},{verify:async()=>true});assert.equal(stored.plan.pages.length,4);
  const read=await readResolvedGalleryWrite({reference:stored.reference,source,writeStorage:storage,guard:()=>true});assert.equal(read.resolutions.length,451);
  assert.ok([...transport.files.values()].every(text=>Buffer.byteLength(text)<128*1024));assert.doesNotMatch([...transport.files.values()].join(''),/"future"/);
});

test('kept duplicate receives its repaired reference in place; unrelated current records stay exact',async t=>{
  const f=await setup(t),result=await f.resolve(),resolved=await readResolvedGalleryWrite({reference:result.reference,source:f.source,writeStorage:await f.storage(),guard:f.options.guard});
  const duplicate=await f.source.readSelected(0),incoming=await f.source.readSelected(1),unique={id:'current-only',createdAt:100,url:'/user/images/current.png',unknown:[0,false,null]};
  const source={metadata:{plan:{gallery:{count:3}}},scan:async({visit})=>{
    await visit({...duplicate,origin:'baseline',outputIndex:0,kept:false});
    await visit({record:unique,origin:'baseline',outputIndex:1,kept:false});
    await visit({...duplicate,origin:'source',outputIndex:0,kept:true});
    await visit({...incoming,origin:'source',outputIndex:2,kept:false});
  }},out=[];
  await scanResolvedGalleryWrite({source,resolutions:resolved.resolutions,guard:()=>true,visit:row=>out.push(row)});
  assert.deepEqual(out.map(row=>row.id),[duplicate.record.id,unique.id,incoming.record.id]);assert.deepEqual(out[1],unique);
  assert.deepEqual(out[0],{...duplicate.record,snapshotServerRef:resolved.resolutions[0].reference});
});

test('long multibyte IDs split by byte size before row limit and avoid per-row metadata cloning',async t=>{
  const scope={namespace:'st-user:large-ids',ownerKey:'char:Alice.png',chatKey:'chat'},transport=streamCheckpointTransport(scope.namespace),storage=await createGalleryWritePlanStorage({scope,guard:()=>true,createStorage:transport.createStorage});t.after(()=>storage.close());
  const reference={sha256:'b'.repeat(64),bytes:100},recipe={version:1,id:'a'.repeat(64)+'-00000000-0000-4000-8000-000000000000',sha256:'a'.repeat(64),bytes:500};
  const rows=Array.from({length:260},(_,i)=>({id:'字'.repeat(236)+i,createdAt:i,snapshotServerRef:recipe})),records=rows.map((_,i)=>({sha256:i.toString(16).padStart(64,'0'),bytes:1500}));let reads=0;
  const source={get metadata(){reads++;return {reference,plan:{scope,gallery:{count:rows.length}}};},verify:async()=>true,
    scan:async({visit})=>{for(let i=0;i<rows.length;i++)await visit({record:rows[i],reference:records[i],origin:'source',outputIndex:i,kept:false});}};
  const assets={restore:async({onRecipeResolved})=>{for(let i=0;i<rows.length;i++)await onRecipeResolved({recordId:rows[i].id,createdAt:i,record:records[i],originalReference:recipe,reference:recipe});
    return {proof:'prepared-assets-readback-only',recipesResolved:rows.length,originalsVerified:0,preparation:reference};}};
  const stored=await resolvePreparedGalleryWrite({source,assets,writeStorage:storage,preview:{ready:true,preparation:reference},confirmed:true,guard:()=>true,verifyCurrent:()=>true});
  assert.equal(stored.plan.resolutions,260);assert.ok(stored.plan.pages.length>=3);assert.ok(stored.plan.pages.every(page=>page.bytes<=128*1024&&page.count<128));assert.ok(reads<10);
});

test('another preparation confirmation cannot start files or writes',async t=>{
  const f=await setup(t),storage=await f.storage();await assert.rejects(resolvePreparedGalleryWrite({...f.base,writeStorage:storage,confirmed:true,
    preview:{ready:true,preparation:{sha256:'0'.repeat(64),bytes:20}},assets:{restore(){assert.fail('wrong source must not write');}}}),/不属于/);
});
