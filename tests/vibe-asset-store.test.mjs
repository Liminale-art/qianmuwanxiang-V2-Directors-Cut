import test from 'node:test';
import assert from 'node:assert/strict';
import {createVibeAssetStore} from '../qianmu-vibe-asset-store.js';
import {readFile} from 'node:fs/promises';
import {vibeDigest} from '../qianmu-vibe-file.js';

test('Vibe asset store opens lazily, uses its own DB, and closes permanently without touching old data',async()=>{
  let calls=0;const store=createVibeAssetStore({indexedDB:{open(name,version){calls++;assert.equal(name,'qianmu-vibe-assets');assert.equal(version,1);throw Error('unavailable');}}});
  assert.equal(calls,0);await assert.rejects(()=>store.list('st-user:one'),{code:'vibe_file_storage'});
  await assert.rejects(()=>store.usage('st-user:one'),{code:'vibe_file_storage'});assert.equal(calls,2);
  store.close();await assert.rejects(()=>store.list('st-user:one'),{code:'vibe_file_closed'});assert.equal(calls,2);
});
test('invalid account, invalid asset, invalid file and stale importer never open storage',async()=>{
  let calls=0;const store=createVibeAssetStore({indexedDB:{open(){calls++;throw Error();}}});
  for(const account of ['',null,'st-user:','st-user:a\n','other'])await assert.rejects(()=>store.list(account),{code:'vibe_file_account'});
  await assert.rejects(()=>store.load('st-user:one','../asset'),{code:'vibe_file_asset'});
  await assert.rejects(()=>store.putFile('st-user:one','{}'),{code:'vibe_file_version'});
  await assert.rejects(()=>store.putFile('st-user:one','{}',{isCurrent:()=>false}),{code:'vibe_file_stale'});
  await assert.rejects(()=>store.remove('st-user:one',['x']),{code:'vibe_file_asset'});
  assert.equal(calls,0);store.close();
});
test('native numeric-code storage exceptions abort cleanly rather than throwing in their own handler',async()=>{
  let aborts=0;const request=value=>{const result={};queueMicrotask(()=>{result.result=value;result.onsuccess?.();});return result;};
  const store=createVibeAssetStore({indexedDB:{open(){return request({close(){},transaction(){
    const tx={abort(){aborts++;queueMicrotask(()=>tx.onabort?.());},objectStore(){return {get:()=>request(undefined),index:()=>({count:()=>request(0)}),add(){throw new DOMException('quota','QuotaExceededError');}};}};return tx;
  }});}},keyRange:{only:value=>value}});
  const encoding=btoa('fixture'),doc={identifier:'novelai-vibe-transfer',version:1,type:'encoding',id:await vibeDigest(encoding),encodings:{v4full:{unknown:{encoding}}}};
  await assert.rejects(()=>store.putFile('st-user:one',JSON.stringify(doc)),{code:'vibe_file_storage'});assert.equal(aborts,1);store.close();
});
test('asset foundation is packaged but not activated or allowed to make any external request',async()=>{
  const code=await readFile(new URL('../qianmu-vibe-asset-store.js',import.meta.url),'utf8');
  assert.doesNotMatch(code,/fetch\(|localStorage|extension_settings|qianmu-blobstore|setInterval/);
  const release=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8'));
  for(const file of ['qianmu-vibe-file.js','qianmu-vibe-asset-store.js'])assert.ok(release.files.includes(file));
});
test('blocked/late open is closed and a timed-out open can be retried',async()=>{
  const requests=[];let closed=0;const store=createVibeAssetStore({timeoutMs:100,indexedDB:{open(){const request={};requests.push(request);return request;}}});
  const first=store.list('st-user:one');requests[0].onblocked();await assert.rejects(()=>first,{code:'vibe_file_blocked'});
  requests[0].result={close(){closed++;}};requests[0].onsuccess();assert.equal(closed,1);
  await assert.rejects(()=>store.list('st-user:one'),{code:'vibe_file_timeout'});
  requests[1].result={close(){closed++;}};requests[1].onsuccess();assert.equal(closed,2);store.close();
});
