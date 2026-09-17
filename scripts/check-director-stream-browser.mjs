// Native local HTTP/SSE, real decoder/gateway/log/preview renderers. No model, credentials or ST data.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const entry=await fs.readFile(new URL('../index.js',import.meta.url),'utf8');
const logs=entry.slice(entry.indexOf('const LOG_STATUS_LABELS ='),entry.indexOf('\nfunction renderTtsVoiceMapRows'));
const config=entry.slice(entry.indexOf('<section class="sd-card sd-model-config">'),entry.indexOf('    ${renderStoryboardVideoConnectionCard()}',entry.indexOf('function renderPlugTab()')));
const liveActions=entry.slice(entry.indexOf('function refreshDirectorLiveUI()'),entry.indexOf('async function generateDirectorPlan('));
const css=await fs.readFile(new URL('../style.css',import.meta.url),'utf8');
let requests=0,external=0;const errors=[],checks=[];
const server=http.createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/v1/chat/completions'){
    requests++;let raw='';for await(const chunk of req)raw+=chunk;
    const input=JSON.parse(raw);assert.equal(input.model,'fixture');assert.equal(input.stream,true);
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const frame=data=>`data: ${JSON.stringify(data)}\n\n`;
    res.write(frame({choices:[{delta:{content:'{"quests":[{"title":"完整条目","objective":"原文😀"}'}}]}));
    setTimeout(()=>{if(!res.destroyed)res.write(frame({choices:[{delta:{reasoning_content:'渠道推理内容'}}]}));},100);
    setTimeout(()=>{if(!res.destroyed)res.end(frame({choices:[{delta:{content:',{"title":"未闭合'},finish_reason:'length'}]})+'data: [DONE]\n\n');},250);
    return;
  }
  if(pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important}.sd-window{width:100%!important;margin:0!important}.sd-term-response{max-height:130px!important;overflow:auto!important}</style><div id="story-director-modal" class="open sd-theme-light"><div class="sd-window"><main class="sd-body"><div id="config"></div><div id="preview"></div><div id="logs"></div></main></div></div>`);return;}
  if(/^\/qianmu-[a-z0-9-]+\.js$/.test(pathname)){res.writeHead(200,{'Content-Type':'application/javascript'});res.end(await fs.readFile(new URL('..'+pathname,import.meta.url)));return;}
  res.writeHead(404);res.end();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext(),page=await context.newPage();
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){external++;return route.abort();}return route.continue();});
try{
  await page.goto(origin);
  await page.evaluate(async({logs,config})=>{
    const utils=await import('/qianmu-storyboard-utils.js');Object.assign(window,utils,await import('/qianmu-director-live.js'));
    window.settings={logOpenState:{live:true},temperature:0,apiUrl:location.origin,apiKey:'synthetic-local-only',model:'fixture',streamEnabled:true};
    (0,eval)(logs);window.renderConfig=new Function('isExternal','models','profiles',`return \`${config}\`;`);
    window.log={id:'live',status:'loading',response:'',request:'合成请求'};
    document.querySelector('#config').innerHTML=renderConfig(true,['fixture'],[]);
    document.querySelector('#logs').innerHTML=renderLogEntry(log,0);
    const {callExternalModel}=await import('/qianmu-model-external.js');
    window.finished=callExternalModel([{role:'user',content:'fixture'}],full=>{
      log.response=full;document.querySelector('#preview').innerHTML=renderDirectorLive(log);paintModelLog(document,log);
    },{stream:true,onResponse:result=>{log.reasoning=result.reasoning;log.completion=result;paintModelLog(document,log);}},new AbortController(),{
      settings,normalizeUrl:uri=>uri,normalizeQianmuChatApiRoot:uri=>uri,createQianmuChatCompletionResponseFormat:()=>null,
    }).catch(error=>{log.status='error';log.error=error.message;log.completion=error.modelResponse;
      document.querySelector('#preview').innerHTML=renderDirectorLive(log);document.querySelector('#logs').innerHTML=renderLogEntry(log,0);});
  },{logs,config});
  await page.waitForFunction(()=>document.querySelector('#preview')?.textContent.includes('完整条目'));
  assert.equal(await page.locator('#preview .sd-lib-row').count(),1);checks.push('a fully closed card becomes readable before the native HTTP stream finishes');
  await page.evaluate(()=>finished);assert.equal(await page.locator('#preview .sd-lib-row').count(),1);
  assert.match(await page.locator('#preview').innerText(),/未完整|截断/);assert.doesNotMatch(await page.locator('#preview').innerText(),/未闭合/);
  assert.match(await page.locator('.sd-term-response').innerText(),/未闭合/);assert.match(await page.locator('.sd-log-detail').innerText(),/length/);
  checks.push('truncation keeps full raw prefix and only complete cards, with an explicit reason and no resend');
  assert.equal(await page.locator('.sd-term-reasoning').textContent(),'渠道推理内容');checks.push('returned reasoning is separate and is not merged into story prose');
  for(const width of [320,393,1280]){
    await page.setViewportSize({width,height:898});
    for(const host of [true,false]){
      await page.evaluate(host=>{document.querySelector('#config').innerHTML=renderConfig(!host,['fixture'],[]);},host);
      assert.equal(await page.locator('.sd-model-config h3').innerText(),'模型配置');assert.equal(await page.locator('.sd-provider-select').count(),1);
      assert.equal(await page.locator('.sd-api-external-fields').isVisible(),!host);assert.equal(await page.locator('.sd-stream-toggle').isVisible(),true);
      assert.equal(await page.locator('.sd-save-api').isVisible(),!host);assert.equal(await page.locator('.sd-save-api-profile').isVisible(),!host);
      assert.equal(await page.locator('.sd-test-api i').count(),0);
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(overflow,false);
      checks.push(`${width}/${host?'ST':'custom'}: unified real model markup and common stream control fit the viewport`);
    }
  }
  await page.evaluate(()=>{
    log.response='long\n'.repeat(200);document.querySelector('#logs').innerHTML=renderLogEntry(log,0);
    const pre=document.querySelector('.sd-term-response');pre.scrollTop=40;window.oldScroll=pre.scrollTop;
    log.response+='new\n';paintModelLog(document,log);
  });assert.equal(await page.locator('.sd-term-response').evaluate(pre=>pre.scrollTop),await page.evaluate(()=>oldScroll));checks.push('incoming text respects a user who scrolled upward in the raw log');
  await page.evaluate(()=>{const pre=document.querySelector('.sd-term-response');pre.scrollTop=pre.scrollHeight;log.response+='more\n';paintModelLog(document,log);});
  assert.ok(await page.locator('.sd-term-response').evaluate(pre=>pre.scrollHeight-pre.scrollTop-pre.clientHeight<2));checks.push('a log already at the bottom continues following new output');
  assert.equal(await page.evaluate(()=>{
    log.status='loading';log.error='';document.querySelector('#logs').innerHTML=renderLogEntry(log,0);
    const pre=document.querySelector('.sd-term-response');pre.scrollTop=40;const top=pre.scrollTop;
    log.status='error';log.error='background interruption';log.duration='2s';paintModelLog(document,log,renderLogEntry);
    return document.querySelector('.sd-log-status').getAttribute('aria-label')==='失败'
      && document.querySelector('.sd-term-error').textContent==='background interruption'
      && pre===document.querySelector('.sd-term-response') && pre.scrollTop===top;
  }),true);checks.push('background final status and error update in place without replacing or scrolling the raw-text node');
  await page.evaluate(liveActions=>{
    Object.assign(window,{directorLiveLog:log,activeTab:'dashboard',MODAL_ID:'story-director-modal',LOG_LIMIT:40});
    document.querySelector('#preview').setAttribute('data-director-live-host','');document.querySelector('#logs').classList.add('sd-log-list');
    settings.logOpenState.live=false;log.response='{"quests":[{"title":"kept"}';
    window.renderModal=()=>{document.querySelector('#logs').innerHTML=renderLogEntry(log,0);document.querySelector('#preview').hidden=activeTab==='plug';};
    (0,eval)(liveActions);refreshDirectorLiveUI();refreshDirectorLiveUI();
  },liveActions);
  await page.locator('.sd-director-log').click();
  assert.equal(await page.evaluate(()=>activeTab),'plug');assert.equal(await page.locator('.sd-log-entry').count(),1);
  assert.equal(await page.locator('.sd-log-detail').isVisible(),true);assert.match(await page.locator('.sd-term-response').textContent(),/kept/);
  checks.push('production preview action opens exactly its own raw log without duplicating entries');
  assert.equal(requests,1);assert.equal(external,0);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:checks.length,checks,requests,external,errors,scope:'native local HTTP and production gateway/decoder/markup; synthetic configuration, no ST deployment or paid generation'}));
}finally{await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));}
