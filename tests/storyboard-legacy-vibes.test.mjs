import test from 'node:test';
import assert from 'node:assert/strict';
import { captureLegacyVibeOriginals as capture, inspectLegacyVibeOriginals as inspect } from '../qianmu-storyboard-legacy-vibes.js';
import { inspectStoryboardResourceBundle } from '../qianmu-storyboard-bundle-resources.js';
import { openStoryboardBundle, buildStoryboardBundle } from '../qianmu-storyboard-bundle.js';
import { fixture, file, png, sha256, namespace, chatKey } from './fixtures/storyboard-bundle.mjs';

const guard = async () => {}, local = [{ url: '/user/images/legacy.png' }];
const fetch = async () => new Response(png);
async function withLegacy() {
  const f = await fixture(); f.config.settings.vibeLibrary = [{ id: 'legacy', previewUrl: local[0].url, strength: 0, informationExtracted: 0 }];
  f.config.settings.profiles.novel = { selectedVibeIds: ['legacy'], vibeRecipe: { version: 1, items: [{ id: 'legacy', name: 'Before', previewUrl: local[0].url, strength: 0, information: 0 }] } };
  f.options.storyboard = file(f.config); f.options.legacyFetch = fetch; return f;
}
async function repack(built, change) {
  const opened = await openStoryboardBundle(built.file), entries = [];
  for (const row of opened.manifest.entries) entries.push({ id: row.id, file: (await opened.read(row.id)).file, ...(row.mime ? { mime: row.mime } : {}) });
  change(entries); return buildStoryboardBundle({ namespace, chatKey, entries });
}

test('local legacy aliases fetch once and retain exact original strings, bytes and receipts without any write', async () => {
  const locations = [...local, { url: 'user/images/legacy.png' }], before = structuredClone(locations), calls = [];
  const result = await capture(locations, { guard, fetch: async (url, options) => { calls.push([url, options]); return fetch(); } });
  assert.deepEqual(locations, before); assert.equal(calls.length, 1); assert.equal(calls[0][0], local[0].url);
  assert.equal(calls[0][1].credentials, 'same-origin'); assert.equal(calls[0][1].redirect, 'error'); assert.equal(calls[0][1].referrerPolicy, 'no-referrer');
  assert.equal(calls[0][1].headers, undefined); assert.equal(calls[0][1].method, undefined);
  assert.equal(result.document.items.length, 2); assert.equal(result.files.size, 1);
  assert.equal(inspect(result.document, locations).receipts.length, 1);
  assert.deepEqual(Buffer.from(await result.files.get(sha256).arrayBuffer()), png);
});

test('external, signed, ambiguous and traversal sources reject the entire list before any request', async () => {
  for (const url of ['https://example.com/a.png','https://example.com/a.png?key=private','//example.com/a.png','/api/settings/get.png','/user/images/a.png?token=secret','/user/images/%2e%2e/a.png','/user/images/%252e/a.png','/user/images/a\\b.png','data:image/png;base64,AA==']) {
    await assert.rejects(capture([...local, { url }], { guard, fetch: () => assert.fail('must preflight all sources') }), /非本地/);
  }
});

test('an oversized source manifest is refused before network reads even when each individual path is valid', async () => {
  const folder='a'.repeat(240),locations=Array.from({length:1024},(_,i)=>({url:`/user/images/${folder}/${folder}/${folder}/${folder}/${folder}/${folder}/${i}.png`}));
  await assert.rejects(capture(locations,{guard,fetch:()=>assert.fail('manifest must be bounded first')}),/清单超过/);
});

