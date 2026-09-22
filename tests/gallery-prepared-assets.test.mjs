import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {galleryPreparedAssetsFixture as fixture} from './helpers/gallery-prepared-assets-fixture.mjs';
import {openPreparedGallerySource} from '../qianmu-gallery-prepared-source.js';
const consent=view=>({confirmed:true,expectedDigest:view.digest,scope:view.scope});
const gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
const writes=f=>f.calls.filter(call=>/\/(?:image\/restore\/restore|recipe\/restore)$/.test(call.url));

test('actual HTTP restores the missing original once and resolves the exact archived recipe without saving chat metadata',async t=>{
  const f=await fixture(t);await fs.unlink(f.image);await fs.unlink(f.recipePath);const session=f.open(),view=await session.preview(),resolved=[];
  assert.equal(view.ready,true);assert.equal(view.records,3);assert.equal(view.originals,1);assert.equal(view.missing,1);assert.equal(view.serverRecipes,1);assert.equal(writes(f).length,0);
  const result=await session.restore({...consent(view),onRecipeResolved:row=>resolved.push(row)});
  assert.equal(result.metadataRestored,false);assert.equal(result.restoreReady,false);assert.equal(result.originalsVerified,1);assert.equal(result.recipesResolved,1);
  assert.deepEqual(await fs.readFile(f.image),f.png);assert.deepEqual(await fs.readFile(f.file),f.originalFile);assert.equal(JSON.stringify(f.context.chatMetadata),f.live);
  assert.equal(writes(f).filter(c=>c.url.includes('/image/')).length,1);assert.equal(resolved.length,1);assert.notEqual(resolved[0].reference.id,resolved[0].originalReference.id);
  assert.equal(resolved[0].reference.sha256,resolved[0].originalReference.sha256);assert.equal(resolved[0].recordId,f.rows[0].id);
  const recipe=JSON.parse(await fs.readFile(path.join(f.req.user.directories.root,'.qianmu-recipes-v1',resolved[0].reference.id+'.json'),'utf8'));
  assert.equal(recipe.snapshot.prompt,'original');assert.equal(f.store.storyboardImages.length,0);
  assert.ok(f.calls.every(c=>!new Headers(c.options.headers).has('authorization')));assert.equal(result.canPrune,false);
});

test('existing exact original is reused; fresh inspection after an earlier repair does not upload it again',async t=>{
  const f=await fixture(t),session=f.open(),view=await session.preview();assert.equal(view.missing,0);
  await session.restore(consent(view));assert.equal(writes(f).filter(c=>c.url.includes('/image/')).length,0);
  const next=f.open(),fresh=await next.preview();await next.restore(consent(fresh));assert.equal(writes(f).filter(c=>c.url.includes('/image/')).length,0);
});

test('conflicting destination prevents all asset writes and remains untouched',async t=>{
  const f=await fixture(t),different=Buffer.from(f.png);different[20]^=1;await fs.writeFile(f.image,different);
  const session=f.open(),view=await session.preview();assert.equal(view.ready,false);assert.equal(view.conflicts,1);
  await assert.rejects(session.restore(consent(view)),/明确确认/);assert.equal(writes(f).length,0);assert.deepEqual(await fs.readFile(f.image),different);
});

test('stale or missing confirmation cannot write; changed file state consumes the old preview',async t=>{
  const f=await fixture(t),session=f.open();await assert.rejects(session.restore({confirmed:true}),/明确确认/);
  const view=await session.preview();await assert.rejects(session.restore({...consent(view),confirmed:false}),/明确确认/);
  await fs.unlink(f.image);await assert.rejects(session.restore(consent(view)),/重新核对/);assert.equal(writes(f).length,0);
  await assert.rejects(session.restore(consent(view)),/明确确认/);
});

test('late current-baseline change before the first write stops without modifying files or references',async t=>{
  const f=await fixture(t);await fs.unlink(f.image);const session=f.open(),view=await session.preview();
  f.context.chatMetadata.extra='user edit';await assert.rejects(session.restore(consent(view)),/基线已变化/);assert.equal(writes(f).length,0);
  await assert.rejects(fs.stat(f.image),{code:'ENOENT'});assert.deepEqual(await fs.readFile(f.file),f.originalFile);
});

test('corrupt archived image bytes are not repaired, uploaded, replaced by URL fallback or generated',async t=>{
  const f=await fixture(t),row=await f.source.readSelected(0),ref=row.media.reference;
  await fs.unlink(f.image);const file=path.join(f.req.user.directories.root,'.qianmu-originals-v1',ref.sha256.slice(0,2),ref.id+'.bin');await fs.writeFile(file,Buffer.alloc(ref.bytes));
  const session=f.open(),view=await session.preview();await assert.rejects(session.restore(consent(view)));assert.equal(writes(f).length,0);
  await assert.rejects(fs.stat(f.image),{code:'ENOENT'});assert.deepEqual(await fs.readFile(f.file),f.originalFile);
});

