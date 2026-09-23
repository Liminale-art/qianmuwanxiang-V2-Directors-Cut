import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareStoryboardVibes} from '../qianmu-vibe-prepare.js';
import {encodeNovelVibe} from '../qianmu-vibe-encoding.js';
import {createVibeEncodingRetention} from '../qianmu-vibe-encoding-retention.js';
import {createVibeAssetOperations} from '../qianmu-vibe-assets-worker.js';
import {createNativeVibeEncodingStore} from '../qianmu-vibe-native-encoding-store.js';
import {parseNovelVibeFile} from '../qianmu-vibe-file.js';
import {receiptWritableFixture} from './helpers/vibe-receipt-writable-fixture.mjs';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';

const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
const payload={selectedVibeIds:['source'],vibeRecipe:{version:1,items:[{id:'source',name:'source',previewUrl:'/images/source.png',information:0,strength:0}]}};
async function setup(t){
  const f=await characterNativeFixture(t),local=receiptWritableFixture(),files=new Map(),events=[];let posts=0,active=true,afterReturn=null;
  const assets={load:async(ns,id)=>files.get(ns+id),putFile:async(ns,text)=>{const rows=await parseNovelVibeFile(text);for(const row of rows)files.set(ns+row.assetId,row);return rows;},close(){}};
  const ledger=createNativeVibeEncodingStore({legacy:local.open(),createStorage:f.createStorage});t.after(()=>ledger.close());
  const operations=createVibeAssetOperations(assets,{encodings:ledger}),guard=async()=>{if(!active)throw Error('account changed');};
  const options={namespace,model:{remoteModelId:'nai-diffusion-4-full',capabilityModelId:'nai-diffusion-4-full'},connection:{baseUrl:'https://relay.example',protocol:'novelai'},apiKey:'synthetic-key',guard,
    readImage:async()=>({data:image}),checkpoint:async()=>{},confirm:async()=>true,
    call:async(type,args)=>{events.push(type);return operations({type,...args});},
    prepareRetention:args=>createVibeEncodingRetention({...args,readSource:args=>operations({type:'encoding-original',...args}),createAssets:()=>assets,createReceipts:()=>local.open()}),
    encode:async(input,hooks)=>{const result=await encodeNovelVibe(input,{...hooks,fetchImpl:async()=>{posts++;assert.equal(local.state.tables.receipts[0].status,'submitting');
      assert.ok([...f.files.keys()].some(name=>name.endsWith('-vibe-receipt-catalogue.json')));return new Response('encoded-test',{status:201,headers:{'content-type':'application/binary'}});}});await afterReturn?.();return result;},
  };
  return Object.assign(f,{local,ledger,events,options,posts:()=>posts,afterReturn:callback=>afterReturn=callback,switchAccount:()=>{active=false;f.account('st-user:other');}});
}

test('ordinary coordinator uses real native ledger, charges once in a synthetic transport and publishes ready for another empty-local client',async t=>{
  const f=await setup(t),first=await prepareStoryboardVibes(payload,f.options),second=await prepareStoryboardVibes(payload,f.options);assert.deepEqual(second,first);assert.equal(f.posts(),1);
  const fresh=createNativeVibeEncodingStore({legacy:receiptWritableFixture().open(),createStorage:f.createStorage});t.after(()=>fresh.close());const row=f.local.state.tables.receipts[0];
  assert.equal((await fresh.get(namespace,row.cacheKey)).status,'ready');assert.ok(f.events.filter(type=>type==='encoding-get').length>=3);
});
test('ordinary coordinator never charges when either reservation or submitting publication is not acknowledged',async t=>{
  for(const phase of ['reserved','submitting']){const f=await setup(t);f.hook(call=>{if(call.path==='/api/files/upload'&&JSON.parse(call.request.body).name.endsWith('-vibe-receipt-catalogue.json')&&f.local.state.tables.receipts[0]?.status===phase)throw Error('unacknowledged '+phase);});
    await assert.rejects(prepareStoryboardVibes(payload,f.options));assert.equal(f.posts(),0);
  }
});
test('failure to publish ready preserves the paid local result and no automatic second charge occurs',async t=>{
  const f=await setup(t);f.hook(call=>{if(call.path==='/api/files/upload'&&JSON.parse(call.request.body).name.endsWith('-vibe-receipt-catalogue.json')&&f.local.state.tables.receipts[0]?.status==='ready')throw Error('ready save unavailable');});
  await assert.rejects(prepareStoryboardVibes(payload,f.options),{encodingState:'unknown'});assert.equal(f.posts(),1);assert.equal(f.local.state.tables.receipts[0].status,'ready');
  f.hook(null);await prepareStoryboardVibes(payload,f.options);assert.equal(f.posts(),1);
});
test('original-account paid sink remains local after account switch, then becomes reusable under the original account',async t=>{
  const f=await setup(t);let requests=0;f.afterReturn(()=>{requests=f.calls.length;f.switchAccount();});
  await assert.rejects(prepareStoryboardVibes(payload,f.options),/account changed/);assert.equal(f.calls.length,requests);assert.equal(f.posts(),1);assert.equal(f.local.state.tables.receipts[0].status,'ready');
  f.account(namespace);assert.equal((await f.ledger.get(namespace,f.local.state.tables.receipts[0].cacheKey)).status,'ready');
});
