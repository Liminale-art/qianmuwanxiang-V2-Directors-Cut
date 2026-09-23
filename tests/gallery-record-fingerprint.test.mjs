import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {galleryRecordFingerprintText} from '../qianmu-gallery-record-fingerprint.js';
import {chatGalleryReceiptRecordText,CHAT_GALLERY_RECEIPT_LIMITS as LIMIT} from '../qianmu-chat-gallery-receipt.js';
import {captureGalleryArchiveJson,GALLERY_PAGE_INDEX_LIMITS} from '../qianmu-gallery-page-index.js';
import {chatGalleryDigest,scanChatGallery,createChatGalleryDigest,galleryDigestRecord} from '../qianmu-chat-gallery-digest.js';
const legacy=raw=>chatGalleryReceiptRecordText(captureGalleryArchiveJson(raw,GALLERY_PAGE_INDEX_LIMITS.recordBytes));
const digest=rows=>{const state=createChatGalleryDigest();try{for(const row of rows)state.append(row);return state.finish();}finally{state.close();}};
const nested=depth=>{let value=0;while(depth--)value={next:value};return value;};
const frame=id=>({id,unknown:{arr:[null,false,-0,'字🌙'],nested:{z:' \\"\n',a:42}}});
const rejectedByBoth=value=>{assert.throws(()=>legacy(value));assert.throws(()=>galleryRecordFingerprintText(value));assert.throws(()=>chatGalleryDigest([value]));};

