import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {sha256} from '../vendor/noble-hashes-2.4.0/sha2.js';
import {chatGalleryReceiptText,chatGalleryReceiptSummary,CHAT_GALLERY_STREAM_LIMITS as LIMIT} from '../qianmu-chat-gallery-receipt.js';
import {chatGalleryDigest,scanChatGallery,createChatGalleryDigest,galleryDigestRecord} from '../qianmu-chat-gallery-digest.js';
import {createChatGalleryHeaderCapture} from '../qianmu-chat-gallery-header.js';
const sha=text=>createHash('sha256').update(text).digest('hex');
const oldSummary=rows=>{const {text,...rest}=chatGalleryReceiptText(rows);return {...rest,sha256:sha(text)};};
const frame=i=>({id:'i'+i,createdAt:i,unknown:{arr:[null,false,0,'字🌙'],nested:{z:' \\"\n',a:i}}});

test('vendored SHA256 matches Node across padding/block boundaries and interleaved instances',()=>{
  for(const length of [0,1,55,56,63,64,65,127,128,129,4097,128*1024]){
    const bytes=Uint8Array.from({length},(_,i)=>i%251),state=sha256.create();
    try{for(let at=0;at<length;at+=13)state.update(bytes.subarray(at,at+13));assert.equal(Buffer.from(state.digest()).toString('hex'),sha(bytes));}finally{state.destroy();}
  }
  const a=sha256.create(),b=sha256.create();a.update(new Uint8Array([1]));b.update(new Uint8Array([2]));
  assert.equal(Buffer.from(a.digest()).toString('hex'),sha(Buffer.from([1])));assert.equal(Buffer.from(b.digest()).toString('hex'),sha(Buffer.from([2])));
});
test('incremental summaries retain the exact old array digest, order and unknown fields',async()=>{
  for(const count of [0,1,2,15,16,17,31,128]){
    const rows=Array.from({length:count},(_,i)=>frame(i));assert.deepEqual(chatGalleryDigest(rows),oldSummary(rows));assert.deepEqual(await scanChatGallery(rows),oldSummary(rows));
  }
  assert.equal(chatGalleryDigest(undefined),null);const a=frame(1),b={unknown:a.unknown,createdAt:a.createdAt,id:a.id};
  assert.equal(galleryDigestRecord(a).sha256,galleryDigestRecord(b).sha256);
  assert.notEqual(chatGalleryDigest([a]).sha256,chatGalleryDigest([{...a,unknown:{added:true}}]).sha256);
  assert.notEqual(chatGalleryDigest([a,frame(2)]).sha256,chatGalleryDigest([frame(2),a]).sha256);
});
test('over 2 MiB gallery gives the same client and saved-header digest without whole-array text',async()=>{
  const rows=Array.from({length:8},(_,i)=>({...frame(i),unknown:{body:'界'.repeat(100000)}})),capture=createChatGalleryHeaderCapture();
  const header=JSON.stringify({chat_metadata:{story_director_liminale:{storyboardImages:rows}}});
  for(let at=0;at<header.length;at+=7001)capture.write(header.slice(at,at+7001));
  const result=await scanChatGallery(rows);assert.ok(result.bytes>2*1024*1024);assert.deepEqual(result,capture.finish().gallery);
  assert.throws(()=>chatGalleryReceiptText(rows));
});
test('scan yields actual event-loop turns and cancellation stops before the next record',async()=>{
  const rows=Array.from({length:80},(_,i)=>frame(i));let turns=0,visits=0,allowed=true;const tick=setInterval(()=>turns++,0);
  try{await scanChatGallery(rows,{visit:()=>visits++});assert.ok(turns>=4);assert.equal(visits,80);}finally{clearInterval(tick);}
  visits=0;await assert.rejects(scanChatGallery(rows,{guard:()=>{if(!allowed)throw Error('cancel');},yieldWork:async()=>{if(visits>=16)allowed=false;},visit:()=>visits++}),/cancel/);assert.equal(visits,16);
});
test('accessors, holes, symbols and hidden fields fail without invoking getters',async()=>{
  let invoked=0;const rows=[frame(0)];Object.defineProperty(rows,'0',{enumerable:true,get(){invoked++;return frame(0);}});
  for(const value of [rows,new Array(2),Object.assign([frame(0)],{extra:1})])await assert.rejects(scanChatGallery(value));
  const raw=frame(0);Object.defineProperty(raw,'future',{enumerable:true,get(){invoked++;return 'x';}});assert.throws(()=>chatGalleryDigest([raw]));assert.equal(invoked,0);
  const symbol=frame(1);symbol[Symbol('x')]=1;assert.throws(()=>chatGalleryDigest([symbol]));
});
test('append or removal during a yield cannot hash only a prefix',async()=>{
  for(const mutate of [rows=>rows.push(frame(99)),rows=>rows.pop()]){
    const rows=Array.from({length:20},(_,i)=>frame(i));let visited=0;
    await assert.rejects(scanChatGallery(rows,{visit:()=>visited++,yieldWork:async()=>{if(visited>=16)mutate(rows);}}),/条数/);
  }
});
test('aggregate bounds do not raise per-record limits and failed digest instances cannot be reused',()=>{
  const state=createChatGalleryDigest(),record={id:'large',body:'x'.repeat(600000)};
  assert.throws(()=>{for(let i=0;i<60;i++)state.append(record);},/超过分批/);assert.throws(()=>state.finish());
  assert.throws(()=>chatGalleryDigest([{body:'x'.repeat(2*1024*1024)}]));assert.throws(()=>chatGalleryDigest(Array.from({length:LIMIT.records+1},()=>({}))));
  assert.throws(()=>chatGalleryReceiptSummary({count:1,bytes:LIMIT.bytes+1,sha256:'a'.repeat(64)}));
  assert.throws(()=>chatGalleryReceiptSummary({count:1,bytes:200,sha256:'a'.repeat(64),prompt:'extra'}));
});
test('whole-gallery node budget cannot be reset by appending another record',()=>{
  const state=createChatGalleryDigest(),record={list:Array.from({length:20000},()=>1)};
  assert.throws(()=>{for(let i=0;i<21;i++)state.append(record);},/超过分批/);
});
