import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createVibeNativeOriginals,validateVibeNativeOriginal,VIBE_NATIVE_ORIGINAL_SLOT,VIBE_NATIVE_ORIGINAL_LIMITS as limits} from '../qianmu-vibe-native-original.js';
import {validateVibeAssetHead,VIBE_ASSET_LIMITS,vibeAssetKey} from '../qianmu-vibe-asset-contract.js';
import {parseNovelVibeFile,vibeFilePreview,vibeDigest,selectNovelVibeEncoding} from '../qianmu-vibe-file.js';
import {characterNativeFixture,namespace} from './helpers/character-native-fixture.mjs';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
async function assetInput({encoded=false,large=false,legacy=false}={}){
  const encoding=Buffer.alloc(large?900000:160,7).toString('base64');
  const doc={identifier:'novelai-vibe-transfer',version:1,type:encoded?'encoding':'image',id:await vibeDigest(encoded?encoding:png),name:'光影 🦋',
    encodings:{futuremodel:{unknown:{encoding}},v4full:{zero:{encoding:btoa('other'),params:{information_extracted:0}},masked:{encoding:btoa('masked'),params:{information_extracted:.7,mask:png,crop_to_mask:true,remark:'汉字🦋'.repeat(500)}}}},
    importInfo:{strength:0,information_extracted:0}};
  if(!encoded){doc.image=png;doc.thumbnail=`data:image/png;base64,${png}`;}
  const [asset]=await parseNovelVibeFile(JSON.stringify(doc)),preview=legacy?null:vibeFilePreview(doc);
  const head={key:vibeAssetKey(namespace,asset.assetId),namespace,assetId:asset.assetId,bytes:asset.bytes,summary:asset.summary,createdAt:1.25};
  if(!legacy)head.previewBytes=preview?.size||0;
  return {head,serialized:asset.serialized,preview,asset};
}
async function fixture(t){const f=await characterNativeFixture(t),clients=[];t.after(()=>clients.forEach(client=>client.close()));
  const open=async(options={})=>{const client=await f.createStorage({maxBytes:limits.manifest});clients.push(client);return createVibeNativeOriginals(client,options);};
  return {...f,originals:await open(),openOriginals:open,get uploads(){return f.uploads;}};
}
const bodyFiles=f=>[...f.files.keys()].filter(name=>name.includes('-vibe-original-part-'));

test('independent native clients retain complete Vibe originals, all encodings, exact zero defaults and preview',async t=>{
  const f=await fixture(t),input=await assetInput(),saved=await f.originals.preserve(input),b=await f.openOriginals();
  assert.deepEqual(saved.head,input.head);assert.deepEqual(await b.load(saved.reference,input.head),input.asset);
  const preview=await b.preview(saved.reference,input.head);assert.equal(preview.type,input.preview.type);assert.deepEqual(await preview.arrayBuffer(),await input.preview.arrayBuffer());
  const loaded=await b.load(saved.reference);assert.equal(selectNovelVibeEncoding(loaded.document,'nai-diffusion-4-full',0).encoding,btoa('other'));
  assert.throws(()=>selectNovelVibeEncoding(loaded.document,'nai-diffusion-4-full',.7),/尚未编码/);
  assert.ok(!f.calls.some(call=>/delete|plugins|completions|generate|encode-vibe/.test(call.path)));
  assert.ok([...f.files.values()].every(text=>JSON.parse(text).schema==='qianmu.st-account-document.v1'));
});

test('metadata inspection and preview never download a large image or encoding body',async t=>{
  const f=await fixture(t),input=await assetInput({large:true}),saved=await f.originals.preserve(input);assert.ok(bodyFiles(f).length>2);
  f.reset();const result=await f.originals.inspect(saved.reference,input.head);assert.deepEqual(result.head,input.head);
  assert.equal(f.calls.length,1);assert.ok(!f.calls.some(call=>call.path.includes('-vibe-original-part-')));
  await f.originals.preview(saved.reference,input.head);assert.ok(!f.calls.some(call=>call.path.includes('-vibe-original-part-')));
  assert.equal((await f.originals.load(saved.reference)).serialized,input.serialized);
  for(const [name,text] of f.files)if(name.includes('-vibe-original-part-')){assert.ok(Buffer.byteLength(text)<=limits.part+1024);const part=JSON.parse(text).value;
    assert.equal(new TextDecoder().decode(new TextEncoder().encode(part)),part);assert.ok(part.length<=65536);}
});

