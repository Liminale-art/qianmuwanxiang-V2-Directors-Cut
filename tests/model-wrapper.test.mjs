import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as host from '../qianmu-model-host.js';
const entry=await fs.readFile(new URL('../index.js',import.meta.url),'utf8');
const wrapper=entry.slice(entry.indexOf('async function callSillyTavernModel('),entry.indexOf('// 字符串感知'))
  .replace("import('./qianmu-model-host.js')",'loadHostModel()');
function fixture(context){
  let legacy=0,sends=0,payload;
  const c={ctx:()=>context,getGenerateRaw:()=>async args=>{legacy++;assert.equal(args.prompt,'prompt');return 'legacy result';},
    loadHostModel:async()=>({...host,callHostChatModel:options=>host.callHostChatModel({...options,fetchImpl:async(url,init)=>{
      sends++;payload=JSON.parse(init.body);return new Response('data: {"choices":[{"delta":{"content":" raw "},"finish_reason":"stop"}]}\n\n');
    }})})};
  vm.createContext(c);vm.runInContext(wrapper,c);
  return {c,get legacy(){return legacy;},get sends(){return sends;},get payload(){return payload;}};
}
test('real ST wrapper uses independent raw transport for director requests and retains host token settings',async()=>{
  const e=fixture({mainApi:'openai',chatCompletionSettings:{chat_completion_source:'deepseek',max_tokens:8765},getChatCompletionModel:()=>'live',getRequestHeaders:()=>({}),
    ChatCompletionService:{presetToGeneratePayload:async(settings,unused,overrides)=>({...settings,...overrides})}});
  let full='',metadata;
  assert.equal(await e.c.callSillyTavernModel('prompt','system',value=>full=value,{directorRequest:true,onResponse:value=>metadata=value}),' raw ');
  assert.equal(full,' raw ');assert.equal(metadata.finishReason,'stop');assert.equal(e.payload.max_tokens,8765);assert.equal(e.sends,1);assert.equal(e.legacy,0);
  assert.deepEqual(e.payload.messages,[{role:'system',content:'system'},{role:'user',content:'prompt'}]);
});
test('legacy host stream is rejected before sending; nonstream fallback is labelled as processed output',async()=>{
  const e=fixture({mainApi:'textgenerationwebui'});
  await assert.rejects(e.c.callSillyTavernModel('prompt','',()=>{},{directorRequest:true}),/未发送模型请求/);
  assert.equal(e.sends,0);assert.equal(e.legacy,0);let metadata;
  assert.equal(await e.c.callSillyTavernModel('prompt','',null,{directorRequest:true,onResponse:value=>metadata=value}),'legacy result');
  assert.equal(e.legacy,1);assert.match(metadata.compatibility,/处理后的最终正文/);
});
