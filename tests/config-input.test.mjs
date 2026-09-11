import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBoundedJson} from '../qianmu-json-input.js';
import {readConfigFile,readConfigEnvelope,CONFIG_INPUT_LIMITS} from '../qianmu-config-connections.js';
const envelope=settings=>({type:'qianmu-config',version:2,includeApi:false,settings});
test('declared oversized files are refused before reading their bytes',async()=>{
  let reads=0;
  for(const size of [0,-1,NaN,Infinity,CONFIG_INPUT_LIMITS.bytes+1])await assert.rejects(readConfigFile({size,text:()=>{reads++;return '{}';}}),/32 MiB/);
  assert.equal(reads,0);
});
test('bounded reader preserves valid Unicode config and legacy envelopes unchanged',async()=>{
  for(const payload of [envelope({theme:'月光',text:'引号"、反斜杠\\、[]{}'}),{type:'qianmu-config',version:1,settings:{theme:'旧版'}}]){
    const file=new Blob([JSON.stringify(payload)]);const parsed=await readConfigFile(file);assert.deepEqual(parsed,payload);assert.deepEqual(readConfigEnvelope(parsed).settings,payload.settings);
  }
});
test('scanner counts UTF8 bytes, treats quoted brackets as text and rejects excess nesting or entries',()=>{
  assert.deepEqual(parseBoundedJson('{"a":"{}[]"}',{maxBytes:20,maxDepth:1,maxNodes:1}),{a:'{}[]'});
  assert.throws(()=>parseBoundedJson('"月光"',{maxBytes:7}),/上限/);
  assert.throws(()=>parseBoundedJson('[[[]]]',{maxBytes:20,maxDepth:2}),/过深/);
  assert.throws(()=>parseBoundedJson('[0,1,2]',{maxBytes:20,maxNodes:2}),/条目过多/);
});
test('escaped duplicate keys, unsafe fields, nonfinite numbers and incomplete files are not repaired',async()=>{
  for(const text of ['{"a":1,"\\u0061":2}','{"__proto__":{}}','{"constructor":{}}','{"a":1e309}','{"a":"unterminated','{']){
    await assert.rejects(readConfigFile(new Blob([text])),error=>error.code==='qianmu_config_input');
  }
});
test('object-only envelope callers cannot introduce cycles or bypass depth limits',()=>{
  const cycle={};cycle.self=cycle;assert.throws(()=>readConfigEnvelope(envelope(cycle)),/结构/);
  let nested={};for(let n=0;n<41;n++)nested={next:nested};assert.throws(()=>readConfigEnvelope(envelope(nested)),/结构/);
});
