// Actual entry factory/controller/renderer; only the ST host is synthetic.
// Run with modern Node and open http://127.0.0.1:18758/ in the in-app browser.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const files=new Set(['style.css','qianmu-text-collection-floor.css','qianmu-theme-skins.css',
  'qianmu-storyboard-worldbooks.js','qianmu-storyboard-persona-world.js','qianmu-storyboard-worldbook-view.js',
  'qianmu-appearance-session.js','qianmu-appearance-runtime.js','qianmu-appearance-settings.js','qianmu-appearance-portals.js',
  'qianmu-classic-palettes.js','qianmu-theme-surfaces.js','qianmu-theme-palette.js','qianmu-input-boundary.js','qianmu-icon-renderer.js']);
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>人设世界书 · 实际入口隔离预览</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/style.css">
<style>body.preview{margin:0;padding:18px;background:#e8eeeb;color:#233b30;font:14px/1.55 system-ui}.preview>main{max-width:1000px;margin:auto}.preview h1{font-size:21px;margin:0}.preview p{margin:6px 0}.controls{display:flex;gap:7px;flex-wrap:wrap;margin:9px 0}.controls button{font:inherit;border:1px solid #80978b;border-radius:7px;padding:6px 10px;background:white;color:#263e31}.controls button[aria-pressed=true]{background:#365c48;color:white}.preview output{display:block;white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;border:1px solid #94a99e;background:white;border-radius:9px;margin:10px 0;font-size:12px}.preview #story-director-modal{position:relative!important;inset:auto!important;width:100%!important;height:auto!important;display:block!important;overflow:visible!important;z-index:0;padding:14px!important;background:var(--sd-sticky-bg);border:1px solid var(--sd-border);border-radius:14px;margin:auto}.preview #story-director-modal.narrow{width:min(390px,100%)!important}.preview #panel.sd-storyboard-root{display:block!important;grid-template-rows:none!important;overflow:visible!important;height:auto!important;max-height:none!important;min-height:0!important}.preview #notice{min-height:1.6em;color:#833918}</style>
<body class="preview"><main><h1>人设世界书 · 实际入口隔离预览</h1><p>实际 index 工厂 → controller → renderer。数据全为内存合成；没有真实聊天、持久写入或模型请求。A/B 显示名相同、描述均为空，仅身份不同。</p>
<nav class="controls" aria-label="模拟身份"><button id="char-a">角色 A（同名空描述）</button><button id="char-b">角色 B（同名空描述）</button><button id="user-a">User A（同名空描述）</button><button id="user-b">User B（同名空描述）</button><button id="dual">切换同书双绑定</button></nav>
<nav class="controls" aria-label="隔离数据操作"><button id="mutate">当前书新增并禁用条目</button><button id="restore">还原模拟书内容</button><button id="prepare">预检并读取（不外发）</button><button id="reset">重置全部模拟状态</button></nav>
<nav class="controls" aria-label="外观"><button data-family="classic">经典</button><button data-family="glass">流光</button><button data-family="editorial">纸间</button><button id="mode">切换明暗</button><button id="width">切换390宽</button></nav>
<output id="identity">正在加载…</output><p id="notice" role="status" aria-live="polite"></p>
<section id="story-director-modal" class="sd-theme-light"><div id="panel" class="sd-storyboard-root"></div></section>
<output id="report" aria-live="polite">先点击一本书，勾选草稿并取消或确认；再切换身份及运行预检。</output>
</main><script type="module" src="/client.js"></script></body></html>`;
const mainModule=`export let user_avatar='user-a.png';export function selectUser(value){user_avatar=value;}`;
const worldModule=`export function getWorldInfoSettings(){return {world_info:{charLore:[]}};}`;
async function entryModule(){
  const source=await readFile(new URL('index.js',root),'utf8');
  const imported=source.match(/import\s*\{createStoryboardWorldbookController\}\s*from\s*['"]([^'"]+)['"]/);
  const start=source.indexOf('function storyboardWorldbookRuntime('), end=source.indexOf('\nasync function storyboardWarmCompilerWorldEntries(',start);
  if(!imported||start<0||end<start)throw Error('Actual worldbook entry factory not found');
  return `import {createStoryboardWorldbookController} from '${imported[1]}';
export function createPreviewRuntime(host){
let storyboardWorldbookController=null,storyboardAdmissionEpoch=host.epoch;host.syncEpoch=()=>{storyboardAdmissionEpoch=host.epoch;};
const storyboardState=()=>host.state,ctx=()=>host.context,getChatKey=()=>host.chatKey;
const stMainScriptUrl=()=>new URL('/host-main.js',location.href).href;
const listWorldBooks=()=>host.names(),stWorldBookEntries=(_context,book)=>host.entries(book);
const storyboardCleanMessageText=host.clean,resolveMacro=host.resolve,saveSettings=host.save,renderModal=host.render;
const activeTab='imagegen',MODAL_ID='story-director-modal',toast=host.toast;
const {htmlEscape,badge,hashText,cleanContextText}=host.format;
${source.slice(start,end)}
return storyboardWorldbookRuntime();
}`;
}
const client=`import {createPreviewRuntime} from '/entry.js';
import {createQianmuAppearanceSession} from '/qianmu-appearance-session.js';
import {applyQianmuIcons} from '/qianmu-icon-renderer.js';
import {selectUser,user_avatar} from '/host-main.js';
const panel=document.getElementById('panel'),modal=document.getElementById('story-director-modal'),report=document.getElementById('report'),notice=document.getElementById('notice');
const types=['PERSONA_CHANGED','PERSONA_UPDATED','CHAT_CHANGED','CHARACTER_EDITED','WORLDINFO_UPDATED','WORLDINFO_SETTINGS_UPDATED'];
const listeners=new Map(),events={on(type,fn){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},removeListener(type,fn){listeners.get(type)?.delete(fn);},emit(type){for(const fn of listeners.get(type)||[])fn();}};
const freshBooks=()=>({'角色设定':[{uid:1,name:'角色外貌',content:'合成角色外貌。'},{uid:2,name:'角色背景',content:'合成角色背景。'},{uid:3,name:'默认禁用',content:'禁用合成条目。',disable:true}],
 '用户设定':[{uid:11,name:'用户外貌',content:'合成用户外貌。'},{uid:12,name:'用户背景',content:'合成用户背景。'}]});
const freshCompiler=()=>({worldBookNames:[],worldEntryIds:[],worldBookInitializedNames:[],worldBookView:'',personaWorldSelections:[]});
let books=freshBooks(),family='classic',dark=false,serial=20,last={status:'尚未预检'},controller;
const count={names:0,entries:0,simulatedSaves:0};
const context={characters:[{avatar:'char-a.png',name:'同名角色',description:'',data:{extensions:{world:'角色设定'}}},{avatar:'char-b.png',name:'同名角色',description:'',data:{extensions:{world:'角色设定'}}}],
 characterId:0,name1:'同名User',powerUserSettings:{persona_description:'',persona_description_lorebook:'用户设定'},chatMetadata:{},eventSource:events,eventTypes:Object.fromEntries(types.map(type=>[type,type]))};
const htmlEscape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
let settings={theme:'light',appearance:{version:1,family:'classic',mode:'light',source:'manual',accent:'#719688'}};
const appearance=createQianmuAppearanceSession({document,readSettings:()=>settings,styleUrl:new URL('/qianmu-theme-skins.css',location.href)});
const host={state:{promptCompiler:freshCompiler(),collapsedCards:{}},context,chatKey:'synthetic-chat',epoch:0,
 async names(){count.names++;return Object.keys(books);},async entries(book){count.entries++;return Object.hasOwn(books,book)?structuredClone(books[book]):null;},
 clean:value=>String(value),resolve:async value=>value,save(){count.simulatedSaves++;status();},render:paint,
 toast(message){notice.textContent=message;status();},format:{htmlEscape,badge:value=>'<span class="sd-badge">'+htmlEscape(value)+'</span>',
 hashText:value=>[...String(value)].reduce((hash,letter)=>Math.imul(hash^letter.charCodeAt(0),16777619),2166136261)>>>0,cleanContextText:value=>String(value)}};
function status(){
 const view=controller.view(host.state);
 document.getElementById('identity').textContent=JSON.stringify({character:context.characters[context.characterId].avatar,user:user_avatar,sameDisplayNames:true,bothDescriptionsEmpty:true,
  userBook:context.powerUserSettings.persona_description_lorebook,books:view.books.map(({name,labels,pending,selected})=>({name,labels,pending,selected})),editing:view.editing},null,2);
 report.textContent=JSON.stringify({lastPrecheck:last,readCounts:{names:count.names,books:count.entries},simulatedSaveCalls:count.simulatedSaves,persistentWrites:0,modelRequests:0,
  confirmations:host.state.promptCompiler.personaWorldSelections.map(({kind,owner,book,entryIds,enabled})=>({kind,owner,book,entryIds,enabled}))},null,2);
 for(const letter of ['a','b']){document.getElementById('char-'+letter).setAttribute('aria-pressed',String(context.characterId===(letter==='a'?0:1)));document.getElementById('user-'+letter).setAttribute('aria-pressed',String(user_avatar==='user-'+letter+'.png'));}
 document.getElementById('dual').setAttribute('aria-pressed',String(context.powerUserSettings.persona_description_lorebook==='角色设定'));
}
function paint(){panel.innerHTML=controller.render(host.state);controller.bind(panel);applyQianmuIcons(panel);status();}
async function refresh(event){host.epoch++;host.syncEpoch();events.emit(event);notice.textContent='';await controller.warm({force:true});paint();}
const run=fn=>async()=>{try{await fn();}catch(error){notice.textContent=error.message;status();}};
for(const letter of ['a','b']){
 document.getElementById('char-'+letter).onclick=run(async()=>{context.characterId=letter==='a'?0:1;await refresh('CHARACTER_EDITED');});
 document.getElementById('user-'+letter).onclick=run(async()=>{selectUser('user-'+letter+'.png');await refresh('PERSONA_CHANGED');});
}
document.getElementById('dual').onclick=run(async()=>{context.powerUserSettings.persona_description_lorebook=context.powerUserSettings.persona_description_lorebook==='角色设定'?'用户设定':'角色设定';await refresh('PERSONA_UPDATED');});
document.getElementById('mutate').onclick=run(async()=>{const book=host.state.promptCompiler.worldBookView||'角色设定';books[book].push({uid:++serial,name:'后来新增条目 '+serial,content:'新增的合成内容。'});if(books[book][1])books[book][1].disable=true;await refresh('WORLDINFO_UPDATED');notice.textContent='已新增条目并禁用该书第二条；确认过的选择不会自动加入新条目。';});
document.getElementById('restore').onclick=run(async()=>{books=freshBooks();await refresh('WORLDINFO_UPDATED');});
document.getElementById('reset').onclick=run(async()=>{controller.cancel();host.state.promptCompiler=freshCompiler();context.characterId=0;selectUser('user-a.png');context.powerUserSettings.persona_description_lorebook='用户设定';books=freshBooks();last={status:'尚未预检'};await refresh('CHAT_CHANGED');});
document.getElementById('prepare').onclick=run(async()=>{
 const guard={assertCurrent(){this.worldbooks?.assertCurrent();}};
 try{await controller.prepare(host.state,guard);const result=await controller.read(host.state,guard);last={status:'通过（未外发）',selectedIds:result.rows.map(row=>row.id),selectedCount:result.rows.length};notice.textContent='预检及读取完成，只报告条目编号，不发送。';}
 catch(error){last={status:'已阻止',code:error.code||'',reason:error.inputChangeReason||''};notice.textContent=error.message;}
 finally{guard.worldbooks?.close();status();}
});
async function theme(){settings={theme:dark?'dark':'light',appearance:{version:1,family,mode:dark?'dark':'light',source:'manual',accent:'#719688'}};appearance.repaintClassic();await appearance.sync();for(const button of document.querySelectorAll('[data-family]'))button.setAttribute('aria-pressed',String(button.dataset.family===family));}
document.querySelectorAll('[data-family]').forEach(button=>button.onclick=run(async()=>{family=button.dataset.family;await theme();}));
document.getElementById('mode').onclick=run(async()=>{dark=!dark;await theme();});document.getElementById('width').onclick=()=>modal.classList.toggle('narrow');
panel.addEventListener('change',()=>setTimeout(status,0));
controller=createPreviewRuntime(host);const release=appearance.mount(modal);await controller.warm();paint();await theme();
window.addEventListener('pagehide',()=>{controller.cancel();release();appearance.reset();});`;

const server=createServer(async(req,res)=>{
  try{
    if(req.method!=='GET'){res.writeHead(405).end();return;}
    const path=new URL(req.url,'http://127.0.0.1').pathname.slice(1);
    let body,type='text/javascript; charset=utf-8';
    if(!path){body=html;type='text/html; charset=utf-8';}
    else if(path==='client.js')body=client;
    else if(path==='entry.js')body=await entryModule();
    else if(path==='host-main.js')body=mainModule;
    else if(path==='scripts/world-info.js')body=worldModule;
    else if(files.has(path)){body=await readFile(new URL(path,root));if(path.endsWith('.css'))type='text/css; charset=utf-8';}
    else{res.writeHead(404).end();return;}
    res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'self' data:; font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"});res.end(body);
  }catch(error){res.writeHead(500,{'Content-Type':'text/plain'}).end('Preview unavailable: '+error.message);}
});
server.listen(18758,'127.0.0.1',()=>console.log('Synthetic worldbooks preview: http://127.0.0.1:18758/'));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