test('lost image acknowledgement preserves the written file, does not retry, and returns needs_review without touching chat',async t=>{
  const f=await fixture(t);await fs.unlink(f.image);const session=f.open(),view=await session.preview();let did=false;
  f.state.hook=async(url,options)=>{if(url.endsWith('/image/restore/restore')){did=true;await fetch(f.origin+url.slice('/api/plugins/qianmu-tts'.length),options);throw Error('lost reply');}};
  await assert.rejects(session.restore(consent(view)),error=>error.assetsState==='needs_review'&&error.metadataRestored===false);
  assert.equal(did,true);assert.equal(writes(f).length,1);assert.deepEqual(await fs.readFile(f.image),f.png);assert.deepEqual(await fs.readFile(f.file),f.originalFile);
  f.state.hook=null;const next=f.open(),fresh=await next.preview();assert.equal(fresh.missing,0);await next.restore(consent(fresh));assert.equal(writes(f).filter(c=>c.url.includes('/image/')).length,1);
});

test('recipe failure after original restoration retains completed files without publishing a metadata success',async t=>{
  const f=await fixture(t);await fs.unlink(f.image);const session=f.open(),view=await session.preview();
  f.state.hook=url=>url.endsWith('/recipe/restore')?new Response('unavailable',{status:503}):null;
  await assert.rejects(session.restore(consent(view)),error=>error.assetsState==='needs_review'&&error.attempts.originals===1&&error.attempts.recipes===1);
  assert.deepEqual(await fs.readFile(f.image),f.png);assert.deepEqual(await fs.readFile(f.file),f.originalFile);assert.equal(f.store.storyboardImages.length,0);
});

test('closing while archive bytes are pending cancels linked HTTP and ignores late data',async t=>{
  const f=await fixture(t);await fs.unlink(f.image);const session=f.open(),view=await session.preview(),wait=gate(),entered=gate();let seenSignal;
  f.state.hook=async(url,options)=>{if(url.endsWith('/original/read')){seenSignal=options.signal;entered.resolve();await wait.promise;return new Response('late');}};
  const pending=session.restore(consent(view));await entered.promise;session.close();await assert.rejects(pending,/取消/);assert.equal(seenSignal.aborted,true);
  wait.resolve();await new Promise(r=>setTimeout(r,10));assert.equal(writes(f).length,0);await assert.rejects(fs.stat(f.image),{code:'ENOENT'});
});

test('empty and all-inline sources need no recipe restore calls and retain exact original records',async t=>{
  for(const count of [0,2]){
    const f=await fixture(t,{count,serverRecipe:false}),session=f.open(),view=await session.preview(),result=await session.restore(consent(view));
    assert.equal(result.recipesResolved,0);assert.equal(result.inlineRecipes,count);assert.equal(writes(f).length,0);
    const collected=[];await f.source.scan({visit:item=>{if(item.origin==='source')collected.push(item.record);}});assert.deepEqual(collected,f.rows);
  }
});

test('prepared-source streaming checks original order, complete output digest and read-only metadata',async t=>{
  const f=await fixture(t),seen=[],start=f.calls.length,files=f.transport.files.size;
  const result=await f.source.scan({visit:item=>seen.push({origin:item.origin,id:item.record.id,index:item.outputIndex})});
  assert.equal(result.total,3);assert.equal(result.added,3);assert.deepEqual(seen.map(row=>row.id),f.rows.map(row=>row.id));assert.deepEqual(seen.map(row=>row.index),[0,1,2]);
  assert.equal(f.calls.length,start);assert.equal(f.transport.files.size,files);
  const metadata=f.source.metadata;metadata.plan.gallery.sha256='f'.repeat(64);assert.notEqual(f.source.metadata.plan.gallery.sha256,metadata.plan.gallery.sha256);
});

test('a well-shaped but mismatched prepared row cannot reach original inspection or writes',async t=>{
  const f=await fixture(t),reader={read:(...args)=>f.planStorage.read(...args),scan:async(ref,{visit})=>f.planStorage.scan(ref,{visit:row=>visit({...row,sourceIndex:row.sourceIndex+1})})};
  const source=f.own(await openPreparedGallerySource({reference:f.prepared.reference,planStorage:reader,archive:f.archive,guard:()=>true}));
  const session=f.open({source}),start=f.calls.length;await assert.rejects(session.preview(),/顺序或记录不符/);assert.equal(f.calls.length,start);assert.equal(writes(f).length,0);
});