test('pure encoding original keeps unknown IE and has no fabricated image or thumbnail',async t=>{
  const f=await fixture(t),input=await assetInput({encoded:true}),saved=await f.originals.preserve(input),loaded=await f.originals.load(saved.reference);
  assert.deepEqual(loaded,input.asset);assert.equal(loaded.summary.variants[0].information,null);assert.equal(loaded.document.image,undefined);
  f.reset();assert.equal(await f.originals.preview(saved.reference),null);assert.equal(f.calls.length,1);
});

test('legacy absent previewBytes stays absent even when the raw file contains a thumbnail',async t=>{
  const f=await fixture(t),input=await assetInput({legacy:true}),saved=await f.originals.preserve(input);
  assert.equal(Object.hasOwn(saved.head,'previewBytes'),false);assert.equal(await f.originals.preview(saved.reference),null);
  assert.ok((await f.originals.load(saved.reference)).document.thumbnail);assert.ok(![...f.files.keys()].some(name=>name.includes('-vibe-preview-part-')));
});

test('complete legacy metadata including unknown nested fields, controls and fractional timestamps is retained',async t=>{
  const f=await fixture(t),input=await assetInput();input.head.future={text:'\0\n 🦋 ',bool:false,zero:0,rows:[null,{'quoted key':'value'}]};
  const saved=await f.originals.preserve(input);assert.deepEqual((await f.originals.inspect(saved.reference)).head,input.head);assert.equal(saved.head.createdAt,1.25);
});

test('non-JSON metadata is rejected without silently dropping fields or changing numbers',async t=>{
  const f=await fixture(t),input=await assetInput();
  for(const value of [NaN,undefined,new Date(0),new Array(2),-0,Infinity,()=>0]){const head={...input.head,future:value};await assert.rejects(f.originals.preserve({...input,head}));}
  for(const head of [Object.defineProperty({...input.head},'hidden',{value:'keep'}),Object.defineProperty({...input.head},'future',{get(){throw Error('must not run');},enumerable:true}),{...input.head,[Symbol('keep')]:'x'}]){
    await assert.rejects(f.originals.preserve({...input,head}));}
  assert.equal(f.uploads,0);
});

test('invalid, foreign, changed or noncanonical originals fail before preservation starts',async t=>{
  const f=await fixture(t),input=await assetInput();
  for(const change of [v=>v.head.namespace='st-user:other',v=>v.head.bytes++,v=>v.head.summary.name='changed',v=>v.serialized=' '+v.serialized,
    v=>v.serialized='{}',v=>v.serialized=v.serialized.replace('光影','错误'),v=>v.head.assetId='a'.repeat(64)]){
    const value={...input,head:structuredClone(input.head)};change(value);await assert.rejects(f.originals.preserve(value));}
  assert.equal(f.uploads,0);
});

test('missing or inconsistent legacy preview is rejected before any native original is written',async t=>{
  const f=await fixture(t),input=await assetInput();
  for(const preview of [null,new Blob(['different'],{type:'image/png'}),new Blob([await input.preview.arrayBuffer()],{type:'image/jpeg'}),
    new Blob([Buffer.alloc(input.preview.size,1)],{type:'image/png'})])await assert.rejects(f.originals.preserve({...input,preview}));
  const legacy=await assetInput({legacy:true});await assert.rejects(f.originals.preserve({...legacy,preview:input.preview}));assert.equal(f.uploads,0);
});

