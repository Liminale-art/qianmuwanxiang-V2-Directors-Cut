import test from 'node:test';
import assert from 'node:assert/strict';
import { callHostChatModel, hostChatModelAvailable } from '../qianmu-model-host.js';

test('host route uses a cloned live configuration, official payload factory and an independent request',async()=>{
  const settings={chat_completion_source:'makersuite',model:'current',stream_openai:false};const before=JSON.stringify(settings);let calls=0,subscriptions=0;
  const context={mainApi:'openai',chatCompletionSettings:settings,getChatCompletionModel:()=>settings.model,getRequestHeaders:()=>({'X-CSRF-Token':'fixture'}),
    eventSource:{on(){subscriptions++;}},ChatCompletionService:{async presetToGeneratePayload(copy,presetOverrides,overrides){copy.model='mutated copy';
      return {...copy,max_tokens:presetOverrides.openai_max_tokens,temperature:presetOverrides.temperature,...overrides};}}};
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

test('host factory cannot append unselected preset, worldbook or chat messages to the dedicated request',async()=>{
  const messages=[{role:'system',content:'QIANMU_ONLY_RULES'},{role:'user',content:'SELECTED_SOURCE_ONLY'}];
  const original=structuredClone(messages), settings={chat_completion_source:'makersuite',prompts:[{content:'UNSELECTED_PRESET'}]};
  const context={mainApi:'openai',chatCompletionSettings:settings,getChatCompletionModel:()=> 'gemini-fixture',getRequestHeaders:()=>({}),
    ChatCompletionService:{async presetToGeneratePayload(copy,unused,overrides){
      overrides.messages[0].content='UNSELECTED_SYSTEM';
      return {model:overrides.model,chat_completion_source:copy.chat_completion_source,messages:[...overrides.messages,
        {role:'system',content:copy.prompts[0].content},{role:'user',content:'HOST_WORLDBOOK_AND_CHAT'}]};
    }}};
  let sent;
  await callHostChatModel({context,messages,fetchImpl:async(_url,options)=>{sent=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'ok'},finish_reason:'stop'}]}));}});
  assert.deepEqual(sent.messages,original);assert.deepEqual(messages,original);
  assert.doesNotMatch(JSON.stringify(sent),/UNSELECTED_|HOST_WORLDBOOK/);
  assert.equal(settings.prompts[0].content,'UNSELECTED_PRESET');
});

test('Qianmu limits pass through official model conversion without restoring unsupported raw payload fields',async()=>{
  const context={mainApi:'openai',chatCompletionSettings:{chat_completion_source:'openai',openai_max_tokens:4096,temp_openai:1},
    getChatCompletionModel:()=> 'gpt-5',getRequestHeaders:()=>({}),
    ChatCompletionService:{async presetToGeneratePayload(settings,presetOverrides,overrides){
      assert.deepEqual(presetOverrides,{openai_max_tokens:6200,temperature:0.4});
      assert.ok(!Object.hasOwn(overrides,'max_tokens')); assert.ok(!Object.hasOwn(overrides,'temperature'));
      const converted={chat_completion_source:settings.chat_completion_source,max_completion_tokens:presetOverrides.openai_max_tokens};
      return {...converted,...overrides};
    }}};
  let sent;
  await callHostChatModel({context,messages:[{role:'user',content:'dedicated'}],maxTokens:6200,temperature:0.4,
    fetchImpl:async(_url,options)=>{sent=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'ok'},finish_reason:'stop'}]}));}});
  assert.equal(sent.max_completion_tokens,6200);assert.ok(!Object.hasOwn(sent,'max_tokens'));assert.ok(!Object.hasOwn(sent,'temperature'));
  assert.equal(context.chatCompletionSettings.openai_max_tokens,4096);assert.equal(context.chatCompletionSettings.temp_openai,1);
});

test('official o1 system-role conversion is retained without accepting changed or appended content',async()=>{
  const messages=[{role:'system',content:'QIANMU_RULES'},{role:'user',content:'SELECTED_SOURCE'}];
  for (const changed of [false,true]) {
    const context={mainApi:'openai',chatCompletionSettings:{},getChatCompletionModel:()=> 'o1-mini',getRequestHeaders:()=>({}),
      ChatCompletionService:{async presetToGeneratePayload(_settings,_preset,overrides){
        overrides.messages[0].role='user';
        if(changed) overrides.messages[0].content='UNSELECTED_HOST_RULES';
        return {chat_completion_source:'openai',...overrides};
      }}};
    let sent;
    await callHostChatModel({context,messages,fetchImpl:async(_url,options)=>{sent=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'ok'},finish_reason:'stop'}]}));}});
    assert.equal(sent.messages[0].content,'QIANMU_RULES');assert.equal(sent.messages[0].role,changed?'system':'user');
    assert.deepEqual(sent.messages[1],messages[1]);assert.equal(messages[0].role,'system');
    assert.doesNotMatch(JSON.stringify(sent),/UNSELECTED_HOST_RULES/);
  }
});
