import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {prepareCoreadPackageExport,readCoreadPackageFile} from '../qianmu-reader-package.js';
import {assertJsonInputBounds} from '../qianmu-json-input.js';

const pack=()=>({type:'qianmu-coread',version:5,books:[{meta:{id:'book',title:'月光'},fullText:'original'}],prefs:{fontSize:16},chats:[],images:[],vectors:[],audio:[],retrievalLogs:[]});
const bounded=(payload,limits)=>{
  const c=vm.createContext({JSON,Blob,assertJsonInputBounds,COREAD_PACKAGE_LIMITS:{bytes:10000,depth:40,nodes:500000,...limits}});
  vm.runInContext(prepareCoreadPackageExport.toString(),c);
  return c.prepareCoreadPackageExport(payload);
};

test('a normal exported pack is accepted unchanged by the real reader including original text and preferences',async()=>{
  const payload=pack(),before=structuredClone(payload),{blob,preservationOnly}=prepareCoreadPackageExport(payload);
  assert.equal(preservationOnly,false);assert.deepEqual(await readCoreadPackageFile(blob),payload);assert.deepEqual(payload,before);
});

test('exact Unicode byte limits remain restorable and an over-limit copy preserves every byte',async()=>{
  const payload=pack(),text=JSON.stringify(payload),bytes=Buffer.byteLength(text);
  assert.equal(bounded(payload,{bytes}).preservationOnly,false);
  const result=bounded(payload,{bytes:bytes-1});assert.equal(result.preservationOnly,true);assert.equal(await result.blob.text(),text);
});

test('excess depth, entries and reserved keys trigger preservation without silently clipping historical data',async()=>{
  const payload=pack();payload.chats=[{key:'chat',rec:JSON.parse('{"constructor":"historical text"}')}];
  for(const [value,limits] of [[pack(),{depth:2}],[pack(),{nodes:2}],[payload,{}]]){
    const text=JSON.stringify(value),result=bounded(value,limits);
    assert.equal(result.preservationOnly,true);assert.equal(await result.blob.text(),text);
  }
});

test('unserializable originals fail rather than producing an empty or apparently successful preservation copy',()=>{
  const circular=pack();circular.self=circular;
  assert.throws(()=>prepareCoreadPackageExport(circular));
  assert.throws(()=>prepareCoreadPackageExport({...pack(),unknown:1n}));
});