test('metadata and references are account/slot/version bound and cannot select another path',async t=>{
  const f=await fixture(t),input=await assetInput(),saved=await f.originals.preserve(input),{manifest}=await f.originals.inspect(saved.reference);f.reset();
  for(const patch of [{scope:'a'.repeat(64)},{slot:'configuration-mutation-journal'},{version:2},{bytes:limits.manifest+1025},{url:'https://other.invalid'}]){
    await assert.rejects(f.originals.load({...saved.reference,...patch}));}
  assert.equal(f.calls.length,0);
  for(const change of [m=>m.namespace='st-user:other',m=>m.body.parts[0].slot='vibe-preview-part',m=>m.body.digest='f'.repeat(64),m=>m.preview.bytes++,
    m=>m.body.parts[0].scope='a'.repeat(64),m=>m.preview.content.bytes++,m=>m.extra=true]){
    const m=structuredClone(manifest);change(m);assert.throws(()=>validateVibeNativeOriginal(m,{namespace,scope:f.storage.scope}));}
});

test('all existing count/file bounds stay fixed; excess part counts and native metadata are rejected',async t=>{
  const f=await fixture(t),input=await assetInput(),saved=await f.originals.preserve(input),{manifest}=await f.originals.inspect(saved.reference);
  assert.equal(VIBE_ASSET_LIMITS.count,1024);assert.equal(VIBE_ASSET_LIMITS.bytes,512*1048576);assert.equal(limits.body,64*1048576);
  for(const change of [m=>m.body.bytes=limits.body+1,m=>m.body.parts=Array(1025).fill(m.body.parts[0]),m=>m.body.parts[0].bytes=limits.part+1025,
    m=>m.body.parts=[],m=>m.preview.content.parts=Array(44).fill(m.preview.content.parts[0]),m=>m.headText=' '.repeat(limits.head+1)]){
    const m=structuredClone(manifest);change(m);assert.throws(()=>validateVibeNativeOriginal(m,{namespace,scope:f.storage.scope}));}
  const before=f.uploads;await assert.rejects(f.originals.preserve({...input,head:{...input.head,future:'a'.repeat(limits.head)}}));assert.equal(f.uploads,before);
});

test('missing and corrupted body parts are failures, not alternate versions or empty assets',async t=>{
  for(const corrupt of [false,true]){const f=await fixture(t),input=await assetInput(),saved=await f.originals.preserve(input),name=bodyFiles(f)[0];
    if(corrupt)f.files.set(name,f.files.get(name).replace('光影','错误'));else f.files.delete(name);
    const before=f.uploads;await assert.rejects(f.originals.load(saved.reference));assert.equal(f.uploads,before);
    assert.equal((await f.originals.inspect(saved.reference)).head.assetId,input.head.assetId);
  }
});

test('missing preview fails independently while the complete source still loads unchanged',async t=>{
  const f=await fixture(t),input=await assetInput(),saved=await f.originals.preserve(input);f.files.delete([...f.files.keys()].find(name=>name.includes('-vibe-preview-part-')));
  await assert.rejects(f.originals.preview(saved.reference));assert.deepEqual(await f.originals.load(saved.reference),input.asset);
});

test('a forged but transport-valid reordered manifest is rejected by full-body hashing',async t=>{
  const f=await fixture(t),input=await assetInput({large:true}),saved=await f.originals.preserve(input),{manifest}=await f.originals.inspect(saved.reference);
  manifest.body.parts.reverse();const forged=await f.storage.preserveImmutable(VIBE_NATIVE_ORIGINAL_SLOT,manifest);
  await assert.rejects(f.originals.load(forged.reference),/摘要|长度/);
});

test('transport-valid preview with a forged digest or invalid image still cannot be displayed',async t=>{
  const f=await fixture(t),input=await assetInput(),saved=await f.originals.preserve(input),{manifest}=await f.originals.inspect(saved.reference);
  manifest.preview.digest='a'.repeat(64);let forged=await f.storage.preserveImmutable(VIBE_NATIVE_ORIGINAL_SLOT,manifest);await assert.rejects(f.originals.preview(forged.reference));
  const raw=Buffer.alloc(input.preview.size,1),text=raw.toString('base64'),part=await f.storage.preserveImmutable('vibe-preview-part',text);
  manifest.preview.digest=await vibeDigest(new Uint8Array(raw));manifest.preview.content={digest:await vibeDigest(text),bytes:Buffer.byteLength(text),parts:[part.reference]};
  forged=await f.storage.preserveImmutable(VIBE_NATIVE_ORIGINAL_SLOT,manifest);await assert.rejects(f.originals.preview(forged.reference));
});

