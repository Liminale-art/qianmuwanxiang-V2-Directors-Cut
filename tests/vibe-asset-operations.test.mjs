import test from 'node:test';
import assert from 'node:assert/strict';
import {createVibeAssetOperations} from '../qianmu-vibe-assets-worker.js';
import {parseNovelVibeFile,vibeDigest} from '../qianmu-vibe-file.js';
const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
const encoding=value=>btoa(value.repeat(32));
async function fixture({encodedOnly=false}={}){
  const doc={identifier:'novelai-vibe-transfer',version:1,type:encodedOnly?'encoding':'image',id:await vibeDigest(encodedOnly?encoding('a'):image),name:'Original',
    ...(encodedOnly?{}:{image,thumbnail:`data:image/png;base64,${image}`}),
    encodings:encodedOnly?{'v4-5full':{unknown:{encoding:encoding('a')}}}:{v4full:{a:{encoding:encoding('b'),params:{information_extracted:0}}},'v4-5full':{a:{encoding:encoding('a'),params:{information_extracted:0}},b:{encoding:encoding('c'),params:{information_extracted:.7}}}},
    importInfo:{strength:.6,information_extracted:1}};
  const [asset]=await parseNovelVibeFile(JSON.stringify(doc)),calls=[];
  const run=createVibeAssetOperations({head:async(...args)=>{calls.push(['head',...args]);return asset;},load:async(...args)=>{calls.push(['load',...args]);return asset;},preview:async()=>null});
  return {asset,doc,run,calls};
}
test('worker resolution returns only the exact model/IE encoding, while checks never copy binary data to the UI',async()=>{
  const e=await fixture(),options={namespace:'st-user:one',id:e.asset.assetId,model:'nai-diffusion-4-5-full',information:.7};
  const checked=await e.run({type:'check',...options});assert.equal(checked.kind,'novelai-vibe-encoding');assert.equal(Object.hasOwn(checked,'data'),false);
  const resolved=await e.run({type:'resolve',...options});assert.equal(resolved.data,encoding('c'));assert.equal(resolved.variant,'b');assert.equal(resolved.information,.7);
  const raw=await e.run({type:'resolve',...options,model:'nai-diffusion-3'});assert.equal(raw.data,image);assert.equal(raw.kind,'image');
  await assert.rejects(()=>e.run({type:'resolve',...options,information:.8}),{code:'vibe_file_missing_encoding'});
});

test('receipt adoption and export use its exact model/IE rather than another variant or old import defaults',async()=>{
  const e=await fixture(),before=structuredClone(e.asset),options={namespace:'st-user:one',id:e.asset.assetId,model:'nai-diffusion-4-full',information:0,expectedSourceId:e.doc.id};
  assert.deepEqual(await e.run({type:'library-info',...options}),{name:'Original',defaults:{strength:.6,information:0}});
  const blob=await e.run({type:'export-reviewed',...options}),[parsed]=await parseNovelVibeFile(await blob.text());
  assert.deepEqual(parsed.document.importInfo,{model:options.model,information_extracted:0,strength:.6});
  assert.deepEqual(parsed.document.encodings,e.doc.encodings);assert.equal(parsed.document.image,image);assert.deepEqual(e.asset,before);
  await assert.rejects(()=>e.run({type:'library-info',...options,expectedSourceId:'a'.repeat(64)}),{code:'vibe_file_source'});
  await assert.rejects(()=>e.run({type:'export-reviewed',...options,information:.7}),{code:'vibe_file_missing_encoding'});
});
test('full export keeps every original variant, overlays only edited file defaults, and leaves immutable source untouched',async()=>{
  const e=await fixture(),before=structuredClone(e.asset),blob=await e.run({type:'export',namespace:'st-user:one',ids:[e.asset.assetId],bundle:true,settings:[{name:'Edited',strength:0,information:.7}]});
  const text=await blob.text(),data=JSON.parse(text);assert.equal(data.identifier,'novelai-vibe-transfer-bundle');assert.equal(data.vibes.length,1);
  const [parsed]=await parseNovelVibeFile(text);assert.deepEqual(parsed.document.encodings,e.doc.encodings);assert.equal(parsed.document.image,image);
  assert.equal(parsed.document.name,'Edited');assert.deepEqual(parsed.document.importInfo,{strength:0,information_extracted:.7});assert.deepEqual(e.asset,before);
  assert.deepEqual(e.calls.map(row=>row[0]),['head','load']);
});
test('encoded-only unknown IE remains unknown across resolution and export, and cannot be used by V3',async()=>{
  const e=await fixture({encodedOnly:true}),options={namespace:'st-user:one',id:e.asset.assetId,model:'nai-diffusion-4-5-full',information:1};
  const resolved=await e.run({type:'resolve',...options});assert.equal(resolved.information,null);
  await assert.rejects(()=>e.run({type:'resolve',...options,model:'nai-diffusion-3'}),{code:'vibe_file_model'});
  const blob=await e.run({type:'export',namespace:'st-user:one',ids:[e.asset.assetId],settings:[{name:'Encoded',strength:0,information:1}]});
  const [parsed]=await parseNovelVibeFile(await blob.text());assert.deepEqual(parsed.document.encodings,e.doc.encodings);assert.equal(Object.hasOwn(parsed.document.importInfo,'information_extracted'),false);
  assert.equal(Object.hasOwn(parsed.document,'image'),false);assert.equal(parsed.summary.variants[0].information,null);
});
test('aggregate export and invalid operations fail before reading large bodies; deleted assets never produce a partial bundle',async()=>{
  let loads=0;const run=createVibeAssetOperations({head:async()=>({bytes:40*1024*1024}),load:async()=>loads++});
  await assert.rejects(()=>run({type:'export',ids:['a','b']}),{code:'vibe_file_size'});assert.equal(loads,0);
  await assert.rejects(()=>run({type:'unexpected',id:'a'}),{code:'vibe_file_operation'});assert.equal(loads,0);
  await assert.rejects(()=>run({type:'export',ids:['a'],settings:[{name:'a',strength:2,information:0}]}),{code:'vibe_file_params'});assert.equal(loads,0);
  const missing=createVibeAssetOperations({head:async()=>({bytes:10}),load:async()=>null});await assert.rejects(()=>missing({type:'export',ids:['a']}),{code:'vibe_file_missing'});
});
