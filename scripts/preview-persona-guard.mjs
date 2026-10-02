// Synthetic-only browser reproduction: no ST service, chat data, model or persistence.
// Run with modern Node, then open http://127.0.0.1:18757/ in the in-app browser.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = new URL('../', import.meta.url), port = Number(process.env.QIANMU_PERSONA_PREVIEW_PORT || 18757);
const jquery = 'D:/ST/tools/SillyTavern-upstream/public/lib/jquery-3.5.1.min.js';
const baseline = execFileSync('git', ['show', '02f3f89d:index.js'], {cwd:fileURLToPath(root), encoding:'utf8', maxBuffer:4*1024*1024});
function functionSource(source, name) {
    const match = new RegExp(`^function ${name}\\(`, 'm').exec(source);
    if (!match) throw Error('Missing fixture function: ' + name);
    const tail = source.slice(match.index), next = tail.slice(1).search(/^(?:async )?function /m);
    return next < 0 ? tail : tail.slice(0, next + 1);
}
function personaModule(source) {
    return `export function createFixturePersona(context) { const ctx=()=>context;
${functionSource(source, 'getPersonaDescription')}
return getPersonaDescription; }`;
}
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>空人设 · 真实 DOM 与取景准备检查</title><link rel="icon" href="data:,">
<style>body{font:16px/1.6 system-ui;background:#f4f7f5;color:#20312b;margin:24px}main{max-width:960px;margin:auto}button{font:inherit;padding:9px 14px;margin:5px 8px 12px 0;border:1px solid #50675c;border-radius:8px;background:white;color:#20312b}textarea{display:block;width:90%;height:40px;border:1px solid #9aac9f;background:white}output{display:block;white-space:pre-wrap;background:white;border:1px solid #a8b6ac;border-radius:10px;padding:16px;min-height:160px}h1{font-size:23px}small{color:#51645a}</style>
<main><h1>空人设误拦截 · 隔离复现</h1><p>真实 jQuery 3.5.1 + 实际入口函数 + 生产准备检查。仅模拟输入，完全无模型请求、无真实聊天与持久写入。</p>
<label for="persona_description">模拟 ST 空人设输入框（保持空白）</label><textarea id="persona_description"></textarea>
<button id="baseline">运行 v425 基线</button><button id="current">运行当前工作树</button><small>代码在每次运行时重新载入；修复后不用重启此服务。</small>
<output id="report" aria-live="polite">准备就绪。结果只显示类型、固定原因码和检查布尔值。</output></main>
<script src="/jquery.js"></script><script type="module" src="/client.js"></script></html>`;
const client = `import {createStoryboardPreparationGuard} from '/qianmu-storyboard-preparation-guard.js';
const report=document.getElementById('report'),textarea=document.getElementById('persona_description');
const state={enabled:true,source:'comfy',target:'latest',floor:0,promptCompiler:{includeRecentFloors:0},promptPresets:[],artistPresets:[],shotPlans:[]};
const context={chat:[{mes:'synthetic fixture floor',swipe_id:0}],mainApi:'openai',powerUserSettings:{persona_description:''}};
const hostFor=getPersonaDescription=>({ctx:()=>context,getChatKey:()=> 'synthetic-chat',storyboardState:()=>state,
storyboardTargetFloor:()=>0,storyboardProviderProfile:()=>({}),getCharacterDescription:()=> 'synthetic character',getPersonaDescription,
document,settings:{apiProfiles:[]},providers:{},draftApiKeys:new Map()});
function inspect(getPersonaDescription){
 const value=getPersonaDescription(), guard=createStoryboardPreparationGuard(state,{},hostFor(getPersonaDescription));
 try{return {personaType:typeof value,personaIsNamedTextarea:value===textarea,personaIsMacro:value==='{{persona}}',
  immediatelyCurrent:guard.isCurrent(),reason:guard.inputChangeReason};}finally{guard.dispose();}
}
async function run(version){
 report.textContent='正在运行隔离检查…';
 try{
  const {createFixturePersona}=await import('/persona-'+version+'.js?fresh='+Date.now());
  const getPersonaDescription=createFixturePersona(context);
  context.powerUserSettings.persona_description='';textarea.value='';jQuery(textarea).off();
  const beforeBinding=inspect(getPersonaDescription);
  jQuery(textarea).on('input.synthetic',()=>{});
  const handlers=jQuery._data(textarea,'events').input;
  const afterBinding=inspect(getPersonaDescription);
  const keys=Object.keys(handlers), copiedKeys=Object.keys(handlers.map(value=>value));
  context.powerUserSettings.persona_description='synthetic valid persona';
  const withString=inspect(getPersonaDescription);
  const changeGuard=createStoryboardPreparationGuard(state,{},hostFor(getPersonaDescription));
  context.powerUserSettings.persona_description='synthetic changed persona';
  const rejectsRealChange=!changeGuard.isCurrent(), realChangeReason=changeGuard.inputChangeReason;changeGuard.dispose();
  context.powerUserSettings.persona_description='';
  const result={version,jquery:jQuery.fn.jquery,namedGlobalIsTextarea:window.persona_description===textarea,
   beforeBinding,afterBinding,jqueryArray:{hasDelegateCount:Object.hasOwn(handlers,'delegateCount'),originalKeys:keys,mappedKeys:copiedKeys},
   withString,rejectsRealChange,realChangeReason,modelRequests:0};
  result.verdict=afterBinding.immediatelyCurrent&&afterBinding.personaType==='string'&&rejectsRealChange?'PASS: no false cancellation; real changes still cancel':
   afterBinding.reason==='preparation_context_changed'&&afterBinding.personaIsNamedTextarea?'REPRODUCED: unchanged empty persona is cancelled':'CHECK: unexpected fixture outcome';
  report.textContent=JSON.stringify(result,null,2);
 }catch(error){report.textContent='ERROR '+error.message;}
}
document.getElementById('baseline').onclick=()=>run('baseline');document.getElementById('current').onclick=()=>run('current');`;

const server=createServer(async(req,res)=>{
    try {
        if(req.method!=='GET'){res.writeHead(405).end();return;}
        const path=new URL(req.url,'http://127.0.0.1').pathname;
        let body, type='text/javascript; charset=utf-8';
        if(path==='/'){body=html;type='text/html; charset=utf-8';}
        else if(path==='/client.js')body=client;
        else if(path==='/jquery.js')body=await readFile(jquery);
        else if(path==='/persona-baseline.js')body=personaModule(baseline);
        else if(path==='/persona-current.js')body=personaModule(await readFile(new URL('index.js',root),'utf8'));
        else if(path==='/qianmu-storyboard-preparation-guard.js')body=await readFile(new URL('qianmu-storyboard-preparation-guard.js',root));
        else {res.writeHead(404).end();return;}
        res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});res.end(body);
    }catch(error){res.writeHead(500,{'Content-Type':'text/plain'}).end('Fixture unavailable: '+error.message);}
});
server.listen(port,'127.0.0.1',()=>console.log('Synthetic persona guard preview: http://127.0.0.1:'+port+'/'));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