test('exact selected head mismatch is rejected before downloading the original body',async t=>{
  const f=await fixture(t),input=await assetInput(),saved=await f.originals.preserve(input);f.reset();
  await assert.rejects(f.originals.load(saved.reference,{...input.head,createdAt:2}),/选定目录/);
  assert.ok(!f.calls.some(call=>call.path.includes('-vibe-original-part-')));
});

test('duplicate explicit preservation verifies immutable bytes and uploads nothing twice',async t=>{
  const f=await fixture(t),input=await assetInput(),a=await f.originals.preserve(input),before=f.uploads,b=await f.originals.preserve(input);
  assert.deepEqual(b,a);assert.equal(f.uploads,before);
});

test('lost part acknowledgement stops without a manifest and explicit reopen reuses checked parts',async t=>{
  const f=await fixture(t),input=await assetInput({large:true});let once=false;
  f.hook(call=>{if(call.request.method==='POST'&&!once){once=true;const {name,data}=JSON.parse(call.request.body);f.files.set(name,Buffer.from(data,'base64').toString());throw Error('lost reply');}});
  await assert.rejects(f.originals.preserve(input));assert.equal(f.uploads,1);assert.ok(![...f.files.keys()].some(name=>/-vibe-original-[a-f0-9]{64}\.json$/.test(name)));
  f.hook(null);f.reset();const saved=await (await f.openOriginals()).preserve(input);
  assert.deepEqual(await f.originals.load(saved.reference),input.asset);const first=bodyFiles(f)[0];assert.ok(!f.calls.some(call=>call.request.method==='POST'&&JSON.parse(call.request.body).name===first));
});

test('lost complete-original acknowledgement never retries automatically and later explicit verification needs no upload',async t=>{
  const f=await fixture(t),input=await assetInput();f.hook(call=>{if(call.request.method==='POST'){const {name,data}=JSON.parse(call.request.body);
    if(/-vibe-original-[a-f0-9]{64}\.json$/.test(name)){f.files.set(name,Buffer.from(data,'base64').toString());throw Error('lost final reply');}}});
  await assert.rejects(f.originals.preserve(input));const before=f.uploads;f.hook(null);const saved=await f.originals.preserve(input);assert.equal(f.uploads,before);
  assert.deepEqual(await f.originals.load(saved.reference),input.asset);
});

test('live account change during preservation halts before publishing a complete original',async t=>{
  const f=await fixture(t),input=await assetInput();let once=false;f.hook(call=>{if(call.request.method==='POST'&&!once){once=true;f.account('st-user:changed');}});
  await assert.rejects(f.originals.preserve(input));assert.equal(f.uploads,1);assert.ok(![...f.files.keys()].some(name=>/-vibe-original-[a-f0-9]{64}\.json$/.test(name)));
});

test('cancelled/expired caller scope writes nothing and cancellation after verified progress stops further work',async t=>{
  const f=await fixture(t),input=await assetInput({large:true}),controller=new AbortController();controller.abort();
  await assert.rejects((await f.openOriginals({signal:controller.signal})).preserve(input));
  await assert.rejects((await f.openOriginals({guard:()=>false})).preserve(input));assert.equal(f.uploads,0);
  const active=new AbortController(),events=[],api=await f.openOriginals({signal:active.signal,onProgress:event=>{events.push(event);active.abort();}});
  await assert.rejects(api.preserve(input));assert.equal(events.length,1);assert.equal(events[0].stage,'body-part');assert.equal(f.uploads,1);
});

test('input head is captured before yielding and later UI edits cannot change stored metadata',async t=>{
  const f=await fixture(t),input=await assetInput(),before=structuredClone(input.head),pending=f.originals.preserve(input);input.head.createdAt=99;
  const saved=await pending;assert.deepEqual(saved.head,before);assert.deepEqual((await f.originals.inspect(saved.reference)).head,before);
});

test('progress only follows readback; returned mismatch does not emit completion',async t=>{
  const f=await fixture(t),input=await assetInput(),events=[],real=f.storage;
  const client={namespace,scope:real.scope,readImmutable:real.readImmutable,preserveImmutable:async(...args)=>{const result=await real.preserveImmutable(...args);return {...result,value:'different'};}};
  const api=createVibeNativeOriginals(client,{onProgress:event=>events.push(event)});await assert.rejects(api.preserve(input));assert.deepEqual(events,[]);
});

