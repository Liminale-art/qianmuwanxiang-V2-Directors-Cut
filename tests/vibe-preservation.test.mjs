import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createVibePreservationStore,exportVibePreservation,VIBE_PRESERVATION_TABLES} from '../qianmu-vibe-preservation.js';
import {createVibePreservationActions} from '../qianmu-vibe-preservation-view.js';
import {inspectVibeReceiptFile} from '../qianmu-vibe-receipt-file.js';
const namespace='st-user:preserve',key=JSON.stringify([namespace,'broken-id']),json=async value=>JSON.parse(await value.text());

test('preservation keeps original malformed text, unknown fields and JSON edge values without treating them as valid assets',async()=>{
  const original={namespace,key,serialized:' {bad json\n \u0000',missing:undefined,nan:NaN,infinity:Infinity,negative:-0,big:4n,flag:false,empty:null};
  const result=await json(await exportVibePreservation(namespace,'documents',key,original,{now:()=>12}));
  assert.equal(result.identifier,'qianmu-vibe-preservation');assert.equal(result.purpose,'preserve-only');assert.equal(result.exportedAt,12);
  const fields=Object.fromEntries(result.value[1]);assert.deepEqual(fields.serialized,['string',original.serialized]);assert.deepEqual(fields.missing,['undefined']);
  assert.deepEqual(fields.nan,['number','NaN']);assert.deepEqual(fields.negative,['number','-0']);assert.deepEqual(fields.big,['bigint','4']);assert.deepEqual(fields.empty,['null']);
  const {fingerprint,...payload}=result;assert.equal(fingerprint,Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(payload)))).toString('hex'));
  await assert.rejects(()=>inspectVibeReceiptFile(namespace,new Blob([JSON.stringify(result)])));assert.equal(original.serialized,' {bad json\n \u0000');
});
test('binary and sparse arrays retain exact bytes, types and holes across base64 chunk boundaries',async()=>{
  const bytes=Uint8Array.from({length:60001},(_,i)=>i%251),array=new Array(7);array[2]='kept';array.extra=undefined;
  const blob=new Blob([bytes],{type:'image/png'}),value={namespace,blob,bytes:bytes.subarray(5,59997),array,date:new Date(0)};
  const result=await json(await exportVibePreservation(namespace,'previews',key,value)),fields=Object.fromEntries(result.value[1]);
  assert.deepEqual(Buffer.from(fields.blob[2],'base64'),Buffer.from(bytes));assert.deepEqual(fields.blob[1],{type:'image/png'});
  assert.deepEqual(Buffer.from(fields.bytes[2],'base64'),Buffer.from(bytes.subarray(5,59997)));assert.equal(fields.bytes[1],'Uint8Array');
  assert.deepEqual(fields.array,['array',7,[['2',['string','kept']],['extra',['undefined']]]]);assert.deepEqual(fields.date,['date','1970-01-01T00:00:00.000Z']);
});
test('ambiguous ownership and arbitrary stores cannot be exported, even when the raw data is corrupt',async()=>{
  for(const [ns,section,k,row] of [['st-user:other','heads',key,{}],[namespace,'arbitrary',key,{}],[namespace,'heads',key,{namespace:'st-user:other'}],
    [namespace,'heads',JSON.stringify(['st-user:preserve-extra','x']),{}],[namespace,'usage',key,{}],[namespace,'heads','not-json',{}]]){
    await assert.rejects(()=>exportVibePreservation(ns,section,k,row));
  }
  const file=await json(await exportVibePreservation(namespace,'usage',namespace,{key:namespace,count:'broken'}));assert.equal(file.section,'usage');
});
test('unsupported/cyclic, excessive-depth and excessive-node values fail rather than silently losing raw evidence',async()=>{
  const cycle={};cycle.self=cycle;let deep={};for(let i=0;i<34;i++)deep={child:deep};
  for(const value of [cycle,deep,new Map([['x',1]]),()=>{},Array(50001).fill(0)])await assert.rejects(()=>exportVibePreservation(namespace,'heads',key,value),/原内容未改动/);
  assert.equal(cycle.self,cycle);
});
test('scope and pagination validation occurs without opening a database; open failure remains non-mutating',async()=>{
  let opens=0;const store=createVibePreservationStore({indexedDB:{open(){opens++;throw Error('blocked');}}});
  await assert.rejects(()=>store.page('bad','heads'));await assert.rejects(()=>store.page(namespace,'arbitrary'));
  await assert.rejects(()=>store.page(namespace,'heads',{after:JSON.stringify(['st-user:other','x'])}));
  await assert.rejects(()=>store.page(namespace,'usage',{after:namespace}));await assert.rejects(()=>store.export(namespace,'heads','x'));assert.equal(opens,0);
  await assert.rejects(()=>store.page(namespace,'heads'),/原始储存不可用/);assert.equal(opens,1);
});
test('actions only read explicit selection after exact consent and recheck the account before publishing',async()=>{
  let live=true;const calls=[],guard=async()=>{if(!live)throw Error('account changed');};
  const actions=createVibePreservationActions({namespace,guard,call:async(type,args)=>{calls.push({type,args});return new Blob(['raw']);}});
  for(const answer of [false,undefined,1,'true',{}])assert.equal(await actions.export('heads',key,async()=>answer),null);assert.equal(calls.length,0);
  await assert.rejects(()=>actions.export('heads',key,async()=>{live=false;return true;}),/account changed/);assert.equal(calls.length,0);live=true;
  await actions.export('heads',key,async(_title,message)=>{assert.match(message,/不修复、不清理、不恢复任务或授权收费/);return true;});
  assert.deepEqual(calls,[{type:'preservation-export',args:{namespace,section:'heads',key}}]);
  const late=createVibePreservationActions({namespace,guard,call:async()=>{live=false;return {};}});await assert.rejects(()=>late.page('heads'),/account changed/);
});
test('entry points stay available independently of validated lists and preservation ships as an on-demand module',async()=>{
  const index=await readFile(new URL('../index.js',import.meta.url),'utf8'),worker=await readFile(new URL('../qianmu-vibe-assets-worker.js',import.meta.url),'utf8');
  assert.match(index,/createPreservation=async onClose=>\{const preservation=await featureRuntime.load\('vibePreservation'\)/);
  assert.equal((index.match(/onClose,createPreservation,confirm:/g)||[]).length,2);assert.match(worker,/await import\('\.\/qianmu-vibe-preservation.js'\)/);
  const files=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url))).files;
  for(const file of ['qianmu-vibe-preservation.js','qianmu-vibe-preservation-view.js'])assert.ok(files.includes(file));assert.equal(VIBE_PRESERVATION_TABLES.length,9);
});
