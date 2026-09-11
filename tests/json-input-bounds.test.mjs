import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {assertJsonInputBounds,parseBoundedJson} from '../qianmu-json-input.js';

test('serialized snapshots use the same byte, nesting and entry limits as imported originals',()=>{
  const cases=[
    ['"月光"',{maxBytes:7},/上限/],
    ['[[[]]]',{maxBytes:20,maxDepth:2},/过深/],
    ['[0,1,2]',{maxBytes:20,maxNodes:2},/条目过多/],
    ['{"a":1,"a":2}',{maxBytes:100},/重复字段/],
    ['{"\\u0063onstructor":1}',{maxBytes:100},/不安全/],
  ];
  for(const [text,options,message] of cases){
    assert.throws(()=>assertJsonInputBounds(text,options),message);
    assert.throws(()=>parseBoundedJson(text,options),message);
  }
});

test('exact UTF-8 bounds and escaped strings remain accepted without changing the snapshot',()=>{
  for(const value of [{a:'月光 🌙'},{a:'{}[] " \\ __proto__'},{a:[null,true,-2.5]}]){
    const text=JSON.stringify(value),options={maxBytes:Buffer.byteLength(text)};
    assert.equal(assertJsonInputBounds(text,options),undefined);
    assert.deepEqual(parseBoundedJson(text,options),value);
  }
});

test('the bounds-only path never parses the entire exported document into another object tree',()=>{
  const text=JSON.stringify({original:'x'.repeat(10000),nested:{key:'keep'}}),parsed=[];
  const context=vm.createContext({TextEncoder,JSON:{parse(value){parsed.push(value);assert.notEqual(value,text);return JSON.parse(value);}}});
  vm.runInContext(readFileSync(new URL('../qianmu-json-input.js',import.meta.url),'utf8').replaceAll('export function','function'),context);
  context.assertJsonInputBounds(text,{maxBytes:20000});
  assert.deepEqual(parsed,['"original"','"nested"','"key"']);
});

test('untrusted imports still perform full syntax and finite-number validation after scanning',()=>{
  for(const text of ['{','[1,]','{"a":1e999}','[NaN]','true false','{"a":1} trailing']){
    assert.throws(()=>parseBoundedJson(text,{maxBytes:100,label:'伴读整包'}),/伴读整包/);
  }
});

test('invalid scan limits fail closed for both paths',()=>{
  for(const options of [{},{maxBytes:0},{maxBytes:100,maxDepth:0},{maxBytes:100,maxNodes:0}]){
    assert.throws(()=>assertJsonInputBounds('{}',options),/上限无效/);
    assert.throws(()=>parseBoundedJson('{}',options),/上限无效/);
  }
});
