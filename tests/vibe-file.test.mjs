import test from 'node:test';
import assert from 'node:assert/strict';
import {parseNovelVibeFile as parse,exportNovelVibeFile as serialize,vibeDigest as digest,vibeVariants,selectNovelVibeEncoding as select,VIBE_FILE_LIMITS} from '../qianmu-vibe-file.js';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
const bytes=number=>Buffer.alloc(160,number).toString('base64');
const variant=(value,info)=>({encoding:bytes(value),params:{information_extracted:info}});
async function fixture(){return {identifier:'novelai-vibe-transfer',version:1,type:'image',image:png,id:await digest(png),name:'光影',
  thumbnail:`data:image/png;base64,${png}`,createdAt:'2026-09-07T00:00:00.000Z',
  encodings:{v4full:{first:variant(1,0),second:variant(2,.7)},'v4-5full':{third:variant(3,.7)},futuremodel:{future:variant(4,.8)}},
  importInfo:{model:'nai-diffusion-4-full',information_extracted:0,strength:0}};}

test('official image file retains ALL model groups/IE variants and exact zero settings',async()=>{
  const doc=await fixture(),[asset]=await parse(JSON.stringify(doc));
  assert.deepEqual(asset.document,doc);assert.equal(asset.summary.variants.length,4);assert.equal(asset.summary.hasImage,true);
  assert.equal(asset.summary.variants[0].information,0);assert.equal(asset.document.importInfo.strength,0);
  assert.equal(asset.assetId.length,64);assert.equal(asset.summary.assetId,asset.assetId);assert.equal(asset.bytes,Buffer.byteLength(asset.serialized));
  assert.deepEqual(JSON.parse(await serialize([asset.document])),doc);
  assert.deepEqual((await parse(await serialize([doc,doc]))).map(row=>row.assetId),[asset.assetId,asset.assetId]);
});
test('content identity is immutable, independent of whitespace, and includes every encoding',async()=>{
  const doc=await fixture(),[a]=await parse(JSON.stringify(doc));
  const [b]=await parse(JSON.stringify(doc,null,2));assert.equal(a.assetId,b.assetId);
  const changed=structuredClone(doc);changed.encodings.futuremodel.future.encoding=bytes(5);
  assert.notEqual((await parse(JSON.stringify(changed)))[0].assetId,a.assetId);
  assert.equal(await digest(doc.image),doc.id);assert.notEqual(await digest(Buffer.from(doc.image,'base64')),doc.id);
});
test('encoded-only files have no fabricated image; absent params stay unknown, never defaulted to 1',async()=>{
  const encoding=bytes(6),doc={identifier:'novelai-vibe-transfer',version:1,type:'encoding',id:await digest(encoding),
    encodings:{v4full:{unknown:{encoding}}}};
  const [asset]=await parse(JSON.stringify(doc));assert.equal(asset.summary.hasImage,false);assert.equal(asset.summary.hasThumbnail,false);
  assert.equal(own(asset.document,'image'),false);assert.equal(asset.summary.variants[0].information,null);
  assert.equal(select(asset.document,'nai-diffusion-4-full',.5).information,null);
  assert.throws(()=>select(asset.document,'nai-diffusion-4-5-full',.5),/没有原图/);
  assert.deepEqual((await parse(await serialize([asset.document])))[0].document,doc);
});
const own=(value,key)=>Object.hasOwn(value,key);
test('selection uses canonical capabilities, exact IE, and refuses unknown model/seed/mask or ambiguous encodings',async()=>{
  const doc=await fixture();assert.equal(select(doc,'nai-diffusion-4-full',0).encoding,bytes(1));
  assert.equal(select(doc,'nai-diffusion-4-5-full',.7).encoding,bytes(3));
  for(const model of ['vendor/NAI','nai-diffusion-5-full','nai-diffusion-3'])assert.throws(()=>select(doc,model,0),/没有已确认/);
  assert.throws(()=>select(doc,'nai-diffusion-4-full',.7000001),/尚未编码/);
  doc.encodings.v4full.second.params.focus_seed=5;
  assert.throws(()=>select(doc,'nai-diffusion-4-full',.7),/尚未编码/);
  doc.encodings.v4full.second=variant(2,0);assert.throws(()=>select(doc,'nai-diffusion-4-full',0),/不同编码/);
  doc.encodings.v4full.second=variant(1,0);assert.equal(select(doc,'nai-diffusion-4-full',0).encoding,bytes(1));
});
test('masked and extended parameters round trip but are NOT mistaken for the unmasked default encoding',async()=>{
  const doc=await fixture();doc.encodings.v4full.second.params.mask=png;doc.encodings.v4full.second.params.crop_to_mask=true;
  const [asset]=await parse(JSON.stringify(doc));assert.deepEqual(asset.document.encodings.v4full.second.params,doc.encodings.v4full.second.params);
  assert.equal(vibeVariants(asset.document).find(row=>row.variant==='second').customParams,true);
  assert.throws(()=>select(asset.document,'nai-diffusion-4-full',.7),/尚未编码/);
});
test('duplicate JSON fields including escaped keys and malicious object keys are rejected without partial success',async()=>{
  const text=JSON.stringify(await fixture());
  for(const bad of [text.replace('"version":1','"version":1,"version":1'),text.replace('"version":1','"version":1,"\\u0076ersion":1'),
    text.replace('"first":','"__proto__":'),text.replace('"first":','"constructor":'),text.replace('"first":','"prototype":')]){
    await assert.rejects(()=>parse(bad),error=>/^vibe_file_(duplicate|format)$/.test(error.code));
  }
  const doc=await fixture();doc.name='a\\"quoted,{}[]:';assert.equal((await parse(JSON.stringify(doc)))[0].document.name,doc.name);
});
test('truncated/forged image, invalid base64, wrong hash/version/size, and unknown envelope fields fail atomically',async()=>{
  const doc=await fixture();
  for(const mutate of [d=>d.version=2,d=>d.identifier='other',d=>d.id='0'.repeat(64),d=>d.image=png.slice(0,-4),
    d=>d.encodings.v4full.first.encoding='A===',d=>d.encodings.v4full.first.encoding='Zh==',
    d=>d.encodings.v4full.first.params.information_extracted=1.01,d=>d.thumbnail='https://example.test/img.png',
    d=>d.thumbnail=`data:image/jpeg;base64,${png}`,d=>d.secret='unsupported',d=>d.name='A'.repeat(101),
    d=>d.encodings.v4full.first.params.future={nested:true}]){
    const bad=structuredClone(doc);mutate(bad);await assert.rejects(()=>parse(JSON.stringify({identifier:'novelai-vibe-transfer-bundle',version:1,vibes:[doc,bad]})),e=>e.code?.startsWith('vibe_file_'));
  }
  await assert.rejects(()=>parse('{}'),/结构|格式|受支持/);
  await assert.rejects(()=>parse('{'),/JSON/);
  await assert.rejects(()=>parse(' '.repeat(VIBE_FILE_LIMITS.file+1)),/64 MB/);
  await assert.rejects(()=>serialize(Array(17).fill(doc)),/1～16/);
  await assert.rejects(()=>serialize([doc,doc],{bundle:false}),/1～16/);
});
test('model/variant bounds refuse excess instead of silently keeping only the first items',async()=>{
  const doc=await fixture();doc.encodings=Object.fromEntries(Array.from({length:33},(_,i)=>[`m${i}`,{one:variant(i,0)}]));
  await assert.rejects(()=>parse(JSON.stringify(doc)),/模型编码/);
  doc.encodings={v4full:Object.fromEntries(Array.from({length:257},(_,i)=>[`v${i}`,variant(i,0)]))};
  await assert.rejects(()=>parse(JSON.stringify(doc)),/档位/);
});
test('encoded-only multi-model order is preserved so official source IDs remain valid after export',async()=>{
  const first=bytes(2),doc={identifier:'novelai-vibe-transfer',version:1,type:'encoding',id:await digest(first),
    encodings:{zfuture:{unknown:{encoding:first}},v4full:{unknown:{encoding:bytes(1)}}}};
  const [asset]=await parse(JSON.stringify(doc));const [again]=await parse(await serialize([asset.document]));
  assert.equal(again.assetId,asset.assetId);assert.deepEqual(Object.keys(again.document.encodings),['zfuture','v4full']);
});
test('oversized decode dimensions and container-only fake PNGs are rejected before preview',async()=>{
  const doc=await fixture(),large=Buffer.from(png,'base64');large.writeUInt32BE(0x7fffffff,16);doc.image=large.toString('base64');doc.id=await digest(doc.image);
  await assert.rejects(()=>parse(JSON.stringify(doc)),/尺寸/);
  const original=Buffer.from(png,'base64'),fake=Buffer.concat([original.subarray(0,8),original.subarray(-12)]);doc.image=fake.toString('base64');doc.id=await digest(doc.image);
  await assert.rejects(()=>parse(JSON.stringify(doc)),/尺寸/);
});
