import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {historicalSourceFixture} from './helpers/historical-source-fixture.mjs';
import {blob,png,fixture as currentFixture} from './fixtures/storyboard-bundle.mjs';
import {captureHistoricalStoryboardBundle as capture,inspectHistoricalStoryboardBundle as inspect,inspectHistoricalStoryboardSource as inspectSource} from '../qianmu-historical-storyboard-bundle.js';
import {buildStoryboardBundle,openStoryboardBundle,HISTORICAL_BUNDLE_SCOPE as scope} from '../qianmu-storyboard-bundle.js';
import {inspectStoryboardResourceBundle} from '../qianmu-storyboard-bundle-resources.js';
import {createStoryboardBundleRestoreSession} from '../qianmu-storyboard-bundle-restore.js';
const guard=async()=>{},json=value=>new Blob([JSON.stringify(value)]);
async function pack(f,extra={},sourceOptions={}){return capture({session:await f.capture(sourceOptions),readImage:async()=>blob,guard,...extra});}
async function repack(file,change){
  const opened=await openStoryboardBundle(file),parts=[];
  for(const row of opened.manifest.entries)parts.push({id:row.id,file:(await opened.read(row.id)).file,...(row.mime?{mime:row.mime}:{})});
  const options={namespace:opened.manifest.namespace,chatKey:opened.manifest.chatKey,scope,entries:parts,createdAt:123};
  await change(options);return buildStoryboardBundle(options);
}
async function replace(options,id,edit){const row=options.entries.find(item=>item.id===id),value=JSON.parse(await row.file.text());edit(value);row.file=json(value);}

function countReads(file){
  const slice=file.slice.bind(file);let reads=0;
  file.slice=(...args)=>{reads++;return slice(...args);};
  return ()=>reads;
}

test('same immutable package reuses validated bytes but returns independent complete data',async t=>{
  const f=await historicalSourceFixture(t),{file}=await pack(f),reads=countReads(file);
  const first=await inspect(file),expected=structuredClone(first),count=reads();assert.ok(count>0);
  first.source.saved.storyboardImages[0].url='tampered';first.source.recipes.length=0;
  first.manifest.entries.length=0;first.media.images.length=0;first.summary.images=-1;
  const second=await inspect(file);assert.equal(reads(),count);assert.deepEqual(second,expected);
  second.source.saved.characterDrafts.length=0;assert.deepEqual(await inspect(file),expected);
});

test('cached package still requires the caller guard before and after detached delivery',async t=>{
  const f=await historicalSourceFixture(t),{file}=await pack(f);await inspect(file);
  await assert.rejects(inspect(file,{guard:async()=>false}),/保护/);
  await assert.rejects(inspect(file,{guard:async()=>{throw Error('account changed');}}),/account changed/);
  let checks=0;await assert.rejects(inspect(file,{guard:async()=>++checks<2}),/保护/);assert.equal(checks,2);
  assert.equal((await inspect(file)).summary.images,2);
});

test('interrupted inspection is not reused by the next caller',async t=>{
  const f=await historicalSourceFixture(t),{file}=await pack(f),reads=countReads(file);let checks=0;
  await assert.rejects(inspect(file,{guard:async()=>{if(++checks===5)throw Error('closed');}}),/closed/);
  const interrupted=reads();assert.ok(interrupted>0);
  assert.equal((await inspect(file)).summary.images,2);assert.ok(reads()>interrupted);
});

test('cache belongs to exact Blob, never its filename, length or manifest fingerprint',async t=>{
  const f=await historicalSourceFixture(t),{file}=await pack(f);await inspect(file);
  const other=new Blob([file]),reads=countReads(other);assert.equal((await inspect(other)).summary.images,2);assert.ok(reads()>0);
  const bytes=new Uint8Array(await file.arrayBuffer());bytes[bytes.length-1]^=1;
  const corrupt=new Blob([bytes]),badReads=countReads(corrupt);await assert.rejects(inspect(corrupt));const first=badReads();
  await assert.rejects(inspect(corrupt));assert.ok(badReads()>first);assert.equal((await inspect(file)).summary.images,2);
});

test('concurrent callers do not share cancellation or an unverified pending result',async t=>{
  const f=await historicalSourceFixture(t),{file}=await pack(f);let checks=0;
  const results=await Promise.allSettled([inspect(file,{guard:async()=>{if(++checks===5)throw Error('cancelled');}}),inspect(file)]);
  assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled');
  assert.equal((await inspect(file)).summary.images,2);
});

