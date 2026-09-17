import test from 'node:test';
import assert from 'node:assert/strict';
import { callHostChatModel, hostChatModelAvailable } from '../qianmu-model-host.js';

test('host route uses a cloned live configuration, official payload factory and an independent request',async()=>{
  const settings={chat_completion_source:'makersuite',model:'current',stream_openai:false};const before=JSON.stringify(settings);let calls=0,subscriptions=0;
  const context={mainApi:'openai',chatCompletionSettings:settings,getChatCompletionModel:()=>settings.model,getRequestHeaders:()=>({'X-CSRF-Token':'fixture'}),
    eventSource:{on(){subscriptions++;}},ChatCompletionService:{async presetToGeneratePayload(copy,unused,overrides){copy.model='mutated copy';return {...copy,...overrides};}}};
  const result=await callHostChatModel({context,messages:[{role:'user',content:'fixture'}],stream:true,maxTokens:900,temperature:0,
    fetchImpl:async(url,options)=>{calls++;assert.equal(url,'/api/backends/chat-completions/generate');assert.equal(options.redirect,'error');assert.equal(options.credentials,'same-origin');
      const data=JSON.parse(options.body);assert.equal(data.model,'current');assert.equal(data.stream,true);assert.equal(data.max_tokens,900);assert.equal(data.temperature,0);
      return new Response('data: {"candidates":[{"content":{"parts":[{"text":"raw body"}]},"finishReason":"STOP"}]}\n\n');}});
  assert.equal(result.text,'raw body');assert.equal(calls,1);assert.equal(subscriptions,0);assert.equal(JSON.stringify(settings),before);
});

test('unsupported host APIs, cancellation and scope changes before dispatch do not send a request',async()=>{
  let sends=0;const context={mainApi:'openai',chatCompletionSettings:{},getChatCompletionModel:()=>'',ChatCompletionService:{async presetToGeneratePayload(){return {};}}};
  assert.equal(hostChatModelAvailable({...context,mainApi:'novel'}),false);
  for(const options of [{context:{mainApi:'novel'}},{context,guard:()=>false},{context,signal:AbortSignal.abort()},{context}]){
    await assert.rejects(callHostChatModel({...options,messages:[],fetchImpl:async()=>sends++}));
  }assert.equal(sends,0);
});
