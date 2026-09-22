import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {galleryPreparedAssetsFixture as fixture} from './helpers/gallery-prepared-assets-fixture.mjs';
import {createRecipeVerificationClient} from '../qianmu-recipe-verify-client.js';
import {recipeVerificationRequest} from '../qianmu-recipe-restore-contract.js';

test('actual authenticated read-only route verifies exact recipe file without saved-chat reference or any writes',async t=>{
  const f=await fixture(t),row=f.rows[0],client=f.own(createRecipeVerificationClient({namespace:f.account,guard:f.options.guard,headers:()=>({'X-CSRF-Token':'fixture',Authorization:'private'}),fetchImpl:f.options.fetchImpl}));
  const before=await fs.readFile(f.recipePath),result=await client.verify({source:{target:{kind:'character',avatar:'Alice.png',chatId:'chat'},recordId:row.id,createdAt:row.createdAt},reference:row.snapshotServerRef});
  assert.equal(result.proof,'read-only-recipe-file');assert.equal(f.store.storyboardImages.length,0);assert.deepEqual(await fs.readFile(f.recipePath),before);assert.deepEqual(await fs.readFile(f.file),f.originalFile);
  assert.ok(f.calls.filter(c=>c.url.endsWith('/verify-restored')).every(c=>!new Headers(c.options.headers).has('Authorization')));
});
test('missing, corrupted and wrong-source private files never return success or auto repair',async t=>{
  for(const kind of ['missing','corrupt','source','account','anonymous']){const f=await fixture(t),row=f.rows[0];
    const body={version:1,expectedAccount:f.expectedAccount,source:{target:{kind:'character',avatar:'Alice.png',chatId:'chat'},recordId:row.id,createdAt:row.createdAt},reference:row.snapshotServerRef};
    if(kind==='missing')await fs.unlink(f.recipePath);if(kind==='corrupt')await fs.writeFile(f.recipePath,'{}');if(kind==='source')body.source.target.avatar='Bob.png';if(kind==='account')body.expectedAccount='st-user:'+'0'.repeat(64);
    const response=await fetch(f.origin+'/chat-gallery/recipe/verify-restored',{method:'POST',headers:{'Content-Type':'application/json',...(kind==='anonymous'?{'x-fixture-anonymous':'yes'}:{})},body:JSON.stringify(body)});
    assert.equal(response.ok,false);assert.equal((await response.json()).ok,false);assert.deepEqual(await fs.readFile(f.file),f.originalFile);
    if(kind==='missing')await assert.rejects(fs.stat(f.recipePath),{code:'ENOENT'});
  }
});
test('verification request rejects upload bodies, path selectors and arbitrary fields',()=>{
  const body={version:1,expectedAccount:'st-user:'+'a'.repeat(64),source:{target:{kind:'character',avatar:'Alice.png',chatId:'chat'},recordId:'r',createdAt:0},reference:{version:1,id:'a'.repeat(64)+'-00000000-0000-4000-8000-000000000000',sha256:'a'.repeat(64),bytes:100}};
  assert.deepEqual(recipeVerificationRequest(body).reference,body.reference);
  for(const extra of [{snapshot:{}},{path:'../other'},{confirmed:true}])assert.throws(()=>recipeVerificationRequest({...body,...extra}));
});

const verifyInput=()=>({source:{target:{kind:'character',avatar:'Alice.png',chatId:'chat'},recordId:'r',createdAt:0},reference:{version:1,id:'a'.repeat(64)+'-00000000-0000-4000-8000-000000000000',sha256:'a'.repeat(64),bytes:100}});
test('verification timeout while awaiting guard never sends a late request',async()=>{
  let release,calls=0;const waiting=new Promise(done=>release=done),client=createRecipeVerificationClient({namespace:'st-user:test',guard:()=>waiting,timeoutMs:10,fetchImpl:async()=>{calls++;throw Error('unexpected');}});
  await assert.rejects(client.verify(verifyInput()),/超时/);release(true);await new Promise(done=>setTimeout(done,10));assert.equal(calls,0);client.close();
});
test('closing a pending verification body cancels reading and rejects without accepting late bytes',async()=>{
  let entered,cancelled=false;const started=new Promise(done=>entered=done),client=createRecipeVerificationClient({namespace:'st-user:test',guard:()=>true,
    fetchImpl:async()=>new Response(new ReadableStream({start(){entered();},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}})});
  const work=client.verify(verifyInput());await started;client.close();await assert.rejects(work);assert.equal(cancelled,true);
});
test('verification snapshots caller inputs and rejects mismatched, redirected or oversized replies',async()=>{
  for(const kind of ['account','reference','redirect','oversize']){
    const input=verifyInput();let sent;
    const client=createRecipeVerificationClient({namespace:'st-user:test',guard:()=>true,fetchImpl:async(_,options)=>{
      sent=JSON.parse(options.body);const reply={ok:true,...sent,proof:'read-only-recipe-file'};
      if(kind==='account')reply.expectedAccount='st-user:'+'f'.repeat(64);if(kind==='reference')reply.reference.bytes++;
      const response=Response.json(kind==='oversize'?{text:'x'.repeat(9000)}:reply);if(kind==='redirect')Object.defineProperty(response,'redirected',{value:true});return response;
    }});
    const work=client.verify(input);input.source.recordId='changed-after-call';await assert.rejects(work);assert.equal(sent.source.recordId,'r');client.close();
  }
});