test('historical segmented package preserves source, unknown draft fields, both recipes and exact image bytes without writes',async t=>{
  const f=await historicalSourceFixture(t),before=await readFile(f.file),session=await f.capture(),source=session.source,seen=[];
  const packed=await capture({session,guard,createdAt:123,readImage:async(selection,{signal})=>{seen.push(selection);assert.equal(signal.aborted,false);return blob;}});
  assert.equal(packed.manifest.schema,'qianmu.storyboard.bundle.v4');assert.equal(packed.manifest.scope,scope);assert.equal(packed.manifest.createdAt,123);
  const result=await inspect(packed.file);assert.deepEqual(result.source,source);assert.deepEqual(result.source.saved,f.saved);
  assert.equal(result.summary.characterDrafts,1);assert.equal(result.summary.recipes,2);assert.equal(result.summary.restoreSupported,false);
  assert.deepEqual(result.summary.excluded,['chat-body','global-settings','shared-libraries','referenced-assets']);
  assert.equal(result.manifest.entries.length,3);assert.equal(result.media.images.length,2);assert.equal(result.media.images[0].sha256,result.media.images[1].sha256);
  const opened=await openStoryboardBundle(packed.file),image=opened.manifest.entries.find(row=>row.id.startsWith('image:'));
  assert.deepEqual(Buffer.from((await opened.read(image.id)).bytes),png);
  assert.deepEqual(seen.map(row=>row.recordId),['inline','server']);assert.ok(seen.every(row=>row.namespace===source.namespace&&row.gallerySha256===source.gallerySha256));
  assert.deepEqual(seen[1].target,f.target);assert.equal(seen[1].url,f.rows[1].url);assert.deepEqual(await readFile(f.file),before);
  await assert.rejects(session.verify());assert.doesNotMatch(JSON.stringify(result),/PRIVATE_HISTORY|PRIVATE_VOICE|PRIVATE_KEY|PRIVATE_HIDDEN|WRONG_GLOBAL/);
});

test('selected history retains complete drafts and albums without pretending to include all gallery records',async t=>{
  const f=await historicalSourceFixture(t),result=await inspect((await pack(f,{}, {recordIds:['server']})).file);
  assert.deepEqual(result.source.selection,{ids:['server'],total:2});assert.equal(result.summary.images,1);
  assert.deepEqual(result.source.saved.characterDrafts,f.saved.characterDrafts);assert.deepEqual(result.source.saved.storyboardCollections,f.saved.storyboardCollections);
  assert.equal(result.source.recipes[0].origin,'server-archive');assert.ok(!Object.hasOwn(result.source,'settings'));
});

test('genuinely empty saved gallery has zero images and no invented absent fields',async t=>{
  const f=await historicalSourceFixture(t);f.rows.splice(0);delete f.saved.characterDrafts;delete f.saved.storyboardCollections;await f.write();
  const packed=await pack(f,{readImage:async()=>assert.fail('empty gallery read image')}),result=await inspect(packed.file);
  assert.equal(result.manifest.entries.length,2);assert.equal(result.summary.images,0);assert.deepEqual(result.source.saved,{storyboardImages:[]});
});

test('source validation rejects missing or substituted recipes, identifiers, owner, full-range fingerprint and body digest',async t=>{
  const f=await historicalSourceFixture(t),s=await f.capture();t.after(()=>s.close());
  const mutations=[s=>s.recipes.pop(),s=>s.recipes[0].recordId='server',s=>s.recipes[0].createdAt=3,s=>s.recipes[0].snapshot.prompt='replacement',
    s=>s.recipes[1].snapshot.payload.changed=true,s=>s.recipes[1].reference.id=s.recipes[1].reference.id.replace(/.$/,'x'),
    s=>s.selection.ids.reverse(),s=>s.saved.characterDrafts.owner.namespace='st-user:other',s=>s.gallerySha256='0'.repeat(64),
    s=>s.observed.stateSha256='0'.repeat(64),s=>s.chatEvidence.digest='0'.repeat(64),s=>s.observed.file.bytes=1,
    s=>s.saved.unknown='not silently discarded',s=>s.saved.storyboardImages[0].recipeUnavailable=true,s=>s.observed.header.extra=true];
  for(const mutate of mutations){const copy=structuredClone(s.source);mutate(copy);await assert.rejects(inspectSource(copy));}
});

test('partial selection still verifies archive bytes and rejects credentials hidden in serialized workflow',async t=>{
  const f=await historicalSourceFixture(t),s=await f.capture({recordIds:['server']});t.after(()=>s.close());
  const changed=structuredClone(s.source);changed.recipes[0].snapshot.prompt='different';await assert.rejects(inspectSource(changed),/指纹/);
  const secret=structuredClone(s.source);secret.recipes[0].snapshot.payload.workflow=JSON.stringify({node:{inputs:{api_key:'NOT_A_REAL_KEY'}}});
  await assert.rejects(inspectSource(secret));
});

test('missing, non-image, oversize or rejected image ends session and never returns a partial package',async t=>{
  const f=await historicalSourceFixture(t);
  for(const value of [null,new Blob(['broken']),new Blob([new Uint8Array(16*1048576+1)])]){
    const session=await f.capture();await assert.rejects(capture({session,guard,readImage:async()=>value}));await assert.rejects(session.verify());
  }
  let calls=0;await assert.rejects(pack(f,{readImage:async()=>{if(++calls===2)throw Error('missing original');return blob;}}),/missing original/);assert.equal(calls,2);
});

