import test from 'node:test';
import assert from 'node:assert/strict';
import {createProseAssistantRequest as create} from '../qianmu-prose-assistant-request.js';

const profile=()=>({id:'chosen',name:'Only explicit',apiUrl:'https://example.invalid/v1/chat/completions',apiKey:'fixture-private',model:'chosen-model',temperature:0.6});
const json=()=>new Response(JSON.stringify({choices:[{message:{content:'answer'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});
function fixture(transport='direct',extra={}){
  const calls=[],profiles=[profile()],selection={mode:'profile',profileId:'chosen',transport};
  const options={selection,profiles,compileMessages:({question})=>[{role:'user',content:question,ignore:'unrelated'}],getRequestHeaders:()=>({'X-CSRF-Token':'fixture-csrf'}),
    fetchImpl:async(url,init)=>{calls.push({url,init});return json();},...extra};
  return {options,profiles,selection,calls,input:{context:{key:'private-scope'},question:'question',guard:async()=>true,onText:()=>{}}};
}
test('missing, duplicate or incomplete explicit profiles fail before requests without borrowing a default connection',()=>{
  for(const patch of [{selection:null},{selection:{mode:'profile',profileId:'missing',transport:'direct'}},{profiles:[profile(),profile()]},{profiles:[{...profile(),apiKey:''}]},{profiles:[{...profile(),apiUrl:'https://user:password@example.invalid/v1'}]},
    {profiles:[{...profile(),apiUrl:'https://example.invalid/v1?api_key=secret'}]},{profiles:[{...profile(),apiKey:'key\r\nInjected: yes'}]},{profiles:[{...profile(),temperature:NaN}]}]){
    const f=fixture('direct',patch);assert.throws(()=>create(f.options),{code:'prose_assistant_connection'});assert.equal(f.calls.length,0);
  }
});
test('direct mode snapshots only the selected configuration and never sends host cookies or CSRF headers',async()=>{
  const f=fixture(),adapter=create(f.options);f.profiles[0].apiKey='changed';f.profiles[0].model='other';let text='';
  assert.equal(await adapter.send({...f.input,onText:value=>{text=value;}}),'answer');assert.equal(text,'answer');assert.equal(f.calls.length,1);
  const {url,init}=f.calls[0];assert.equal(url,'https://example.invalid/v1/chat/completions');assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer fixture-private');assert.equal(init.headers['X-CSRF-Token'],undefined);
  const body=JSON.parse(init.body);assert.equal(body.model,'chosen-model');assert.deepEqual(body.messages,[{role:'user',content:'question'}]);assert.equal(body.response_format,undefined);assert.doesNotMatch(JSON.stringify(adapter),/fixture-private|apiKey|private-scope/);
});
test('ST proxy stays same-origin with explicit custom target, keeps streaming and does not use host active model',async()=>{
  const f=fixture('st-proxy');f.options.fetchImpl=async(url,init)=>{f.calls.push({url,init});return new Response('data: {"choices":[{"delta":{"content":"stream"},"finish_reason":"stop"}]}\n\n',{headers:{'content-type':'text/event-stream'}});};
  const adapter=create(f.options);assert.equal(await adapter.send(f.input),'stream');const {url,init}=f.calls[0],body=JSON.parse(init.body);
  assert.equal(url,'/api/backends/chat-completions/generate');assert.equal(init.credentials,'same-origin');assert.equal(init.headers['X-CSRF-Token'],'fixture-csrf');assert.equal(body.custom_url,'https://example.invalid/v1');assert.equal(body.custom_include_headers,'Authorization: Bearer fixture-private');assert.equal(body.model,'chosen-model');assert.equal(body.stream,true);assert.equal(body.reverse_proxy,'');
});
test('HTTP auth/network failures send once and expose neither upstream body nor connection credentials',async()=>{
  for(const transport of ['st-proxy','direct'])for(const http of [true,false]){
    let count=0;const f=fixture(transport,{fetchImpl:async()=>{count++;if(http)return new Response('fixture-private https://private/secret',{status:403});throw new Error('fixture-private private-url');}});
    await assert.rejects(create(f.options).send(f.input),error=>{assert.match(error.message,/未切换连接或重试/);assert.doesNotMatch(JSON.stringify({message:error.message,...error}),/fixture-private|private-url|https:/);return true;});assert.equal(count,1);
  }
});
test('abort, timeout and late scope changes are guarded without resubmission',async()=>{
  const aborted=new AbortController();aborted.abort();const f=fixture();await assert.rejects(create(f.options).send({...f.input,signal:aborted.signal}),{code:'prose_assistant_cancelled'});assert.equal(f.calls.length,0);
  let count=0;const t=fixture('direct',{timeoutMs:5,fetchImpl:async(_,init)=>{count++;return new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('network private')),{once:true}));}});
  await assert.rejects(create(t.options).send(t.input),{code:'prose_assistant_timeout'});assert.equal(count,1);
  let live=true;const late=fixture('direct',{fetchImpl:async()=>{live=false;return json();}});await assert.rejects(create(late.options).send({...late.input,guard:async()=>live}),{code:'prose_assistant_scope'});
});
test('compiler and response boundaries reject malformed or incomplete messages without forced JSON or retries',async()=>{
  for(const compileMessages of [()=>[],()=>[{role:'tool',content:'x'}],()=>[{role:'user',content:'\ud800'}],()=>[{role:'user',content:'x'.repeat(300001)}]]){
    const f=fixture('direct',{compileMessages});await assert.rejects(create(f.options).send(f.input));assert.equal(f.calls.length,0);
  }
  let count=0,text='';const f=fixture('direct',{fetchImpl:async()=>{count++;return new Response('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n');}});
  await assert.rejects(create(f.options).send({...f.input,onText:value=>{text=value;}}),{code:'prose_assistant_incomplete'});assert.equal(text,'partial');assert.equal(count,1);
});
test('dedicated custom connection is explicit and disabled streaming remains disabled',async()=>{
  const f=fixture();f.options.selection={mode:'custom',transport:'direct',connection:{...profile(),stream:false,maxTokens:321}};
  const adapter=create(f.options);assert.equal(adapter.review.profileId,null);await adapter.send(f.input);const body=JSON.parse(f.calls[0].init.body);assert.equal(body.stream,false);assert.equal(body.max_tokens,321);
});

test('both routes preserve explicit third-party API prefixes and normalize only a bare host to v1',async()=>{
  for(const [url,root] of [['https://example.invalid','https://example.invalid/v1'],['https://example.invalid/api/v3/chat/completions','https://example.invalid/api/v3'],['https://example.invalid/custom/models','https://example.invalid/custom']]){
    for(const transport of ['direct','st-proxy']){const f=fixture(transport);f.profiles[0].apiUrl=url;await create(f.options).send(f.input);const call=f.calls[0];
      if(transport==='direct')assert.equal(call.url,root+'/chat/completions');else assert.equal(JSON.parse(call.init.body).custom_url,root);
    }
  }
});
