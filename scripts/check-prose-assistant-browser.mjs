// Synthetic host + intercepted modules and model responses only; never a real ST account.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext(),page=await context.newPage();
const checks=[],errors=[];let external=0;
const allowed=new Set(['qianmu-plain-text-range.js','qianmu-current-chat-source.js','qianmu-chat-file-target.js','qianmu-model-response.js','qianmu-llm-output.js','qianmu-portable-connection.js',...['panel','source','context','session','request','messages'].map(name=>`qianmu-prose-assistant-${name}.js`)]);
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',async route=>{const url=new URL(route.request().url()),file=url.pathname.slice(1);
  if(url.origin==='https://qianmu.test'){
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><button id="entry">助手</button><main id="fixture"></main>'});
    if(allowed.has(file))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../'+file,import.meta.url),'utf8')});
  }external++;return route.abort();
});
const action=name=>page.locator(`[data-pa-action="${name}"]`),question=()=>page.getByLabel('向正文助手提问');
try{
  await page.goto('https://qianmu.test/');await page.addStyleTag({content:await readFile(new URL('../style.css',import.meta.url),'utf8')});await page.addStyleTag({content:await readFile(new URL('../qianmu-prose-assistant.css',import.meta.url),'utf8')});
  await page.evaluate(async()=>{
    const {openProseAssistantPanel}=await import('./qianmu-prose-assistant-panel.js');
    const listeners=new Map(),host={chatId:'A',characterId:0,characters:[{avatar:'A.png',chat:'A'}],chatMetadata:{},chat:[{mes:'前文',is_user:true},{mes:'未选\r\n正文😀\r下一行\r\n不选'}],
      eventSource:{on(type,handler){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(handler);},removeListener(type,handler){listeners.get(type)?.delete(handler);}}};
    const fixture=window.fixture={host,listeners,live:true,mode:'ok',sent:[],copies:[],confirm:true};
    fixture.source={getContext:()=>host,epoch:()=>0,resolveNamespace:async()=>'st-user:fixture',isCurrent:()=>fixture.live,readText:m=>m.mes,floor:1};
    fixture.open=async(prompt='fixture-only prompt')=>{document.querySelector('#entry').focus();fixture.panel=await openProseAssistantPanel({parent:document.querySelector('#fixture'),source:fixture.source,
      profiles:[{id:'chosen',name:'Fixture <b>预设</b>',apiUrl:'https://model.invalid/v1',apiKey:'fixture-key',model:'fixture-model'}],systemPrompt:prompt,isCurrent:()=>fixture.live,
      getRequestHeaders:()=>({'X-CSRF-Token':'fixture'}),copy:async text=>{fixture.copies.push(text);},confirm:async()=>fixture.confirm,
      fetchImpl:async(url,init)=>{fixture.sent.push({url,body:JSON.parse(init.body),signal:init.signal});
        if(fixture.mode==='error')return new Response('fixture-key private-response',{status:401});
        if(fixture.mode==='hold')return new Response(new ReadableStream({start(controller){fixture.stream=controller;controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"半截"}}]}\n\n'));},cancel(){fixture.cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
        return new Response(JSON.stringify({choices:[{message:{content:'<b>纯文本回复</b>'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});
      }});};
    fixture.listenerCount=()=>[...listeners.values()].reduce((sum,set)=>sum+set.size,0);
  });
  for(const width of [320,393,1280]){
    await page.setViewportSize({width,height:800});await page.evaluate(()=>fixture.open(''));
    await page.getByLabel('助手API预设').selectOption('profile:chosen');await question().fill('问题');assert.equal(await action('send').isDisabled(),true);
    assert.match(await page.locator('.qm-pa-notice').textContent(),/尚未配置/);assert.equal(await page.evaluate(()=>fixture.sent.length),0);
    const fit=await page.locator('dialog').evaluate(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,overflow:node.scrollWidth>node.clientWidth+1};});
    assert.ok(fit.left>=0&&fit.right<=fit.width+1&&fit.bottom<=fit.height+1&&!fit.overflow,JSON.stringify(fit));await action('close').click();assert.equal(await page.evaluate(()=>fixture.listenerCount()),0);
    checks.push(`${width}px panel stays bounded, blocks unconfigured prompt and releases listeners on close`);
  }
  await page.setViewportSize({width:393,height:820});await page.evaluate(()=>fixture.open());await page.getByLabel('助手API预设').selectOption('profile:chosen');await page.getByLabel('引用范围').selectOption('selection');
  await page.getByLabel('选择引用正文').evaluate(node=>{node.focus();const start=node.value.indexOf('正文'),end=node.value.indexOf('不选');node.setSelectionRange(start,end);node.dispatchEvent(new Event('select'));});
  await question().fill('讨论这个片段');await action('send').click();await page.waitForFunction(()=>document.querySelector('[data-pa-status]')?.textContent==='回复已完成');
  const first=await page.evaluate(()=>fixture.sent[0].body);assert.equal(JSON.parse(first.messages.at(-1).content).reference.text,'正文😀\r下一行\r\n');assert.doesNotMatch(JSON.stringify(first.messages),/未选|不选|fixture-key|st-user:/);
  assert.equal(await page.locator('[data-pa-transcript] b').count(),0);assert.equal(await page.locator('[data-pa-transcript] pre').textContent(),'<b>纯文本回复</b>');assert.match(await page.locator('[data-pa-scope]').textContent(),/前文：1；历史问答 0/);
  await action('copy').click();assert.deepEqual(await page.evaluate(()=>fixture.copies),['<b>纯文本回复</b>']);checks.push('explicit selection survives focus loss, maps original CRLF/emoji, exposes actual scope and safely copies plaintext');
  if(process.env.QIANMU_PROSE_ASSISTANT_SCREENSHOT)await page.screenshot({path:process.env.QIANMU_PROSE_ASSISTANT_SCREENSHOT});
  await page.getByLabel('助手API预设').selectOption('custom');await page.getByLabel('助手API地址').fill('https://model.invalid/custom');await page.getByLabel('助手模型',{exact:true}).fill('custom-model');await page.getByLabel('助手API Key').fill('typed-key');
  await action('eye').click();assert.equal(await page.getByLabel('助手API Key').getAttribute('type'),'text');await action('eye').click();
  await page.evaluate(()=>{fixture.mode='error';});await question().fill('失败测试');await action('send').click();await page.waitForFunction(()=>document.querySelector('[data-pa-status]')?.textContent.includes('HTTP 401'));
  assert.equal(await page.getByLabel('助手API Key').inputValue(),'typed-key');assert.doesNotMatch(await page.locator('[data-pa-status]').textContent(),/fixture-key|private-response/);assert.equal(await page.evaluate(()=>fixture.sent.length),2);checks.push('dedicated connection retains typed key, supports visibility toggle, and authentication failure does not retry or leak upstream text');
  await page.evaluate(()=>{fixture.mode='hold';});await question().fill('停止测试');await action('send').click();await page.waitForFunction(()=>document.querySelector('[data-pa-turn="3"] pre')?.textContent==='半截');
  await action('stop').click();await page.waitForFunction(()=>fixture.sent.at(-1).signal.aborted);assert.match(await page.locator('[data-pa-turn="3"] small').textContent(),/已停止/);
  await page.evaluate(()=>{fixture.mode='ok';});await question().fill('停止后新问');await action('send').click();await page.waitForFunction(()=>document.querySelector('[data-pa-status]')?.textContent==='回复已完成');
  const last=await page.evaluate(()=>fixture.sent.at(-1).body.messages);assert.equal(last.length,4);assert.doesNotMatch(JSON.stringify(last),/失败测试|停止测试|半截/);checks.push('stop aborts only this request and partial or failed turns never enter the next question history');
  await page.evaluate(()=>{fixture.confirm=false;});await action('clear').click();assert.equal(await page.locator('[data-pa-turn]').count(),4);await page.evaluate(()=>{fixture.confirm=true;});await action('clear').click();await page.waitForFunction(()=>!document.querySelector('[data-pa-turn]'));checks.push('clearing dialogue requires confirmation and does not touch host prose');
  await page.evaluate(()=>{fixture.host.chat[1].mes='changed';document.querySelector('#fixture').append(document.createElement('i'));});await page.waitForFunction(()=>!document.querySelector('dialog'));assert.equal(await page.evaluate(()=>fixture.listenerCount()),0);checks.push('edited source closes the borrowed panel and releases every host listener');
  await page.evaluate(()=>fixture.open());await page.evaluate(()=>document.querySelector('#fixture').remove());await page.waitForFunction(()=>!document.querySelector('dialog'));assert.equal(await page.evaluate(()=>fixture.listenerCount()),0);checks.push('detached parent disposes the panel without leaving a focus or listener trap');
  assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,count:checks.length,externalRequests:external,pageErrors:errors,productionWrites:false,persistence:'memory-only panel with synthetic host/model responses'},null,2));
}finally{await context.close();await browser.close();}
