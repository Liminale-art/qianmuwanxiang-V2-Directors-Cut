// Actual world-map rendering, deterministic layout and event handlers; no ST state.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {storyboardFunctionSource} from '../tests/helpers/storyboard-form-fixture.mjs';
const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
const constants=['FACTION_RELATION_KINDS','FACTION_TRENDS','GEO_REL_COLOR','GEO_TREND_CN','GEO_TREND_ICON','EVENT_STAGE_CLS'].map(name=>{const match=source.match(new RegExp('^const '+name+' = .+;','m'));assert.ok(match,name);return match[0];}).join('\n');
const functions=['geoRelationKindsSelected','geoFactionClusters','geoClusteredNodeLayout','geoLabelLayout','geoPrimaryRelationKeys','renderFactionStarMap','starPath','renderWorldEventCard','renderFactionListView','renderGeopoliticsTab','bindGeopoliticsTabEvents'].map(storyboardFunctionSource).join('\n');
const css=await readFile(new URL('../style.css',import.meta.url),'utf8')+'\n'+await readFile(new URL('../qianmu-theme-skins.css',import.meta.url),'utf8');
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext(),page=await context.newPage();
const deadline=setTimeout(()=>{void browser.close();},120000),checks=[],errors=[];let external=0;
const qa=new URL('../dist/local-qa/world-map/',import.meta.url);await mkdir(qa,{recursive:true});
const ok=(label,value)=>{assert.ok(value,label);checks.push(label);};page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin==='https://qianmu.test'&&url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important;box-sizing:border-box}#story-director-modal .sd-window{width:100%!important;height:100%!important;max-height:none!important;margin:0!important}</style><div id="story-director-modal" class="open sd-theme-dark"><section class="sd-window"><main class="sd-body"></main></section></div>`});
  if(url.origin==='https://qianmu.test'&&/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname))return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url))});external++;return route.abort();
});
try{
  await page.goto('https://qianmu.test/');await page.evaluate(async source=>{
    const [utils,{createQianmuAppearanceSession},{updateAppearancePreferences},{applyQianmuIcons}]=await Promise.all([import('/qianmu-storyboard-utils.js'),import('/qianmu-appearance-session.js'),import('/qianmu-appearance-settings.js'),import('/qianmu-icon-renderer.js')]);
    for(const key of ['computeWorldHeat','heatTier','geoStableHash','geoRelationClass','snip','htmlEscape','sanitizeEventStage','EVENT_STAGE_LADDER'])window[key]=utils[key];
    window.applyQianmuIcons=applyQianmuIcons;window.getChatStore=()=>worldFixture;window.settings={theme:'dark',geopoliticsEnabled:true};window.activeTab='castworld';window.worldPage='geopolitics';
    window.calls={settings:0,confirmation:0,forbidden:0};window.saveSettings=()=>calls.settings++;window.confirmDialog=async()=>{calls.confirmation++;return false;};
    const forbidden=()=>{calls.forbidden++;throw Error('Production write is forbidden');};window.saveMetadata=forbidden;window.applyDirectorInjection=forbidden;window.toast=forbidden;window.renderModal=forbidden;
    (0,eval)(source);window.appearance=createQianmuAppearanceSession({readSettings:()=>settings,loadStyles:()=>({promise:Promise.resolve(true),cancel(){}})});appearance.mount(document.querySelector('#story-director-modal'));
    window.setAppearance=async(family,mode)=>{settings.appearance=updateAppearancePreferences(settings,{family,mode});await appearance.sync();};
    window.renderMap=(mode='populated')=>{
      settings.geopoliticsView='map';delete settings.geopoliticsRelationKinds;calls.settings=0;calls.confirmation=0;calls.forbidden=0;
      window.worldFixture={factions:['港口商会','远行者','城中守望','林地联盟'].map((name,i)=>({id:'f'+i,name,type:'团体',scale:'区域',trend:['rising','stable','declining','turbulent'][i],standing:'保留当下世界中的独立立场',agenda:'维持各自的诉求',clues:['未寄出的旧信','守望潮汐']})),
        factionRelations:[{a:'f0',b:'f1',kind:'同盟',note:'共同探索'},{a:'f0',b:'f2',kind:'冲突',note:'分歧尚未化解'},{a:'f1',b:'f3',kind:'依附',note:'暂时协作'},{a:'f2',b:'f3',kind:'张力',note:'彼此观望'},{a:'f0',b:'f3',kind:'中立',note:'尚无交集'}],
        worldEvents:EVENT_STAGE_LADDER.map((stage,i)=>({id:'e'+i,title:'港口商会与远行者 · 事件 '+i,stage,essence:'线索-'+ 'a'.repeat(96),scope:'沿海聚落',drift:'后续由当前叙事决定',status:'active'})).concat({id:'closed',title:'已落定的旧事',stage:'落定',status:'closed',essence:'历史事实仍保留'})};
      if(mode==='empty')worldFixture={factions:[],factionRelations:[],worldEvents:[]};if(mode==='events-only'){worldFixture.factions=[];worldFixture.factionRelations=[];}
      const body=document.querySelector('.sd-body');body.innerHTML=renderGeopoliticsTab();bindGeopoliticsTabEvents(body);applyQianmuIcons(body);body.scrollTop=0;
    };
    window.badgeContrast=node=>{const cv=document.createElement('canvas');cv.width=cv.height=1;const ctx=cv.getContext('2d');ctx.fillStyle=getComputedStyle(node).backgroundColor;ctx.fillRect(0,0,1,1);const bg=[...ctx.getImageData(0,0,1,1).data];ctx.fillStyle=getComputedStyle(node).color;ctx.fillRect(0,0,1,1);const fg=[...ctx.getImageData(0,0,1,1).data];const l=c=>c.slice(0,3).reduce((sum,v,i)=>{v/=255;return sum+[.2126,.7152,.0722][i]*(v<=.04045?v/12.92:((v+.055)/1.055)**2.4);},0);return (Math.max(l(bg),l(fg))+.05)/(Math.min(l(bg),l(fg))+.05);};
    window.mapTextContrast=node=>{const cv=document.createElement('canvas');cv.width=cv.height=1;const ctx=cv.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,1,1);const ancestors=[];for(let current=node;current;current=current.parentElement)ancestors.unshift(current);for(const current of ancestors){ctx.fillStyle=getComputedStyle(current).backgroundColor;ctx.fillRect(0,0,1,1);}const bg=[...ctx.getImageData(0,0,1,1).data];ctx.fillStyle=getComputedStyle(node).color;ctx.fillRect(0,0,1,1);const fg=[...ctx.getImageData(0,0,1,1).data];const l=c=>c.slice(0,3).reduce((sum,v,i)=>{v/=255;return sum+[.2126,.7152,.0722][i]*(v<=.04045?v/12.92:((v+.055)/1.055)**2.4);},0);return (Math.max(l(bg),l(fg))+.05)/(Math.min(l(bg),l(fg))+.05);};
  },constants+'\n'+functions);
  for(const [family,mode] of [['classic','dark'],['editorial','light'],['editorial','dark'],['glass','light'],['glass','dark']])for(const width of [320,393,1100]){
    const label=`${family}/${mode}/${width}`;await page.setViewportSize({width,height:width===320?568:898});await page.evaluate(async({family,mode})=>{await setAppearance(family,mode);renderMap();},{family,mode});
    ok(label+' actual map, relations and all five event stages render',await page.locator('.sd-geo-node').count()===4&&await page.locator('.sd-geo-edge').count()===5&&await page.locator('.sd-evt-card:not(.sd-evt-closed)').count()===5);
    await page.locator('[data-fid=f0]').focus();await page.keyboard.press('Enter');ok(label+' keyboard opens the real faction detail',await page.locator('.sd-geo-node.sd-on').getAttribute('data-fid')==='f0'&&await page.locator('.sd-geo-detail').isVisible());
    await page.locator('.sd-geo-detail').evaluate(node=>Promise.all(node.getAnimations().map(animation=>animation.finished)));
    ok(label+' faction detail retains readable foreground on its fixed dark canvas',await page.locator('.sd-geo-d-head h4,.sd-geo-d-standing,.sd-geo-d-agenda,.sd-geo-d-meta span,.sd-geo-d-kind,.sd-geo-d-rtext').evaluateAll(nodes=>nodes.length>5&&nodes.every(node=>mapTextContrast(node)>=4.5)));
    await page.locator('[data-fid=f0] .sd-geo-clue-hit').first().dispatchEvent('click');ok(label+' clue handler reveals the original text',await page.locator('.sd-geo-cluepop').textContent()==='未寄出的旧信');
    const stable=await page.evaluate(async({family,mode})=>{
      const body=document.querySelector('.sd-body'),node=body.querySelector('[data-fid=f0]');node.focus({preventScroll:true});body.scrollTop=30;
      const html=body.innerHTML,all=[...body.querySelectorAll('*')],saved=JSON.stringify(calls),data=JSON.stringify(worldFixture),top=body.scrollTop,animations=body.getAnimations({subtree:true});
      await setAppearance(family==='glass'?'editorial':'glass',mode==='light'?'dark':'light');await setAppearance(family,mode);
      return {nodes:html===body.innerHTML&&all.every(el=>el.isConnected),focus:document.activeElement===node,scroll:Math.abs(top-body.scrollTop)<1,calls:JSON.stringify(calls)===saved,data:JSON.stringify(worldFixture)===data,animation:animations.every(animation=>body.getAnimations({subtree:true}).includes(animation))};
    },{family,mode});ok(label+' hot theme swap keeps geometry, selected faction, clue, animation and owner: '+JSON.stringify(stable),Object.values(stable).every(Boolean));
    await page.locator('.sd-geo-filter[data-kind="冲突"]').click();ok(label+' relationship filter updates both real views',await page.locator('.sd-geo-edge[data-kind="冲突"]').evaluate(node=>node.classList.contains('sd-kind-hidden'))&&await page.locator('.sd-geo-list-rel[data-kind="冲突"]').evaluateAll(nodes=>nodes.every(node=>node.classList.contains('sd-kind-hidden'))));
    await page.locator('.sd-geo-view-btn[data-view=list]').click();ok(label+' list switch uses the existing handler and keeps the map mounted',await page.locator('.sd-geo-list-view').isVisible()&&!await page.locator('.sd-geo-map-view').isVisible()&&await page.locator('.sd-geo-node').count()===4);
    await page.locator('.sd-geo-list-card').first().evaluate(node=>node.open=true);
    ok(label+' expanded list keeps its dark-canvas text contrast',await page.locator('.sd-geo-list-card[open] .sd-geo-list-body p,.sd-geo-list-card[open] .sd-geo-list-rel > b,.sd-geo-list-card[open] .sd-geo-list-rel > span').evaluateAll(nodes=>nodes.length>2&&nodes.every(node=>mapTextContrast(node)>=4.5)));
    if(family!=='classic'){
      ok(label+' event grid and its inner text do not overflow',await page.locator('.sd-evt-grid, .sd-evt-essence').evaluateAll(nodes=>nodes.filter(node=>node.getClientRects().length).every(node=>node.scrollWidth<=node.clientWidth+1)));
      ok(label+' outer surfaces match the selected family',await page.locator('.sd-geo-events').evaluate((node,family)=>getComputedStyle(node).borderTopLeftRadius===(family==='glass'?'22px':'0px'),family));
      await page.locator('.sd-geo-view-btn[data-view=list]').focus();
      await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
      ok(label+' keyboard focus stays visible on the dark map island',await page.locator('.sd-geo-view-btn[data-view=list]').evaluate(node=>getComputedStyle(node).outlineWidth==='2px'&&getComputedStyle(node).outlineColor==='rgb(233, 231, 226)'));
      const contrast=await page.locator('.sd-evt-card:not(.sd-evt-closed) .sd-evt-badge').evaluateAll(nodes=>nodes.map(badgeContrast));ok(label+' five stage labels retain readable semantic colors: '+JSON.stringify(contrast),contrast.every(value=>value>=4.5));
    }
    ok(label+' graph keeps its intentional neutral dark canvas',await page.locator('.sd-geo-stage').evaluate(node=>getComputedStyle(node).backgroundColor==='rgb(12, 13, 18)'));
    await page.locator('.sd-geo-view-btn[data-view=map]').click();
    await page.locator('.sd-geo-detail').evaluate(node=>Promise.all(node.getAnimations().map(animation=>animation.finished)));
    if(width===393&&((family==='glass'&&mode==='light')||(family==='editorial'&&mode==='dark'))){await page.locator('.sd-body').evaluate(node=>node.scrollTop=0);await page.screenshot({caret:'initial',animations:'disabled',path:fileURLToPath(new URL(`${family}-${mode}-map-393.png`,qa))});await page.locator('.sd-geo-events').scrollIntoViewIfNeeded();await page.screenshot({caret:'initial',animations:'disabled',path:fileURLToPath(new URL(`${family}-${mode}-events-393.png`,qa))});}
    const before=await page.evaluate(()=>JSON.stringify(worldFixture));await page.locator('.sd-geo-clear').click();ok(label+' cancelled clear cannot mutate world records',await page.evaluate(before=>JSON.stringify(worldFixture)===before&&calls.confirmation===1&&calls.forbidden===0,before));
    await page.evaluate(()=>renderMap('events-only'));ok(label+' event-only world remains usable without an SVG',await page.locator('.sd-geo-map').count()===0&&await page.locator('.sd-geo-clear').count()===1&&await page.locator('.sd-evt-card').count()===6);
    await page.evaluate(()=>renderMap('empty'));ok(label+' empty state preserves its original guidance',await page.locator('.sd-geo-empty').count()===1);
  }
  await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>renderMap());ok('reduced-motion preference stops decorative world-map animations',await page.locator('.sd-geo-orbit,.sd-geo-edge-flow,.sd-geo-event-pulse').evaluateAll(nodes=>nodes.every(node=>getComputedStyle(node).animationName==='none')));
  await page.evaluate(()=>appearance.reset());assert.deepEqual(errors,[]);assert.equal(external,0);console.log(JSON.stringify({passed:checks.length,checks,errors,external,scope:'actual world graph renderer and event bindings; settings saved only in memory, world writes forbidden'}));
}finally{clearTimeout(deadline);await context.close();await browser.close();}
