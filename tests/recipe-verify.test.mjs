import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {galleryPreparedAssetsFixture as fixture} from './helpers/gallery-prepared-assets-fixture.mjs';
import {recipeVerificationRequest,recipeVerificationResponse} from '../qianmu-recipe-restore-contract.js';

test('actual authenticated read-only route verifies exact recipe file without saved-chat reference or any writes',async t=>{
  const f=await fixture(t),row=f.rows[0],before=await fs.readFile(f.recipePath);
  const body={version:1,expectedAccount:f.expectedAccount,source:{target:{kind:'character',avatar:'Alice.png',chatId:'chat'},recordId:row.id,createdAt:row.createdAt},reference:row.snapshotServerRef};
  const response=await fetch(f.origin+'/chat-gallery/recipe/verify-restored',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal(response.ok,true);const result=recipeVerificationResponse(await response.json());
  assert.equal(result.proof,'read-only-recipe-file');assert.equal(result.expectedAccount,body.expectedAccount);assert.deepEqual(result.source,body.source);assert.deepEqual(result.reference,body.reference);
  assert.equal(f.store.storyboardImages.length,0);assert.deepEqual(await fs.readFile(f.recipePath),before);assert.deepEqual(await fs.readFile(f.file),f.originalFile);
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
