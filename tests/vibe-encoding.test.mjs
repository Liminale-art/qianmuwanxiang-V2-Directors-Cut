import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {encodeNovelVibe,prepareNovelVibeEncoding,novelVibeEncodeEndpoint,VIBE_ENCODING_LIMIT} from '../qianmu-vibe-encoding.js';
import {encodeGatewayNovelVibe} from '../qianmu-vibe-encoding-gateway.js';
const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
const input=()=>({version:1,provider:'novel',baseUrl:'https://relay.example/prefix/ai',apiKey:'test-key',model:'relay/custom',capabilityModelId:'nai-diffusion-4-5-full',image,information:0});
const output=()=>new Response(Buffer.from('opaque-test-encoding'),{status:201,headers:{'content-type':'application/binary'}});

test('canonical encoding identity binds original bytes, remote and capability model, exact IE and endpoint, never strength/key',async()=>{
  const value=input(),a=await prepareNovelVibeEncoding(value),b=await prepareNovelVibeEncoding({...value,apiKey:'rotated-key',strength:.7});
  assert.deepEqual(a,b);assert.equal(a.body.information_extracted,0);assert.equal(a.body.model,'relay/custom');assert.equal(a.identity.encodingModel,'v4-5full');
  assert.equal(JSON.stringify(a.identity).includes(value.apiKey),false);assert.equal(JSON.stringify(a.identity).includes(image),false);
  for(const change of [{information:.001},{model:'other'},{capabilityModelId:'nai-diffusion-4-full'},{baseUrl:'https://other.example'}])assert.notEqual((await prepareNovelVibeEncoding({...value,...change})).cacheKey,a.cacheKey);
  assert.equal(Object.isFrozen(a.body),true);assert.equal(Object.isFrozen(a.identity.parameters),true);
});
test('official base, ai root and generation endpoints share one encode endpoint; credentials and insecure URLs are rejected',()=>{
  for(const base of ['https://relay.example/prefix','https://relay.example/prefix/ai/','https://relay.example/prefix/ai/generate-image','https://relay.example/prefix/ai/encode-vibe'])assert.equal(novelVibeEncodeEndpoint(base),'https://relay.example/prefix/ai/encode-vibe');
  for(const base of ['http://relay.example','https://u:p@relay.example','https://relay.example?key=x','https://relay.example/#fragment','/relative'])assert.throws(()=>novelVibeEncodeEndpoint(base),{code:'vibe_encoding_address'});
});
test('invalid capability, image, IE, version and extra parameters fail before any authorization or network call',async()=>{
  for(const change of [{version:2},{provider:'banana'},{capabilityModelId:'nai-diffusion-5-full'},{capabilityModelId:'nai-diffusion-3'},
    {information:'0'},{information:NaN},{information:1.1},{image:'broken'},{mask:''},{focus_seed:0},{parameters:{}}]){
    let calls=0;await assert.rejects(()=>encodeNovelVibe({...input(),...change},{authorize:async()=>{calls++;return true;},fetchImpl:async()=>{calls++;return output();}}));assert.equal(calls,0);
  }
});
test('explicit authorization and a live guard are required, and cancellation never falls through to a POST',async()=>{
  for(const authorize of [undefined,async()=>false,async()=>({approved:true})]){let calls=0;await assert.rejects(()=>encodeNovelVibe(input(),{authorize,fetchImpl:async()=>{calls++;return output();}}));assert.equal(calls,0);}
  let checks=0,calls=0;await assert.rejects(()=>encodeNovelVibe(input(),{authorize:async()=>true,guard:async()=>{if(++checks===2)throw Error('changed');},fetchImpl:async()=>calls++}),/changed/);assert.equal(calls,0);
});
test('one native POST uses captured parameters, preserves zero and returns the exact opaque binary',async()=>{
  const value=input();let sent,identity;const result=await encodeNovelVibe(value,{authorize:async data=>{identity=data;value.information=.8;value.model='changed';value.apiKey='changed-key';return true;},
    fetchImpl:async(url,init)=>{sent={url,init};return output();}});
  assert.equal(sent.url,'https://relay.example/prefix/ai/encode-vibe');assert.equal(sent.init.redirect,'error');assert.equal(sent.init.credentials,'omit');assert.equal(sent.init.headers.Authorization,'Bearer test-key');
  assert.deepEqual(JSON.parse(sent.init.body),{image,information_extracted:0,model:'relay/custom'});assert.equal(result.encoding,Buffer.from('opaque-test-encoding').toString('base64'));assert.deepEqual(result.identity,identity);
});
test('HTTP rejections and uncertain writes never retry and never surface the upstream body or API key',async()=>{
  for(const status of [400,401,402,403,404,413,422,429,500,502]){let calls=0;await assert.rejects(()=>encodeNovelVibe(input(),{authorize:async()=>true,fetchImpl:async()=>{calls++;return new Response('secret: test-key',{status});}}),error=>{
    assert.equal(error.submissionState,status<500?'rejected':'unknown');assert.equal(error.retryable,false);assert.doesNotMatch(error.message,/test-key|secret/);return true;});assert.equal(calls,1);}
  let calls=0;await assert.rejects(()=>encodeNovelVibe(input(),{authorize:async()=>true,fetchImpl:async()=>{calls++;throw new TypeError('test-key raw');}}),{code:'vibe_encoding_unknown',submissionState:'unknown'});assert.equal(calls,1);
});
test('empty, HTML/JSON, oversized and truncated binary responses remain uncertain without generation or retry',async()=>{
  const samples=[()=>new Response('{}',{headers:{'content-type':'application/json'}}),()=>new Response('',{headers:{'content-type':'application/binary'}}),
    ()=>new Response('short',{headers:{'content-type':'application/binary','content-length':'100'}}),()=>new Response('x',{headers:{'content-type':'application/binary','content-length':String(VIBE_ENCODING_LIMIT+1)}}),
    ()=>new Response(Buffer.alloc(VIBE_ENCODING_LIMIT+1),{headers:{'content-type':'application/binary'}})];
  for(const make of samples){let calls=0;await assert.rejects(()=>encodeNovelVibe(input(),{authorize:async()=>true,fetchImpl:async()=>{calls++;return make();}}),error=>error.submissionState==='unknown');assert.equal(calls,1);}
});
test('a transport that ignores abort is bounded; external cancellation stops waiting without retrying a possibly accepted request',async()=>{
  let calls=0;await assert.rejects(()=>encodeNovelVibe(input(),{timeoutMs:100,authorize:async()=>true,fetchImpl:()=>{calls++;return new Promise(()=>{});}}),{submissionState:'unknown'});assert.equal(calls,1);
  const controller=new AbortController();let began;const started=new Promise(resolve=>began=resolve);
  const work=encodeNovelVibe(input(),{signal:controller.signal,authorize:async()=>true,fetchImpl:()=>{began();return new Promise(()=>{});}});await started;controller.abort();await assert.rejects(work,{submissionState:'unknown'});
});
test('gateway encoding pins validated public DNS, preserves hostname/TLS, does not redirect and shares the native wire contract',async()=>{
  let calls=0;const result=await encodeGatewayNovelVibe(input(),{authorize:async()=>true,resolveHost:async()=>[{address:'93.184.216.34',family:4}],
    requestImpl:(url,options,callback)=>{calls++;assert.equal(url.hostname,'relay.example');assert.equal(options.agent,false);assert.equal(options.rejectUnauthorized,undefined);assert.equal(options.headers.Authorization,'Bearer test-key');
      options.lookup('relay.example',{},(error,address,family)=>{assert.equal(error,null);assert.equal(address,'93.184.216.34');assert.equal(family,4);});
      options.lookup('relay.example',{all:true},(error,rows)=>assert.deepEqual(rows,[{address:'93.184.216.34',family:4}]));
      const request=new EventEmitter();request.end=body=>{assert.equal(JSON.parse(body).information_extracted,0);const incoming=Readable.from([Buffer.from('gateway-encoded')]);incoming.headers={'content-type':'application/binary'};incoming.statusCode=201;callback(incoming);};return request;
    }});
  assert.equal(result.encoding,Buffer.from('gateway-encoded').toString('base64'));assert.equal(calls,1);
});
test('gateway refuses private/mixed DNS and redirects instead of opening private network access',async()=>{
  for(const addresses of [[{address:'127.0.0.1',family:4}],[{address:'93.184.216.34',family:4},{address:'10.0.0.1',family:4}]]){
    let calls=0;await assert.rejects(()=>encodeGatewayNovelVibe(input(),{authorize:async()=>true,resolveHost:async()=>addresses,requestImpl:()=>calls++}),{code:'private_network_blocked'});assert.equal(calls,0);}
  let calls=0;await assert.rejects(()=>encodeGatewayNovelVibe(input(),{authorize:async()=>true,resolveHost:async()=>[{address:'93.184.216.34',family:4}],requestImpl:(url,options,callback)=>{
    calls++;const req=new EventEmitter();req.end=()=>{const res=Readable.from([]);res.headers={location:'https://private.invalid'};res.statusCode=307;callback(res);};return req;
  }}),{code:'vibe_encoding_http_307',submissionState:'unknown'});assert.equal(calls,1);
});
