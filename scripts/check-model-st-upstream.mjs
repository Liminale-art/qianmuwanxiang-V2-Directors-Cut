// Read-only verification of the exact official ST 1.19.0 factory, no live settings or generation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { callHostChatModel } from '../qianmu-model-host.js';
const repository=process.env.QIANMU_ST_UPSTREAM;
if(!repository)throw new Error('Set QIANMU_ST_UPSTREAM to the read-only official reference clone.');
const git=(...args)=>execFileSync('git',['-c',`safe.directory=${repository.replaceAll('\\','/')}`,'-C',repository,...args],{encoding:'utf8',windowsHide:true,maxBuffer:4*1048576});
const commit=git('rev-parse','1.19.0^{commit}').trim();assert.equal(commit,'7e8663cd9c184a550b37238218bdd32c6efc68e9');
const source=git('show','1.19.0:public/scripts/custom-request.js');
const checks=[];
for(const chat_completion_source of ['makersuite','deepseek','claude','custom']){
  const settings={chat_completion_source,temp_openai:0.55,custom_url:'https://fixture.invalid',stream_openai:false};let factories=0,sends=0;
  const context=vm.createContext({structuredClone,console,oai_settings:settings,settingsToUpdate:{temperature:['', 'temp_openai']},
    async createGenerationParameters(copy,model,type,messages){factories++;assert.notEqual(copy,settings);assert.equal(type,'quiet');assert.equal(model,'fixture-model');
      return {generate_data:{model,messages,chat_completion_source:copy.chat_completion_source,temperature:copy.temp_openai,custom_url:copy.custom_url,stream:false}};}});
  const service=vm.runInContext(source.slice(source.indexOf('export class ChatCompletionService')).replace('export class','class')+'\nChatCompletionService',context);
  const before=JSON.stringify(settings);
  const result=await callHostChatModel({context:{mainApi:'openai',ChatCompletionService:service,chatCompletionSettings:settings,getChatCompletionModel:()=>'fixture-model',getRequestHeaders:()=>({})},
    messages:[{role:'user',content:'synthetic'}],stream:true,fetchImpl:async(url,options)=>{sends++;const payload=JSON.parse(options.body);
      assert.equal(payload.chat_completion_source,chat_completion_source);assert.equal(payload.stream,true);assert.equal(payload.temperature,0.55);assert.equal(payload.custom_url,'https://fixture.invalid');
      return new Response('data: {"choices":[{"delta":{"content":"original"},"finish_reason":"stop"}]}\n\n');}});
  assert.equal(factories,1);assert.equal(sends,1);assert.equal(result.text,'original');assert.equal(JSON.stringify(settings),before);
  checks.push(`${chat_completion_source}: actual official factory retains live source and parameters without editing host settings`);
}
const host=git('show','1.19.0:public/scripts/st-context.js');
for(const name of ['ChatCompletionService','getChatCompletionModel','getRequestHeaders'])assert.ok(host.includes(name));
assert.match(source,/fetch\('\/api\/backends\/chat-completions\/generate'/);checks.push('official context exports and same-origin request endpoint match the adapter');
console.log(JSON.stringify({passed:checks.length,checks,officialVersion:'1.19.0',commit,external:0,scope:'actual tagged payload factory with synthetic generation-parameter input; no running ST or paid request'}));