test('source changes while reading originals cause final revalidation to reject whole package',async t=>{
  const f=await historicalSourceFixture(t);let reads=0;
  await assert.rejects(pack(f,{readImage:async()=>{if(++reads===1){f.saved.characterDrafts.items[0].future.note='edited during pack';await f.write();}return blob;}}),/变化/);
});

test('caller account guard closes source before any image read',async t=>{
  const f=await historicalSourceFixture(t),session=await f.capture();
  await assert.rejects(capture({session,guard:async()=>{throw Error('account changed');},readImage:async()=>assert.fail()}),/account changed/);
  await assert.rejects(session.verify());
});

test('timeout and external abort settle even when image reader ignores cancellation; late completion cannot reverify or deliver',async t=>{
  const f=await historicalSourceFixture(t);
  for(const mode of ['timeout','abort']){
    const session=await f.capture(),controller=new AbortController();let release,started;
    const begin=new Promise(done=>started=done),gate=new Promise(done=>release=done);let reads=0;
    const rejected=assert.rejects(capture({session,guard,timeoutMs:mode==='timeout'?100:5000,signal:controller.signal,readImage:async()=>{reads++;started();await gate;return blob;}}),/取消|超时/);
    await begin;if(mode==='abort')controller.abort();await rejected;const calls=f.calls.length;release();await new Promise(done=>setTimeout(done,20));
    assert.equal(reads,1);assert.equal(f.calls.length,calls);await assert.rejects(session.verify());
  }
});

test('already cancelled source starts no image work',async t=>{
  const f=await historicalSourceFixture(t),session=await f.capture(),controller=new AbortController();controller.abort();
  await assert.rejects(capture({session,guard,signal:controller.signal,readImage:async()=>assert.fail('read')}),/取消|结束/);await assert.rejects(session.verify());
});

test('current restore refuses historical scope before any store, configuration, media or journal access',async t=>{
  const f=await historicalSourceFixture(t),packed=await pack(f);let calls=0;
  await assert.rejects(inspectStoryboardResourceBundle(packed.file),/此恢复入口尚不支持/);
  await assert.rejects(createStoryboardBundleRestoreSession({namespace:'st-user:alice',chatKey:f.target.chatId,file:packed.file,guard,isCurrent:()=>true,
    configuration:{preview:()=>{calls++;},apply:()=>{calls++;}},workflowStore:{backup:()=>{calls++;}},journal:{loadResource:()=>{calls++;}}}),/不会忽略人物草稿/);
  assert.equal(calls,0);
});

test('existing current-resource v2 still builds and inspects and is rejected by history-only inspector',async()=>{
  const f=await currentFixture(),packed=await f.build();assert.equal((await inspectStoryboardResourceBundle(packed.file)).summary.images,1);
  await assert.rejects(inspect(packed.file),/只核对历史原件/);
});

test('envelope forbids cross-scope segments, fake scope, missing required parts and current source identity on history',async t=>{
  const f=await historicalSourceFixture(t),packed=await pack(f);
  const changes=[o=>o.scope='unknown',o=>o.scope='current-chat-and-libraries',o=>o.entries.push({id:'storyboard',file:json({})}),o=>o.source={}];
  for(const change of changes)await assert.rejects(repack(packed.file,change));
  await assert.rejects(repack(packed.file,o=>{o.entries=o.entries.filter(row=>row.id!=='historical-originals');}));
});

test('body/index corruption, removed media, wrong account/chat and recomputed invalid index are rejected',async t=>{
  const f=await historicalSourceFixture(t),packed=await pack(f),bytes=new Uint8Array(await packed.file.arrayBuffer());bytes[bytes.length-1]^=1;
  await assert.rejects(inspect(new Blob([bytes])),/校验|JSON|分镜包/);
  await assert.rejects(inspect(packed.file.slice(0,-1)),/截断/);
  const changes=[o=>{o.namespace='st-user:other';},o=>{o.chatKey='wrong-chat';},o=>{o.entries=o.entries.filter(row=>!row.id.startsWith('image:'));},
    o=>replace(o,'historical-media',v=>v.images.pop()),o=>replace(o,'historical-media',v=>{v.images[1].recordId='inline';}),
    o=>replace(o,'historical-media',v=>{v.images[1].bytes++;}),o=>replace(o,'historical-media',v=>{v.images[0].sha256='0'.repeat(64);}),
    o=>replace(o,'historical-originals',v=>{v.recipes[1].snapshot.prompt='tamper';})];
  for(const change of changes){const changed=await repack(packed.file,change);await assert.rejects(inspect(changed.file));}
});

test('inspection guard can stop segment work without a returned successful summary',async t=>{
  const f=await historicalSourceFixture(t),packed=await pack(f);let calls=0;
  await assert.rejects(inspect(packed.file,{guard:async()=>{if(++calls===9)throw Error('closed');}}),/closed/);
});