test('a full-size supplied preview spans its own bounded parts and is recovered without reading original encoding parts',async t=>{
  const original=Buffer.from(png,'base64'),payload=Buffer.concat([Buffer.from('Comment\0'),Buffer.alloc(limits.preview-original.length-12-8,120)]);
  const chunk=Buffer.alloc(payload.length+12);chunk.writeUInt32BE(payload.length,0);chunk.write('tEXt',4);payload.copy(chunk,8);
  let crc=0xffffffff;for(const value of chunk.subarray(4,-4)){crc^=value;for(let bit=0;bit<8;bit++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}chunk.writeUInt32BE((crc^0xffffffff)>>>0,chunk.length-4);
  const previewBytes=Buffer.concat([original.subarray(0,-12),chunk,original.subarray(-12)]);assert.equal(previewBytes.length,limits.preview);
  const input=await assetInput(),doc={...input.asset.document,thumbnail:`data:image/png;base64,${previewBytes.toString('base64')}`},[asset]=await parseNovelVibeFile(JSON.stringify(doc));
  const head={...input.head,key:vibeAssetKey(namespace,asset.assetId),assetId:asset.assetId,bytes:asset.bytes,previewBytes:limits.preview,summary:asset.summary};
  const f=await fixture(t),saved=await f.originals.preserve({head,serialized:asset.serialized,preview:vibeFilePreview(doc)});f.reset();
  const restored=await f.originals.preview(saved.reference);assert.deepEqual(new Uint8Array(await restored.arrayBuffer()),new Uint8Array(previewBytes));
  assert.equal(f.calls.filter(call=>call.path.includes('-vibe-preview-part-')).length,43);assert.ok(!f.calls.some(call=>call.path.includes('-vibe-original-part-')));
});

test('a Unicode surrogate pair exactly at the part boundary is never split or altered',async t=>{
  const input=await assetInput(),doc=structuredClone(input.asset.document);doc.encodings.futuremodel.unknown.encoding=Buffer.alloc(48000,7).toString('base64');
  doc.encodings.futuremodel.unknown.params={note:''};const needle='"note":"',initial=JSON.stringify(doc),at=initial.indexOf(needle)+needle.length;
  assert.ok(at<65535&&at>62000);doc.encodings.futuremodel.unknown.params.note='x'.repeat(65535-at)+'🦋tail';
  const [asset]=await parseNovelVibeFile(JSON.stringify(doc));assert.equal(asset.serialized.charCodeAt(65535),0xd83e);
  const head={...input.head,key:vibeAssetKey(namespace,asset.assetId),assetId:asset.assetId,bytes:asset.bytes,summary:asset.summary},f=await fixture(t);
  const saved=await f.originals.preserve({head,serialized:asset.serialized,preview:input.preview});assert.equal((await f.originals.load(saved.reference)).serialized,asset.serialized);
  const parts=bodyFiles(f).map(name=>JSON.parse(f.files.get(name)).value);assert.equal(parts[0].length,65535);assert.equal(parts[1].slice(0,2),'🦋');
});

test('shared IDB head validation keeps the original legacy contract and new modules are explicitly packaged',async()=>{
  const input=await assetInput({legacy:true});assert.equal(validateVibeAssetHead(input.head,namespace),input.head);
  for(const change of [h=>h.previewBytes=-1,h=>h.bytes=0,h=>h.summary.variants[0].information=2,h=>h.createdAt=Infinity,h=>h.key='other']){
    const head=structuredClone(input.head);change(head);assert.throws(()=>validateVibeAssetHead(head,namespace));}
  const release=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8'));
  for(const name of ['qianmu-vibe-asset-contract.js','qianmu-vibe-native-original.js'])assert.ok(release.files.includes(name));
  const source=await readFile(new URL('../qianmu-vibe-native-original.js',import.meta.url),'utf8');assert.doesNotMatch(source,/fetch\(|indexedDB|client\.(?:delete|update|write)\(/);
});
