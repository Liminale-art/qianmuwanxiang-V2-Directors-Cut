// Actual log renderer/bindings and theme CSS; only synthetic in-memory records.
// No ST session, private prose, persistence, provider access or generation.
import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {storyboardFunctionSource as section} from '../tests/helpers/storyboard-form-fixture.mjs';

const entry=await readFile(new URL('../index.js',import.meta.url),'utf8');
const labels=entry.slice(entry.indexOf('const STORYBOARD_PIPELINE_STAGE_LABELS ='),entry.indexOf('\nfunction storyboardStageText('));
const source=labels+'\n'+['storyboardLogPresentation','storyboardLogExchangeText','storyboardStageText','bindStoryboardLogExchange','bindStoryboardLogStages','renderStoryboardLogs','storyboardOpenImageLog'].map(section).join('\n');
const css=await readFile(new URL('../style.css',import.meta.url),'utf8')+'\n'+await readFile(new URL('../qianmu-theme-skins.css',import.meta.url),'utf8');
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext(),page=await context.newPage(),checks=[],errors=[],blocked=[];
let external=0;
const deadline=setTimeout(()=>void browser.close(),90000);
const ok=(label,value)=>{assert.ok(value,label);checks.push(label);};
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin==='https://qianmu.test'&&url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important;padding:0!important}.sd-window{width:100%!important;height:100%!important;max-height:none!important;margin:0!important}</style><div id="story-director-modal" class="open sd-theme-light"><section class="sd-window"><div class="sd-body"><section class="sd-storyboard-root"><div class="sd-storyboard-scroll" id="log-host"></div></section></div></section></div>`});
  if(url.origin==='https://qianmu.test'&&/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url))});
  if(url.origin==='https://qianmu.test'&&url.pathname==='/qianmu-text-collection-floor.css')return route.fulfill({contentType:'text/css',body:await readFile(new URL('..'+url.pathname,import.meta.url))});
  external++;blocked.push(url.href);return route.abort();
});
try{
  await page.goto('https://qianmu.test/');
  await page.evaluate(async source=>{
    const [core,usage,{createQianmuAppearanceSession},{updateAppearancePreferences},storage]=await Promise.all([import('/qianmu-storyboard.js'),import('/qianmu-runninghub-usage.js'),import('/qianmu-appearance-session.js'),import('/qianmu-appearance-settings.js'),import('/qianmu-storage-backup-view.js')]);
    window.state={view:'logs',logs:[
      {id:'job-1000000001',kind:'prompt_compiler',status:'failed',source:'comfy',submissionState:'not_submitted',error:'HTTP 503 '+('retained error '.repeat(200)),startedAt:1},
      {id:'job-1000000002',status:'failed',source:'comfy',submissionState:'unknown',error:'original unfinished diagnostic',startedAt:2},
      {id:'job-1000000003',status:'success',source:'comfy',pipelineId:'pipeline-current',recordIds:['image-current'],startedAt:3}],pipelineLogs:[{id:'pipeline-current',stages:[
        {id:'plan',type:'compiler_narrative',status:'success',input:{prompt:'synthetic scene, 合成段落; '.repeat(200),apiKey:'synthetic-secret'},output:{checked:true}},
        {id:'save',type:'asset_persistence',status:'success',output:{saved:1}}]}]};
    Object.assign(window,{sanitizeStoryboardDiagnosticData:core.sanitizeStoryboardDiagnosticData,STORYBOARD_SOURCES:core.STORYBOARD_SOURCES,renderRunningHubTaskUsage:usage.renderRunningHubTaskUsage,
      htmlEscape:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),formatDateTime:()=> '2026/10/4 10:10:00',
      storyboardActiveJobs:new Map(),storyboardQueue:[],storyboardQueuePendingCount:()=>0,storyboardQueueSettling:0,storyboardReceiveComfyImage:{pending:0},storyboardReceiveServiceImage:{pending:0},
      storyboardState:()=>state,storyboardPipelineForLog:log=>state.pipelineLogs.find(item=>item.id===log.pipelineId),coreadCopyText:async()=>{},toast:message=>window.notices.push(message),notices:[],
      MODAL_ID:'story-director-modal',activeTab:'imagegen',settings:{theme:'light'},
      storyboardHydratePipelineArchive:async()=>{await Promise.resolve();renderLogs();},openModal:()=>renderLogs()});
    window.eval(source);
    window.renderLogs=()=>{const host=document.querySelector('#log-host');host.innerHTML=renderStoryboardLogs(state);host.querySelectorAll('[data-storyboard-log]').forEach(row=>{const log=state.logs.find(item=>item.id===row.dataset.storyboardLog);bindStoryboardLogStages(row,log,state);bindStoryboardLogExchange(row,log,state);});};
    window.renderStorage=()=>{const host=document.querySelector('#log-host');host.innerHTML=`<section class="sd-storage-card">${storage.renderStorageBackupSection(null)}</section>`;host.querySelector('details').open=true;};
    const appearance=createQianmuAppearanceSession({readSettings:()=>settings,loadStyles:()=>({promise:Promise.resolve(true),cancel(){}})});appearance.mount(document.querySelector('#story-director-modal'));
    window.theme=async(family,mode)=>{settings.theme=mode;settings.appearance=updateAppearancePreferences(settings,{family,mode});document.querySelector('#story-director-modal').className='open sd-theme-'+mode;await appearance.sync();renderLogs();};
  },source);
  for(const family of ['classic','glass','editorial'])for(const mode of ['light','dark'])for(const width of [320,390,960]){
    const label=`${family}/${mode}/${width}`;
    await page.setViewportSize({width,height:800});await page.evaluate(({family,mode})=>theme(family,mode),{family,mode});
    ok(label+' actual appearance scope active',await page.evaluate(({family,mode})=>{const root=document.querySelector('#story-director-modal');return family==='classic'?!root.hasAttribute('data-qm-theme')&&root.classList.contains('sd-theme-'+mode):root.dataset.qmTheme===family&&root.dataset.qmMode===mode;},{family,mode}));
    const summary=await page.evaluate(()=>[...document.querySelectorAll('.sd-storyboard-log > summary')].map(node=>({
      children:node.children.length,text:node.innerText,name:node.querySelector('.sd-storyboard-log-name').textContent.trim(),date:node.querySelector('time').textContent,status:node.querySelector('.sd-storyboard-log-status').textContent,
      closed:!node.parentElement.open,rects:[...node.children].map(child=>{const r=child.getBoundingClientRect();return {x:r.x,right:r.right};})})));
    ok(label+' summaries expose only task/name number, date and status',summary.every(item=>item.children===3&&item.closed&&item.date==='2026/10/4 10:10:00')&&summary.map(item=>item.name).join('|')==='取景 #1000000001|生图 #1000000002|生图 #1000000003'&&summary.map(item=>item.status).join('|')==='失败|未完成|成功');
    ok(label+' compact summaries fit viewport',summary.every(item=>item.rects.every(rect=>rect.x>=0&&rect.right<=width+1)));
    ok(label+' no inbox, export, resource kit or exposed internal error',await page.evaluate(()=>!document.querySelector('.sd-storyboard-service-inbox,.sd-storyboard-comfy-inbox,.sd-storyboard-export-logs,.sd-storyboard-pack-export')&&!document.querySelector('#log-host').innerText.includes('retained error')));
    ok(label+' clear is an accessible icon fitting the viewport',await page.evaluate(()=>{const button=document.querySelector('.sd-storyboard-clear-logs'),r=button.getBoundingClientRect();return button.getAttribute('aria-label')==='清空日志'&&!button.innerText.trim()&&r.width>=30&&r.width<=56&&r.x>=0&&r.right<=innerWidth+1;}));
    await page.evaluate(()=>storyboardOpenImageLog({id:'image-current'}));
    await page.waitForFunction(()=>document.querySelector('[data-storyboard-log="job-1000000003"]').open);
    ok(label+' image shortcut reveals exact current task after hydration',await page.evaluate(()=>[...document.querySelectorAll('.sd-storyboard-log[open]')].map(row=>row.dataset.storyboardLog).join()==='job-1000000003'));
    const current=page.locator('[data-storyboard-log="job-1000000003"]');
    await current.locator('.sd-storyboard-stage-toggle').first().click();
    ok(label+' stage expands under its own node, sanitized and lazy',await current.evaluate(row=>{const buttons=[...row.querySelectorAll('.sd-storyboard-stage-toggle')],detail=buttons[0].parentElement.querySelector('.sd-storyboard-stage-detail');return buttons[0].getAttribute('aria-expanded')==='true'&&!detail.hidden&&detail.querySelector('pre').textContent.includes('synthetic scene')&&!detail.querySelector('pre').textContent.includes('synthetic-secret')&&row.querySelectorAll('[data-log-exchange] pre')[0].textContent==='';}));
    await current.locator('.sd-storyboard-stage-toggle').nth(1).click();
    ok(label+' moving stage collapses and releases previous full details',await current.evaluate(row=>{const details=[...row.querySelectorAll('.sd-storyboard-stage-detail')];return details[0].hidden&&details[0].querySelector('pre').textContent===''&&!details[1].hidden&&details[1].querySelector('pre').textContent.includes('saved');}));
    await current.locator('.sd-storyboard-log-exchanges > summary').click();
    ok(label+' explicit raw exchange is retained but credentials hidden',await current.evaluate(row=>{const content=row.querySelector('[data-log-exchange="input"] pre').textContent;return content.length>1000&&!content.includes('synthetic-secret');}));
    await current.locator(':scope > summary').click();
    await page.waitForFunction(()=>[...document.querySelectorAll('[data-storyboard-log="job-1000000003"] pre')].every(node=>node.textContent===''));
    ok(label+' closing releases detail text and no page overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.evaluate(()=>renderStorage());
    ok(label+' central resource row exposes export import and accessible recovery without overflow',await page.evaluate(()=>{const row=document.querySelector('.sd-storage-backup-storyboard'),buttons=[...row.querySelectorAll('button')];return buttons.length===3&&buttons[2].getAttribute('aria-label')==='核对分镜导入'&&buttons.every(button=>{const r=button.getBoundingClientRect();return r.x>=0&&r.right<=innerWidth+1&&r.height>=30;})&&document.documentElement.scrollWidth<=innerWidth+1;}));
  }
  await page.evaluate(()=>renderLogs());
  await page.evaluate(()=>storyboardOpenImageLog({id:'missing-image'}));
  ok('missing image log reports honestly without opening a different task',await page.evaluate(()=>notices.at(-1)==='这张图片的任务记录已不在日志中'&&!document.querySelector('.sd-storyboard-log[open]')));
  ok('no external requests and no browser runtime errors',external===0&&errors.length===0);
  if(process.env.QIANMU_VISUAL_QA_DIR){await mkdir(process.env.QIANMU_VISUAL_QA_DIR,{recursive:true});await page.setViewportSize({width:390,height:800});await page.evaluate(()=>theme('glass','light'));await page.screenshot({path:join(process.env.QIANMU_VISUAL_QA_DIR,'storyboard-logs-compact-glass.png')});}
  console.log(JSON.stringify({passed:checks.length,checks,external,errors,limits:'Isolated real Chromium DOM; no live ST, server, provider, persistence or paid generation.'},null,2));
}catch(error){
  console.error(JSON.stringify({errors,external,blocked,openRows:await page.locator('.sd-storyboard-log[open]').evaluateAll(rows=>rows.map(row=>({id:row.dataset.storyboardLog,stages:[...row.querySelectorAll('.sd-storyboard-stage-detail')].map(node=>({hidden:node.hidden,text:node.textContent.slice(0,250)}))})))}));
  throw error;
}finally{clearTimeout(deadline);await browser.close();}
