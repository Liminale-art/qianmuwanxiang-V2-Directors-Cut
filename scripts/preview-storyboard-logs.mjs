// Real log renderer/bindings + receipt view + appearance session. Synthetic memory only.
// Open in the in-app browser; no model, media, persistent storage or clipboard writes.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const files=new Set(['style.css','qianmu-text-collection-floor.css','qianmu-theme-skins.css']);
async function allowModule(name){
  if(files.has(name))return;
  if(!/^[a-zA-Z0-9._-]+\.js$/.test(name))throw Error('Non-local preview dependency');
  files.add(name);
  const source=await readFile(new URL(name,root),'utf8');
  for(const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]\.\/([^'"?]+)(?:\?[^'"]*)?['"]/g))await allowModule(match[1]);
}
for(const name of ['qianmu-storyboard.js','qianmu-comfy-inbox-view.js','qianmu-comfy-workbench.js','qianmu-runninghub-usage.js','qianmu-appearance-session.js','qianmu-icon-renderer.js'])await allowModule(name);
const outer=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>千幕日志 · 隔离预览</title><link rel="icon" href="data:,">
<style>body{margin:0;padding:16px;background:#e7eeea;color:#293b32;font:14px/1.5 system-ui}main{max-width:1080px;margin:auto}h1{font-size:20px;margin:0}p{margin:7px 0}nav{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0}button{border:1px solid #82988b;border-radius:6px;padding:7px 12px;background:white;color:#293b32;font:inherit}button[aria-pressed=true]{background:#3e6850;color:white}iframe{display:block;width:100%;height:1000px;margin:auto;border:1px solid #92a49b;box-sizing:border-box;background:white}iframe.narrow{width:min(390px,100%)}output{display:block;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;min-height:24px}</style>
<main><h1>日志与收片 · 实际组件预览</h1><p>全部为合成记录。没有真实聊天、模型、图片获取或持久写入；复制动作只计数。</p><nav aria-label="预览控制"><button data-family="classic">经典</button><button data-family="glass">流光</button><button data-family="editorial">纸间</button><button id="mode">切换明暗</button><button id="width">切换390宽</button><button id="tests">运行界面回归</button><button id="retry">重试运行配置</button></nav><output id="report">正在加载实际 renderer…</output><iframe title="日志收片隔离预览" src="/frame"></iframe></main><script type="module" src="/outer.js"></script></html>`;
const outerJs=`const frame=document.querySelector('iframe'),report=document.getElementById('report');let family='classic',dark=false;
const send=action=>frame.contentWindow.postMessage({action,family,dark},location.origin);
document.querySelectorAll('[data-family]').forEach(button=>button.onclick=()=>{family=button.dataset.family;send('theme');document.querySelectorAll('[data-family]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));});
document.getElementById('mode').onclick=()=>{dark=!dark;send('theme');};document.getElementById('width').onclick=()=>frame.classList.toggle('narrow');document.getElementById('tests').onclick=()=>send('tests');
document.getElementById('retry').onclick=()=>send('retry');
window.addEventListener('message',event=>{if(event.origin===location.origin&&event.source===frame.contentWindow)report.textContent=event.data.report;});`;
const frame=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><title>实际日志与收片组件</title><style>body{margin:0;background:#eef2ef;color:#293b32;font:14px/1.5 system-ui}#story-director-modal{position:relative!important;inset:auto!important;display:block!important;width:100%!important;height:auto!important;max-height:none!important;overflow:visible!important;box-sizing:border-box;padding:12px!important;background:var(--sd-sticky-bg);border-radius:0!important}#panel.sd-storyboard-root{display:block!important;height:auto!important;max-height:none!important;min-height:0!important;overflow:visible!important}#notice{padding:4px 12px;font-size:12px}</style><p id="notice" role="status">仅本机合成记录</p><section id="story-director-modal" class="sd-theme-light"><div id="panel" class="sd-storyboard-root"></div></section><script type="module" src="/client.js"></script></html>`;
async function entry(){
  const source=await readFile(new URL('index.js',root),'utf8');
  const section=name=>{const match=new RegExp('^(?:async )?function '+name+'\\(','m').exec(source);if(!match)throw Error('Missing entry '+name);const tail=source.slice(match.index),next=tail.slice(1).search(/^(?:async )?function /m);return next<0?tail:tail.slice(0,next+1);};
  const labels=source.slice(source.indexOf('const STORYBOARD_PIPELINE_STAGE_LABELS ='),source.indexOf('\nfunction storyboardStageText('));
  return `import {sanitizeStoryboardDiagnosticData,STORYBOARD_SOURCES} from '/qianmu-storyboard.js';import {renderRunningHubTaskUsage} from '/qianmu-runninghub-usage.js';
export function createPreview(state,host){
const htmlEscape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const formatDateTime=value=>new Date(value||0).toLocaleString(),storyboardState=()=>state,storyboardPipelineForLog=log=>state.pipelineLogs.find(row=>row.id===log.pipelineId),storyboardCanReceiveComfyLog=()=>false;
const storyboardActiveJobs=new Map(),storyboardQueue=[],storyboardQueuePendingCount=()=>0,storyboardQueueSettling=false,coreadCopyText=host.copy,toast=host.notice;
const settings={},storyboardAdmissionEpoch=0,getChatKey=()=> 'synthetic-chat',uid=()=> 'fixture',storyboardImageServiceRuntime=async()=>host.nai,formatStorageBytes=value=>String(value||0)+' B',applyQianmuIcons=host.icons;
const storyboardReviewServiceImage=async()=>({message:'仅模拟核查'}),storyboardReceiveServiceImage=async()=>host.notice('仅模拟领取，无外部请求');
${labels}\n${['storyboardStageText','storyboardLogPresentation','storyboardLogExchangeText','bindStoryboardLogExchange','bindStoryboardLogStages','renderStoryboardLogs','storyboardPaintServiceInbox'].map(section).join('\n')}
return {render:()=>renderStoryboardLogs(state),bind:root=>root.querySelectorAll('[data-storyboard-log]').forEach(row=>{const log=state.logs.find(item=>item.id===row.dataset.storyboardLog);bindStoryboardLogExchange(row,log,state);bindStoryboardLogStages(row,log,state);}),nai:root=>storyboardPaintServiceInbox(root)};
}`;
}
const client=`import {createPreview} from '/entry.js';import {mountComfyInbox} from '/qianmu-comfy-inbox-view.js';import {confirmRunningHubRetryExecution} from '/qianmu-comfy-workbench.js';import {createQianmuAppearanceSession} from '/qianmu-appearance-session.js';import {applyQianmuIcons} from '/qianmu-icon-renderer.js';
const panel=document.getElementById('panel'),modal=document.getElementById('story-director-modal'),notice=document.getElementById('notice');let family='classic',dark=false,disposeInbox,copyCount=0;
let settings={theme:'light',appearance:{version:1,family:'classic',mode:'light',source:'manual',accent:'#719688'}};
const appearance=createQianmuAppearanceSession({document,readSettings:()=>settings,styleUrl:new URL('/qianmu-theme-skins.css',location.href)});
const long='合成的长提示词，只用于验证折叠与换行。'.repeat(400),now=Date.now();
const state={logs:[{id:'failed',status:'failed',source:'comfy',pipelineId:'failed-p',submissionState:'unknown',model:'合成测试模型',startedAt:now,durationMs:1800,params:{width:1024,height:1536},error:'请求超时，请先核查原任务'},
 {id:'success',status:'success',source:'comfy',pipelineId:'success-p',model:'合成测试模型',startedAt:now-2000,durationMs:1500,params:{width:1024,height:1024}}],pipelineLogs:[
 {id:'failed-p',stages:[{id:'plan',type:'compiler_narrative',status:'success',input:{messages:[{content:long}],apiKey:'synthetic-secret'},output:{response:'合成取景返回',usage:{total_tokens:480}}},
 {id:'audit',type:'comfy_workflow_audit',status:'success',input:{workflow:{nodes:4}},output:{checked:true}},
 {id:'request',type:'provider_request',status:'failed',input:{prompt:long},error:'请求超时，请先核查原任务',output:{status:'unknown'}}]},
 {id:'success-p',stages:[{id:'success-request',type:'provider_request',status:'success',input:{prompt:'合成提示词'},output:{status:'succeeded'}},{id:'persist',type:'asset_persistence',status:'success',output:{saved:1}}]}]};
const original={attemptId:'synthetic-original',createdAt:now,status:'available',imageCount:1,cacheBytes:1048576,resultAvailable:true,model:'RunningHub 合成测试模型',engine:'cloud',task:{provider:'runninghub'},canDiscard:false,canReceiveOriginal:true,usage:{consumeCoins:'1.2500'}};
const rows=[original,{...original,attemptId:'synthetic-uncertain',status:'uncertain',resultAvailable:false,usage:null},{...original,attemptId:'synthetic-failed',reportedStatus:'failed',resultAvailable:false,usage:null},{...original,attemptId:'synthetic-archived',archiveState:'archived',canRetryCleanup:true}];
const service={list:async()=>({namespace:'synthetic',rows,bytes:500}),catalog:async()=>({namespace:'synthetic',originals:rows,totals:{imageBytes:1048576,metadataBytes:500,temporaryBytes:0,reservedBytes:0},cloudCapabilities:{resultRetrieval:true,resultProviders:['runninghub'],submission:false,archiveConfirmation:true}}),discard:async()=>({removed:0,cancelled:true}),removeLocal:async()=>({removed:0,cancelled:true})};
const naiRow={attemptId:'nai-synthetic',createdAt:now,status:'uncertain',snapshot:{profile:{model:'NAI 合成模型'}},namespace:'synthetic',model:'NAI 合成模型',resultAvailable:false,canDiscard:false};
const preview=createPreview(state,{icons:applyQianmuIcons,copy:async()=>{copyCount++;notice.textContent='已模拟复制 '+copyCount+' 次；未写系统剪贴板';},notice:message=>notice.textContent=message,
 nai:{list:async()=>[naiRow],catalog:async()=>({namespace:'synthetic',originals:[naiRow],tasks:[],totals:{count:1,imageBytes:100,metadataBytes:0,temporaryBytes:0,reservedBytes:0}}),dismiss:async()=>{},discardOriginal:async()=>false}});
panel.innerHTML=preview.render();preview.bind(panel);applyQianmuIcons(panel);
const inbox=panel.querySelector('.sd-storyboard-comfy-inbox'),nai=panel.querySelector('.sd-storyboard-service-inbox');
function openInbox(){disposeInbox?.();nai.hidden=true;inbox.hidden=false;disposeInbox=mountComfyInbox(inbox,{service,receive:async()=>({warning:'仅模拟核查，未发起任何外部请求'})});}
panel.querySelector('.sd-storyboard-open-comfy-inbox').onclick=openInbox;
panel.querySelector('.sd-storyboard-open-service-inbox').onclick=()=>{inbox.hidden=true;nai.hidden=false;void preview.nai(panel);};
for(const button of panel.querySelectorAll('.sd-storyboard-retry-log,.sd-storyboard-load-log,.sd-storyboard-export-logs,.sd-storyboard-clear-logs,.sd-storyboard-pack-export,.sd-storyboard-pack-recover,.sd-storyboard-copy-log'))button.onclick=()=>notice.textContent='此预览不执行生成、导出或数据修改';
const release=appearance.mount(modal);openInbox();
const report=value=>parent.postMessage({report:value},location.origin);
class SyntheticPopup {
 constructor(content,_type,_value,options){this.options=options;this.dlg=document.createElement('dialog');this.dlg.className='popup';
  const body=document.createElement('div');body.className='popup-body';const area=document.createElement('div');area.className='popup-content';area.append(content);body.append(area);
  const controls=document.createElement('div');controls.className='popup-controls';controls.style.cssText='display:flex;justify-content:center;gap:12px;margin-top:16px';
  for(const [label,result,className] of [[options.okButton,1,'popup-button-ok'],[options.cancelButton,0,'popup-button-cancel']]){const button=document.createElement('button');button.type='button';button.className='menu_button '+className;button.textContent=label;button.onclick=()=>this.finish(result);controls.append(button);}
  body.append(controls);this.dlg.append(body);this.dlg.addEventListener('cancel',event=>{event.preventDefault();void this.finish(0);});
 }
 show(){const result=new Promise(resolve=>this.resolve=resolve);document.body.append(this.dlg);this.dlg.showModal();this.dlg.querySelector('select').focus();return result;}
 async finish(result){this.result=result;if(await this.options.onClosing?.(this)===false)return;this.dlg.close();this.dlg.remove();this.resolve(result);}
}
async function retry(){if(document.querySelector('dialog[open]'))return;const value=await confirmRunningHubRetryExecution({context:{Popup:SyntheticPopup,POPUP_TYPE:{CONFIRM:1}},instanceType:'',text:'保存 1 张，接收 1 张\\n继续前请确认数量、输出节点与可能费用。',isCurrent:()=>true,mountAppearance:dialog=>appearance.mountPortal(dialog,{inheritTheme:true})});report('运行配置结果：'+JSON.stringify(value)+'；0 模型请求 / 0 提交 / 0 持久写入');}
async function theme(){settings={theme:dark?'dark':'light',appearance:{version:1,family,mode:dark?'dark':'light',source:'manual',accent:'#719688'}};appearance.repaintClassic();await appearance.sync();report('主题 '+family+' / '+(dark?'dark':'light')+'；0 模型请求 / 0 持久写入');}
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
async function tests(){let checks=0;const check=(value,label)=>{if(!value)throw Error(label);checks++;};const log=panel.querySelector('[data-storyboard-log="failed"]');
 check(!log.open,'record initially closed');check(log.querySelector('.sd-storyboard-log-summary-reason').textContent.includes('超时'),'error summary visible');
 log.open=true;await tick();check([...log.querySelectorAll('pre')].every(pre=>pre.textContent===''),'lazy initial text');
 const buttons=[...log.querySelectorAll('.sd-storyboard-stage-toggle')],first=buttons[0],second=buttons[1];first.click();check(!first.parentElement.querySelector('section').hidden,'inline first open');check(first.parentElement.querySelector('pre').textContent.includes('合成的长提示词'),'full stage text');check(!first.parentElement.querySelector('pre').textContent.includes('synthetic-secret'),'credentials redacted');
 second.click();check(first.parentElement.querySelector('section').hidden&&first.parentElement.querySelector('pre').textContent==='','old stage released');check(!second.parentElement.querySelector('section').hidden,'second under its node');
 const fold=log.querySelector('.sd-storyboard-log-exchanges');fold.open=true;await tick();check(fold.querySelector('pre').textContent.length>1000,'full explicit exchange');fold.open=false;await tick();check(fold.querySelector('pre').textContent==='','exchange released');
 log.open=false;await tick();check([...log.querySelectorAll('pre')].every(pre=>pre.textContent===''),'closing clears all long text');
 check(!inbox.querySelector('.sd-comfy-inbox-storage').open,'storage folded');check([...inbox.querySelectorAll('.sd-comfy-inbox-row-detail')].every(detail=>!detail.open),'row technical details folded');check([...inbox.querySelectorAll('.sd-comfy-inbox-notice')].some(node=>node.textContent.includes('重复付费')),'uncertain risk visible');check(document.documentElement.scrollWidth<=innerWidth+1,'no horizontal page overflow');
 report('PASS '+checks+' actual DOM checks; '+family+' / '+(dark?'dark':'light')+'; 0 model / 0 persistent writes');}
window.addEventListener('message',async event=>{if(event.origin!==location.origin||event.source!==parent)return;try{if(event.data.action==='theme'){family=event.data.family;dark=event.data.dark;await theme();}else if(event.data.action==='tests')await tests();else if(event.data.action==='retry')await retry();}catch(error){report('FAIL '+error.message);}});
window.addEventListener('pagehide',()=>{disposeInbox?.();release();appearance.reset();});await theme();`;
const server=createServer(async(req,res)=>{
  try{if(req.method!=='GET'){res.writeHead(405).end();return;}
    const path=new URL(req.url,'http://127.0.0.1').pathname.slice(1);let body,type='text/javascript; charset=utf-8';
    if(!path){body=outer;type='text/html; charset=utf-8';}else if(path==='frame'){body=frame;type='text/html; charset=utf-8';}
    else if(path==='outer.js')body=outerJs;else if(path==='client.js')body=client;else if(path==='entry.js')body=await entry();
    else if(files.has(path)){body=await readFile(new URL(path,root));if(path.endsWith('.css'))type='text/css; charset=utf-8';}
    else{res.writeHead(404).end();return;}
    res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:; frame-src 'self'; font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"});res.end(body);
  }catch(error){res.writeHead(500,{'Content-Type':'text/plain'}).end('Preview unavailable: '+error.message);}
});
server.listen(18759,'127.0.0.1',()=>console.log('Synthetic log preview: http://127.0.0.1:18759/'));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