test('hash-only records preserve lexical keys, numeric array order, unknown fields and scalar JSON representation',()=>{
  const shared={value:'same'},empty=Object.create(null),values=[{},empty,frame('one'),
    {10:'ten',2:'two',1:'one',array:Array.from({length:12},(_,i)=>i)},
    {numbers:[-0,0,Number.MIN_VALUE,Number.MAX_VALUE,1e-7,1e21],bool:[true,false],nil:null},
    {a:shared,b:shared,toJSON:'ordinary data'},Object.assign(Object.create(null),{z:empty,a:['\u2028','\u2029','\0','\\','"','𐀀','􏿿']})];
  for(const value of values)assert.deepEqual(galleryRecordFingerprintText(value),legacy(value));
  assert.deepEqual(chatGalleryDigest(values),digest(values));
});
test('deterministic generated JSON agrees with the prior capture/canonical pipeline for 600 full records',()=>{
  let seed=0x739B129;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
  const strings=['','字🌙','a\n"\\','0','line\r\tend','é','\u2028'];
  function value(depth=0){
    const choice=Math.floor(random()*(depth<4?7:5));
    if(choice===0)return null;if(choice===1)return random()<.5;if(choice===2)return (random()-.5)*1e23;
    if(choice<5)return strings[Math.floor(random()*strings.length)];
    if(choice===5)return Array.from({length:Math.floor(random()*5)},()=>value(depth+1));
    const result=Object.create(random()<.5?null:Object.prototype);
    for(let i=0;i<Math.floor(random()*5);i++)result['key-'+i]=value(depth+1);return result;
  }
  const rows=Array.from({length:600},(_,id)=>({id,unknown:value()}));
  for(const row of rows)assert.deepEqual(galleryRecordFingerprintText(row),legacy(row));
  assert.deepEqual(chatGalleryDigest(rows),digest(rows));
});
test('unpaired surrogate strings and keys are rejected, while all valid boundary pairs agree',()=>{
  for(const value of ['\uD800','\uDC00','x\uD800x','\uD800\uD800','\uDC00\uD800','🌙\uDFFF']){
    rejectedByBoth({value});rejectedByBoth({[value]:1});
  }
  for(const value of ['\uD800\uDC00','\uDBFF\uDFFF','🌙🌙','x🌙y','\uD7FF','\uE000'])assert.deepEqual(galleryRecordFingerprintText({[value]:value}),legacy({[value]:value}));
});
test('byte limits still reserve the receipt array, including UTF8 and escape expansion',()=>{
  for(const [character,length] of [['x',LIMIT.bytes-10],['界',Math.floor((LIMIT.bytes-10)/3)],['\0',Math.floor((LIMIT.bytes-10)/6)]]){
    const row={v:character.repeat(length)};assert.deepEqual(galleryRecordFingerprintText(row),legacy(row));
    rejectedByBoth({v:row.v+character});
  }
});
test('capture depth and key-inclusive node budgets are unchanged',()=>{
  assert.deepEqual(galleryRecordFingerprintText(nested(24)),legacy(nested(24)));rejectedByBoth(nested(25));
  const accepted={list:Array.from({length:49998},()=>1)},denied={list:Array.from({length:49999},()=>1)};
  assert.deepEqual(galleryRecordFingerprintText(accepted),legacy(accepted));rejectedByBoth(denied);
});
test('cycles, non-JSON scalars, unsafe keys, special objects, sparse/extended arrays and symbol fields still fail closed',()=>{
  const cycle={};cycle.self=cycle;
  const hidden={};Object.defineProperty(hidden,'private',{value:1});
  const arrayHidden=[1];Object.defineProperty(arrayHidden,'0',{enumerable:false});
  const symbol={};symbol[Symbol('field')]=1;
  for(const value of [null,[],true,'root',cycle,hidden,symbol,{v:undefined},{v:NaN},{v:Infinity},{v:1n},{v:()=>{}},
    {v:new Date()},{v:new Map()},{v:new Uint8Array(2)},{v:Object.create({custom:true})},
    {v:new Array(1)},{v:Object.assign([1],{extra:1})},{v:arrayHidden},
    JSON.parse('{"__proto__":1}'),{constructor:'x'},{prototype:'x'}])rejectedByBoth(value);
});
test('own getters and toJSON callbacks never execute during either strict path',()=>{
  let invoked=0;const getter={};Object.defineProperty(getter,'field',{enumerable:true,get(){invoked++;return 1;}});
  const toJSON={toJSON(){invoked++;return {};}};
  const arr=[1];Object.defineProperty(arr,'0',{enumerable:true,get(){invoked++;return 1;}});
  for(const value of [getter,toJSON,{arr}])rejectedByBoth(value);assert.equal(invoked,0);
});
test('summary-only sync and yielding scans make no detached parses or object stringifications',async()=>{
  const rows=Array.from({length:40},(_,i)=>frame('f'+i)),expected=digest(rows);
  const parse=JSON.parse,stringify=JSON.stringify;let parses=0,objects=0,summary,scanned;
  try{
    JSON.parse=(...args)=>{parses++;return parse(...args);};
    JSON.stringify=(value,...args)=>{if(value&&typeof value==='object')objects++;return stringify(value,...args);};
    summary=chatGalleryDigest(rows);scanned=await scanChatGallery(rows);
  }finally{JSON.parse=parse;JSON.stringify=stringify;}
  assert.equal(parses,0);assert.equal(objects,0);assert.deepEqual(summary,expected);assert.deepEqual(scanned,expected);
});
test('record readers, default digest append and explicit visitors keep detached complete originals',async()=>{
  const row=frame('source'),original=structuredClone(row),state=createChatGalleryDigest(),appended=state.append(row),read=galleryDigestRecord(row);state.close();
  let visited;const summary=await scanChatGallery([row],{visit:record=>{visited=record;record.value.unknown.arr.push('visitor edit');}});
  assert.deepEqual(summary,digest([original]));assert.deepEqual(row,original);assert.notStrictEqual(visited.value,row);
  const detached=captureGalleryArchiveJson(original,GALLERY_PAGE_INDEX_LIMITS.recordBytes);
  row.unknown.arr[0]='source edit';assert.deepEqual(appended.value,detached);assert.deepEqual(read.value,detached);
  assert.equal(visited.sha256,createHash('sha256').update(legacy(original).text).digest('hex'));
  assert.deepEqual(appended.encoded,read.encoded);
});
test('hash-only summaries are recomputed from complete current fields rather than cached identity',async()=>{
  const rows=[frame('same')],first=chatGalleryDigest(rows);rows[0].unknown.nested.a++;
  const second=await scanChatGallery(rows);assert.notEqual(first.sha256,second.sha256);assert.deepEqual(second,digest(rows));
  rows[0].newField={previouslyUnknown:true};assert.notEqual(second.sha256,chatGalleryDigest(rows).sha256);
});
test('hash-only aggregate bounds and lifecycle match detached digest instances',()=>{
  for(const capture of [true,false]){
    const state=createChatGalleryDigest({capture}),large={value:'x'.repeat(600000)};
    assert.throws(()=>{for(let i=0;i<60;i++)state.append(large);},/超过分批/);assert.throws(()=>state.append({}));assert.throws(()=>state.finish());
    const nodes=createChatGalleryDigest({capture}),row={list:Array.from({length:20000},()=>1)};
    assert.throws(()=>{for(let i=0;i<21;i++)nodes.append(row);},/超过分批/);
  }
});
test('hash-only scan retains cooperative yields and guard cancellation without a record visitor',async()=>{
  const rows=Array.from({length:48},(_,i)=>frame(i));let yielded=0,checks=0,allowed=true;
  await assert.rejects(scanChatGallery(rows,{guard(){checks++;if(!allowed)throw Error('scope changed');},yieldWork(){if(++yielded===2)allowed=false;}}),/scope changed/);
  assert.equal(yielded,2);assert.ok(checks>16);
  await assert.rejects(scanChatGallery(rows,{visit:null}),/接收器/);assert.throws(()=>createChatGalleryDigest({capture:'false'}));
});
