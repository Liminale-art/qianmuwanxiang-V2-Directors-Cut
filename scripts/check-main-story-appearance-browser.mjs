// Actual main-tab renderers, isolated story state and native details/checkboxes.
// No ST host bindings, injection, generation, persistence or history mutations.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {storyboardFunctionSource} from '../tests/helpers/storyboard-form-fixture.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const names=['renderActiveTab','renderDashboardTab','renderHeroActions','renderInjectBadge','renderGenerateRow','renderHistorySection','renderTasksNodesTab','renderChainReactionsCard','renderCastWorldTab','renderCastWorldFront','renderWorldChatterCard','renderRelationUndercurrentsCard','renderPlanSectionFold','renderNoPlan','renderItemList','renderItemCard','renderItemChips','getContextItemId','renderDirectorWorldEntryLink','renderInjectDock'];
const source=names.map(storyboardFunctionSource).join('\n');
const css=await readFile(new URL('../style.css',import.meta.url),'utf8')+'\n'+await readFile(new URL('../qianmu-theme-skins.css',import.meta.url),'utf8');
const qa=new URL('../dist/local-qa/main-story/',import.meta.url);await mkdir(qa,{recursive:true});
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext(),page=await context.newPage();
const checks=[],errors=[];let external=0;const deadline=setTimeout(()=>{void browser.close();},120000);
const ok=(name,value)=>{assert.ok(value,name);checks.push(name);};
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin==='https://qianmu.test'&&url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important;box-sizing:border-box}#story-director-modal .sd-window{width:100%!important;height:100%!important;max-height:none!important;margin:0!important}#story-director-modal .sd-body{padding-bottom:80px!important}</style><div id="story-director-modal" class="open sd-theme-dark"><section class="sd-window"><main class="sd-body"></main><div id="dock"></div></section></div>`});
  if(url.origin==='https://qianmu.test'&&/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname))return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url),'utf8')});
  external++;return route.abort();
});
try{
  await page.goto('https://qianmu.test/');
  await page.evaluate(async source=>{
    const [{createQianmuAppearanceSession},{updateAppearancePreferences},{applyQianmuIcons}]=await Promise.all([import('/qianmu-appearance-session.js'),import('/qianmu-appearance-settings.js'),import('/qianmu-icon-renderer.js')]);
    Object.assign(window,{editorView:false,activeTab:'dashboard',worldPage:'front',busy:false,chatterExpanded:false,injectSelection:new Set(['quest-0-quest0']),directorWorldEntryLinks:new Map(),settings:{theme:'dark',injectEnabled:true,worldChatterEnabled:true}});
    window.htmlEscape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');window.snip=(s,n)=>String(s||'').slice(0,n);window.formatDateTime=()=> '2026-09-17 05:00';
    window.currentPlan=()=>plan;window.getChatStore=()=>({history:storyHistory});
    (0,eval)(source);
    window.appearance=createQianmuAppearanceSession({readSettings:()=>settings,loadStyles:()=>({promise:Promise.resolve(true),cancel(){}})});appearance.mount(document.getElementById('story-director-modal'));
    window.setAppearance=async(family,mode)=>{settings.appearance=updateAppearancePreferences(settings,{family,mode});await appearance.sync();};
    window.renderScene=(tab,state='populated')=>{
      activeTab=tab;busy=state==='busy';chatterExpanded=state==='expanded';
      const long='长标题与当下正文中需要完整保留的线索',item={title:long.repeat(3),description:'记录当前叙事事实，不改写角色的选择。',objective:'archive-'+ 'a'.repeat(96),trigger:'在下一段互动中自行决定',reward:'发现新的线索',type:'探索',priority:'随叙事节奏',status:'未开始',deadline:'不固定时段'};
      window.plan=state==='empty'?null:{story_status:{cycle:'第七幕',title:'临海手记 · 风起之时',summary:long.repeat(5),current_arc:'当下叙事',current_stage:'雨后',mood:'宁静'},director_comment:['众声：风仍在吹。','<img src=x> 仅作为纯文本'],
        quests:Array.from({length:8},(_,i)=>({...item,id:'quest'+i,title:i?'探索片段 '+i:item.title})),chain_reactions:[{spark:'一个念头',chain:'停步 → 发现旧信 → 选择去向'}],
        npc_updates:[{id:'npc0',name:'旅人',role:'同伴',emotional_state:'平静',current_goal:'寻找归路',next_action:'观察潮汐',hidden_agenda:'等待一封信',relations:'港口的旧识'}],world_updates:[{id:'world0',name:'潮汐变化',content:'海岸上浮现旧路',scope:'沿海',type:'环境',timing:'当下'}],
        world_chatter:[{text:long,who:'水手',where:'码头'},{text:'明天或许会放晴',who:'店主',where:'街角'}],relation_undercurrents:[{parties:'旅人与店主',tone:'pos',tension:'互相信任',drift:'分享一段见闻',user_awareness:'witness'},{parties:'两位旧识',tone:'neg',tension:'未解的误会',drift:'仍有转圜',user_awareness:'rumor'}]};
      window.storyHistory=state==='empty'?[]:Array.from({length:6},(_,i)=>({id:'history'+i,createdAt:1,plan:{story_status:{title:'保留的审片 '+i}}}));
      directorWorldEntryLinks.clear();directorWorldEntryLinks.set('quests:0',{packetId:'packet-0',records:[{}]});directorWorldEntryLinks.set('npc_updates:0',{packetId:'npc-packet',records:[]});
      const body=document.querySelector('.sd-body');body.innerHTML=renderActiveTab();document.getElementById('dock').innerHTML=renderInjectDock();applyQianmuIcons(document.getElementById('story-director-modal'));
      body.querySelectorAll('.sd-item-fold').forEach((node,i)=>{node.open=i===0;});body.scrollTop=0;
    };
    window.contrast=node=>{
      const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d'),parents=[];for(let el=node;el;el=el.parentElement)parents.push(el);
      ctx.fillStyle=getComputedStyle(document.querySelector('.sd-window')).getPropertyValue('--qm-bg')||'#181818';ctx.fillRect(0,0,1,1);
      for(const el of parents.reverse()){ctx.fillStyle=getComputedStyle(el).backgroundColor;ctx.fillRect(0,0,1,1);}const bg=[...ctx.getImageData(0,0,1,1).data];
      ctx.fillStyle=getComputedStyle(node).color;ctx.fillRect(0,0,1,1);const fg=[...ctx.getImageData(0,0,1,1).data];
      const l=c=>c.slice(0,3).reduce((sum,v,i)=>{v/=255;return sum+[.2126,.7152,.0722][i]*(v<=.04045?v/12.92:((v+.055)/1.055)**2.4);},0);
      return (Math.max(l(bg),l(fg))+.05)/(Math.min(l(bg),l(fg))+.05);
    };
  },source);
  for(const [family,mode] of [['classic','dark'],['editorial','light'],['editorial','dark'],['glass','light'],['glass','dark']])for(const width of [320,393,1100])for(const tab of ['dashboard','tasksnodes','castworld']){
    const label=`${family}/${mode}/${width}/${tab}`;await page.setViewportSize({width,height:width===320?568:898});await page.evaluate(async({family,mode,tab})=>{await setAppearance(family,mode);renderScene(tab);},{family,mode,tab});
    ok(label+' existing narrative controls are present and text stays escaped',await page.evaluate(tab=>{
      if(document.querySelector('.sd-body img'))return false;
      if(tab==='dashboard')return document.querySelectorAll('.sd-load-history').length===5&&!!document.querySelector('.sd-generate-main');
      if(tab==='tasksnodes')return document.querySelectorAll('.sd-item-quest').length===8&&!!document.querySelector('.sd-chain-node')&&!!document.querySelector('.sd-world-media-entry')&&!!document.querySelector('.sd-inject-dock');
      return !!document.querySelector('.sd-chatter-stage')&&document.querySelectorAll('.sd-relus-row').length===2&&!!document.querySelector('.sd-item-world')&&!!document.querySelector('.sd-item-npc');
    },tab));
    const continuity=await page.evaluate(async({family,mode})=>{
      const root=document.querySelector('#story-director-modal'),body=root.querySelector('.sd-body'),focus=root.querySelector('input')||root.querySelector('button');focus.focus({preventScroll:true});if(focus.matches('input[type=checkbox]'))focus.checked=!focus.checked;
      body.scrollTop=Math.min(60,(body.scrollHeight-body.clientHeight)/2);const top=body.scrollTop,html=body.innerHTML,children=[...body.querySelectorAll('*')],checked=focus.checked,active=activeTab,planBefore=JSON.stringify(plan);
      await setAppearance(family==='glass'?'editorial':'glass',mode==='light'?'dark':'light');await setAppearance(family,mode);
      return {nodes:body.innerHTML===html&&children.every(node=>node.isConnected),focus:document.activeElement===focus,scroll:Math.abs(body.scrollTop-top)<1,selection:focus.checked===checked,plan:JSON.stringify(plan)===planBefore,tab:activeTab===active};
    },{family,mode});ok(label+' theme changes preserve nodes, focus, folds, choices, scroll and plan: '+JSON.stringify(continuity),Object.values(continuity).every(Boolean));
    if(family!=='classic'){
      ok(label+' long content has no horizontal overflow',await page.locator('.sd-body').evaluate(node=>node.scrollWidth<=node.clientWidth+1));
      ok(label+' long details are not clipped inside their enclosing card',await page.locator('.sd-item-detail dd, .sd-item-summary-main h4, .sd-chain-node').evaluateAll(nodes=>nodes.every(node=>node.scrollWidth<=node.clientWidth+1)));
      if(tab==='tasksnodes')ok(label+' nested task surface follows the selected family',await page.locator('.sd-item-card').first().evaluate((node,family)=>getComputedStyle(node).borderTopLeftRadius===(family==='glass'?'22px':'5px'),family));
      if(tab==='castworld'){
        const ratios=await page.locator('.sd-relus-tone').evaluateAll(nodes=>nodes.map(node=>contrast(node)));
        ok(label+' positive and negative relationship labels remain readable: '+JSON.stringify(ratios),ratios.every(value=>value>=4.5));
      }
    }
    if(width===393&&((family==='glass'&&mode==='light'&&tab==='tasksnodes')||(family==='editorial'&&mode==='light'&&tab==='castworld')||(family==='editorial'&&mode==='dark'&&tab==='dashboard'))){await page.evaluate(()=>document.querySelector('.sd-body').scrollTop=0);await page.screenshot({caret:'initial',path:fileURLToPath(new URL(`${family}-${mode}-${tab}-393.png`,qa))});}
    await page.evaluate(tab=>renderScene(tab,'empty'),tab);ok(label+' original empty state stays available',await page.locator('.sd-empty').count()===1&&await page.locator('.sd-inject-dock').count()===0);
  }
  await page.evaluate(async()=>{await setAppearance('glass','light');renderScene('dashboard','busy');});ok('running inference keeps its existing stop action',await page.locator('.sd-generate-main').textContent().then(text=>text.includes('停止推演')));
  await page.evaluate(()=>renderScene('castworld','expanded'));ok('world chatter keeps its full script mode',await page.locator('.sd-chatter-list .sd-chatter-line').count()===2&&await page.locator('.sd-chatter-stage').count()===0);
  await page.evaluate(()=>appearance.reset());assert.deepEqual(errors,[]);assert.equal(external,0);
  console.log(JSON.stringify({passed:checks.length,checks,errors,external,scope:'actual dashboard/tasks/world-front rendering and native controls; host binding and world geopolitics remain separate'}));
}finally{clearTimeout(deadline);await context.close();await browser.close();}