test('bounded stream reads reject excessive, empty, truncated, mismatched or redirected images and cancel', async () => {
  for (const request of [async()=>new Response(png,{headers:{'content-length':String(16*1048576+1)}}), async()=>new Response(''), async()=>new Response(png.subarray(0,20)), async()=>new Response('not an image')]) {
    await assert.rejects(capture(local,{guard,fetch:request}));
  }
  await assert.rejects(capture([{url:'/user/images/a.jpg'}],{guard,fetch}), /格式/);
  let canceled = false;
  await assert.rejects(capture(local,{guard,maxBytes:32,fetch:async()=>new Response(new ReadableStream({start(c){c.enqueue(png);},cancel(){canceled=true;}}))}), /容量/);
  assert.equal(canceled,true);
  const redirected = new Response(png); Object.defineProperty(redirected,'redirected',{value:true});
  await assert.rejects(capture(local,{guard,fetch:async()=>redirected}), /读取失败/);
});

test('cancelled scope and timeout abort reads; no fallback or retry runs', async () => {
  let calls = 0, aborted = false;
  await assert.rejects(capture(local,{guard,timeoutMs:100,fetch:async(_url,{signal})=>{calls++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('timeout'));}));}}),/timeout/);
  assert.equal(calls,1);assert.equal(aborted,true);
  let checks=0;
  await assert.rejects(capture(local,{guard:async()=>{if(++checks>1)throw Error('scope changed');},fetch}),/scope changed/);
});

test('legacy manifest rejects omission, duplicates, extra uses, unsafe fields and substitute paths even with valid hashes', async () => {
  const {document} = await capture(local,{guard,fetch});
  for (const mutate of [doc=>doc.items=[],doc=>doc.items.push(doc.items[0]),doc=>doc.items[0].url='/user/images/unknown.png',doc=>doc.items[0].receipt.url='/user/images/substitute.png',doc=>doc.items[0].grantId='secret',doc=>doc.extra={}]) {
    const changed=structuredClone(document);mutate(changed);assert.throws(()=>inspect(changed,local));
  }
});

test('v2 resource capture preserves every typed old recipe unchanged and shares bytes with other references', async () => {
  const f=await withLegacy(), before=structuredClone(f.config), built=await f.build(), opened=await openStoryboardBundle(built.file);
  assert.equal(opened.manifest.schema,'qianmu.storyboard.bundle.v2');
  assert.deepEqual(await opened.readJson('storyboard'),before);assert.deepEqual(f.config,before);
  const result=await inspectStoryboardResourceBundle(built.file);
  assert.equal(result.summary.legacyVibeUrls,1);assert.equal(result.summary.legacyVibeOriginals,1);
  assert.equal(result.summary.originalFiles,1);assert.equal(result.summary.originalPaths,5);assert.equal(f.reads.images,0);
  assert.equal(opened.manifest.entries.filter(row=>row.id.startsWith('image:')).length,1);
});

test('v1 bundles still show unpreserved legacy sources while v2 cannot silently omit their original manifest', async () => {
  const f=await withLegacy(), built=await f.build();
  const old=await repack(built,entries=>{for(const id of ['legacy-vibes','resource-origins'])entries.splice(entries.findIndex(row=>row.id===id),1);});
  const inspected=await inspectStoryboardResourceBundle(old.file);
  assert.equal(inspected.manifest.schema,'qianmu.storyboard.bundle.v1');assert.equal(inspected.summary.legacyVibeUrls,1);assert.equal(inspected.summary.legacyVibeOriginals,0);
  const empty=await repack(built,entries=>entries.find(row=>row.id==='legacy-vibes').file=file({schema:'qianmu.storyboard.legacy-vibes.v1',items:[]}));
  await assert.rejects(inspectStoryboardResourceBundle(empty.file),/清单缺件/);
});

test('v2 inspector never fetches a legacy original or runs an encoding request while validating a selected file', async () => {
  const f=await withLegacy(),built=await f.build(),original=globalThis.fetch;
  globalThis.fetch=()=>assert.fail('import is offline until explicit add-only inspection/restore');
  try{const inspected=await inspectStoryboardResourceBundle(built.file);assert.equal(inspected.summary.legacyVibeOriginals,1);}
  finally{globalThis.fetch=original;}
});
