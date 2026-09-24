import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {configureStAccountStorage} from '../qianmu-st-account-storage.js';
import {openNativeProseAssistantHistory} from '../qianmu-prose-assistant-native.js';

const digest=value=>createHash('sha256').update(value).digest('hex');
function fixture(t){
 const raw='st-user:assistant-integration',account='st-user:'+digest(raw.slice(8));
 const key=JSON.stringify(['qianmu-prose-assistant-offstage-v1',account]);
 const slot='assistant-'+digest(key),schema='qianmu.st-account-document.v1',scope=digest(`${schema}\0${raw}`);
 const state={version:1,namespace:key,revision:1,updatedAt:1,rows:[{id:1,user:'问题',assistant:'回答',status:'complete',reference:null}]};
 const text=JSON.stringify({schema,scope,slot,value:state}),fingerprint=digest(text),prefix=`qianmu-v2-${scope}-${slot}`;
 const files=new Map([[`${prefix}.json`,JSON.stringify({schema:'qianmu.st-account-head.v1',scope,slot,fingerprint})],[`${prefix}-${fingerprint}.json`,text]]);
 const f={namespace:raw,live:true,identity:0,gets:0,beforeReply:null};
 const resolveNamespace=async()=>{f.identity++;return f.namespace;};
 const fetchImpl=async(url,options)=>{
  assert.equal(options.method,'GET','reading an existing conversation must not upload');f.gets++;
  const path=new URL(url,'https://st.fixture.invalid');assert.equal(path.origin,'https://st.fixture.invalid');
  const body=files.get(path.pathname.split('/').at(-1));assert.ok(body,'only exact owned fixture files are readable');
  f.beforeReply?.();return new Response(body,{headers:{'content-type':'application/json'}});
 };
 t.mock.method(globalThis,'fetch',fetchImpl);
 configureStAccountStorage({resolveNamespace,isCurrent:()=>f.live,headers:()=>({}),fetchImpl,origin:'https://st.fixture.invalid'});
 const source={key,scope:{namespace:account},assertCurrent:()=>f.live,guard:async()=>f.live&&await resolveNamespace()===raw};
 f.open=()=>openNativeProseAssistantHistory({source,isCurrent:()=>f.live});return f;
}

test('real assistant/native chain reads two files with bounded live account checks, no nested authorization cache',async t=>{
 const f=fixture(t),history=await f.open();assert.equal(history.initialHistory().rows[0].assistant,'回答');
 assert.equal(f.gets,2);assert.ok(f.identity<=20,`identity checks ${f.identity} must not multiply at every inner guard`);
 history.close();
});

test('real assistant/native chain rejects an account switch while its first file reply is in flight',async t=>{
 const f=fixture(t);f.beforeReply=()=>{f.namespace='st-user:other';};
 await assert.rejects(f.open());assert.equal(f.gets,1,'the original body must not be requested after account change');
});

test('real assistant/native chain rejects closure during a file read without publishing late history',async t=>{
 const f=fixture(t);f.beforeReply=()=>{f.live=false;};
 await assert.rejects(f.open());assert.equal(f.gets,1);
});
