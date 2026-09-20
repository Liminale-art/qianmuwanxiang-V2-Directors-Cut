// Real renderModal/header/dashboard + main-tabs + appearance session. Only host,
// model, persistence and unrelated page bindings are replaced with inert fixtures.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {storyboardFunctionSource} from '../tests/helpers/storyboard-form-fixture.mjs';

const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const source=['renderModal','qianmuVersionBadgeMarkup','renderDashboardTab','renderHeroActions','renderInjectBadge','renderGenerateRow','renderHistorySection','renderInjectDock'].map(storyboardFunctionSource).join('\n');
const index=await readFile(new URL('../index.js',import.meta.url),'utf8');
const resizeSource=index.match(/    resizeHandler = \(\) => \{[\s\S]*?\n    \};\r?\n    window\.addEventListener\('resize', resizeHandler\);/)?.[0];
assert.ok(resizeSource,'production resize handler remains available to execute');
const css=await readFile(new URL('../style.css',import.meta.url),'utf8')+'\n'+await readFile(new URL('../qianmu-theme-skins.css',import.meta.url),'utf8');
const qa=new URL('../dist/local-qa/main-tabs/',import.meta.url);await mkdir(qa,{recursive:true});
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext(),page=await context.newPage(),checks=[],errors=[],screenshots=[];
const deadline=setTimeout(()=>void browser.close(),120000);let external=0;
const ok=(name,value,detail)=>{assert.ok(value,detail?`${name}: ${JSON.stringify(detail)}`:name);checks.push(name);};
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',async route=>{
 const url=new URL(route.request().url());
 if(url.origin==='https://qianmu.test'&&url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0;min-height:2200px;background:#ccc}#host-probe{margin:3px 8px;padding:5px;border-radius:2px;color:rgb(91,37,53);background:rgb(211,227,241)}#story-director-modal .sd-body{scroll-behavior:auto}</style><button id="host-probe" class="sd-tab active">宿主按钮</button><div id="story-director-modal" class="open sd-theme-dark"></div>`});
 if(url.origin==='https://qianmu.test'&&/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url),'utf8')});
 external++;return route.abort();
});
try{
 await page.goto('https://qianmu.test/');
 await page.evaluate(async({source,resizeSource})=>{
  const [tabs,appearance,preferences,icons,menu,palettes,utils]=await Promise.all([import('/qianmu-main-tabs.js'),import('/qianmu-appearance-session.js'),import('/qianmu-appearance-settings.js'),import('/qianmu-icon-renderer.js'),import('/qianmu-theme-menu.js'),import('/qianmu-classic-palettes.js'),import('/qianmu-storyboard-utils.js')]);
  Object.assign(window,tabs,preferences,icons,menu,palettes,{htmlEscape:utils.htmlEscape});
  const noop=()=>{},forbidden=()=>{throw Error('Unexpected real host/model operation');};
  Object.assign(window,{MODAL_ID:'story-director-modal',EXTENSION_NAME:'千幕',VERSION:'隔离视觉',COREAD_VISIBLE:true,COREAD_ENABLED:false,activeTab:'dashboard',editorView:null,theaterView:null,readerView:null,worldPage:'front',modalJustOpened:false,busy:false,coreadOpenRequestId:0,focusClockLockConfirming:false,focusClockLockGuard:null,storyboardVibeLibraryController:null,storyboardPendingRestoreScroll:null,
   settings:{theme:'dark',lastTab:'dashboard',injectEnabled:true},qianmuUpdateState:{status:'idle',available:false},FLOAT_ID:'story-director-float',notesPanelOpen:false,resizeHandler:null,
   performanceRuntime:{modalRenderCount:0,modalRenderTotalMs:0,modalRenderMaxMs:0,slowModalRenderCount:0,rendersByTab:{}},
   featureRuntime:{bindIntent:noop},focusClockActiveLock:()=>false,preserveQianmuStoryboardNav:()=>noop,currentHiveThemeKey:()=>settings.theme,
   currentPlan:()=>({story_status:{cycle:'第七幕',title:'临海手记 · 风起之时',summary:'雨停以后，两人循着海风走入旧城。街角的灯刚刚亮起，窗后的旧信仍等待拆开。',current_arc:'寻找归路',current_stage:'雨后的港口',mood:'平静、留有悬念'},director_comment:['风仍在吹，故事尚未落幕。','旧信与灯火是此刻的两个叙事锚点。','让角色保留自己的选择。']}),
   getChatStore:()=>({history:Array.from({length:5},(_,i)=>({id:'fixture'+i,createdAt:1,plan:{story_status:{title:'旅途片段 '+(i+1)}}}))}),formatDateTime:()=> '2026-09-20 18:30',
   renderWorldPageEdges:()=>'',toast:noop,storyboardBeginSession:forbidden,
  });
  for(const name of ['focusClockCancelEntry','focusClockPauseForReadingExit','storyboardCaptureTagDraft','prepareDirectorWorldEntryLinks','saveSettings','snapshotAccState','closeModal','bindQianmuVersionBadge','focusClockCloseVoiceDrawer','bindActiveTabEvents','refreshDirectorLiveUI','bindNotesPanelEvents','applyAccState','renderBusyState','syncFontWithST','renderFloatButton','syncNotesTheme','closeQuickWheel','applyFloatPosition','renderFloatingNotes','syncNotesPanelSizeToViewport'])window[name]=noop;
  window.appearanceSession=appearance.createQianmuAppearanceSession({readSettings:()=>settings,loadStyles:()=>({promise:Promise.resolve(true),cancel:noop})});
  (0,eval)(source);
  (0,eval)(resizeSource);
  // The visual body is always the real dashboard renderer. This test exercises
  // main-tab navigation state, not the unrelated tab-specific data pipelines.
  window.renderActiveTab=()=>renderDashboardTab();
  window.setScene=async(family,mode,theme=mode)=>{settings.theme=theme;settings.appearance=preferences.updateAppearancePreferences(settings,{family,mode,source:'manual'});activeTab='dashboard';renderModal();await appearanceSession.sync();};
  window.geometry=()=>{const bar=document.querySelector('.sd-tabs'),shell=bar.parentElement,b=bar.getBoundingClientRect(),s=shell.getBoundingClientRect(),first=bar.firstElementChild.getBoundingClientRect(),last=bar.lastElementChild.getBoundingClientRect();return{left:b.left-s.left,right:s.right-b.right,first:first.left-s.left,last:s.right-last.right,x:bar.scrollLeft,max:Math.max(0,bar.scrollWidth-bar.clientWidth),leftFade:bar.classList.contains('sd-tabs-fade-left'),rightFade:bar.classList.contains('sd-tabs-fade-right')};};
  window.hostStyle=()=>{const node=document.querySelector('#host-probe'),s=getComputedStyle(node),before=getComputedStyle(node,'::before');return JSON.stringify([s.color,s.backgroundColor,s.margin,s.borderRadius,before.content,before.maskImage]);};
  window.hostBefore=hostStyle();window.scrollTo(0,200);
 },{source,resizeSource});
 const families=[['classic','light'],['classic','dark'],['classic','light','kraft'],['classic','light','candy'],['editorial','light'],['editorial','dark'],['glass','light'],['glass','dark']];
 const signatures=new Map();
 for(const [family,mode,theme=mode] of families)for(const width of[320,393,1280]){
  const label=`${family}/${mode}/${theme}/${width}`;
  await page.setViewportSize({width,height:900});await page.evaluate(async({family,mode,theme})=>setScene(family,mode,theme),{family,mode,theme});
  ok(label+' actual header/dashboard and eight tab buttons render',await page.locator('.sd-header-actions .qm-glyph-icon').count()>=4&&await page.locator('.sd-hero').count()===1&&await page.locator('.sd-tabs .sd-tab').count()===8);
  const sequence=await page.evaluate(()=>{const bar=document.querySelector('.sd-tabs'),body=document.querySelector('.sd-body'),win=document.querySelector('.sd-window');body.scrollTop=73;const old={page:scrollY,body:body.scrollTop,window:win.getBoundingClientRect().top};bar.scrollLeft=0;updateTabsFade(bar);const start=geometry();keepQianmuTabVisible(bar,bar.lastElementChild);updateTabsFade(bar);const end=geometry();bar.scrollLeft=1e9;updateTabsFade(bar);const physicalEnd=geometry();keepQianmuTabVisible(bar,bar.firstElementChild);updateTabsFade(bar);const back=geometry();bar.scrollLeft=(bar.scrollWidth-bar.clientWidth)/2;updateTabsFade(bar);const mid=geometry();return{start,end,physicalEnd,back,mid,stable:scrollY===old.page&&body.scrollTop===old.body&&win.getBoundingClientRect().top===old.window};});
  ok(label+' compact fixed gutters at start, middle and both endpoints',Object.values(sequence).filter(v=>typeof v==='object').every(g=>Math.abs(g.left-8)<=.5&&Math.abs(g.right-8)<=.5));
  ok(label+' revealing a tab never moves document, modal or body',sequence.stable);
  if(sequence.start.max>2){
   ok(label+' first and last endpoints keep equal outer distance',Math.abs(sequence.start.first-sequence.end.last)<=.5&&Math.abs(sequence.start.first-sequence.physicalEnd.last)<=.5&&Math.abs(sequence.back.first-8)<=.5);
   ok(label+' directional fades match overflow and endpoint',!sequence.start.leftFade&&sequence.start.rightFade&&sequence.end.leftFade&&!sequence.end.rightFade&&!sequence.back.leftFade&&sequence.mid.leftFade&&sequence.mid.rightFade,sequence);
  }else ok(label+' wide tab group centers equally without fades',Math.abs(sequence.start.first-sequence.start.last)<=.5&&!sequence.start.leftFade&&!sequence.start.rightFade);
  const unchanged=await page.evaluate(async()=>{const bar=document.querySelector('.sd-tabs'),tabs=[...bar.children],b=bar.getBoundingClientRect(),tab=tabs.find(t=>{const r=t.getBoundingClientRect();return r.left>=b.left&&r.right<=b.right;});activeTab=tab.dataset.tab;const x=bar.scrollLeft;renderModal();await Promise.all(document.querySelector('.sd-tabs').getAnimations({subtree:true}).map(animation=>animation.finished));return Math.abs(document.querySelector('.sd-tabs').scrollLeft-x)<=.5;});
  ok(label+' rerender preserves middle scroll when active item is already visible',unchanged);
  const visual=await page.evaluate(()=>{const active=document.querySelector('.sd-tabs .sd-tab.active'),before=getComputedStyle(active,'::before'),after=getComputedStyle(active,'::after'),inactive=getComputedStyle(document.querySelector('.sd-tabs .sd-tab:not(.active)'),'::before');return{mask:before.maskImage,height:before.height,opacity:before.opacity,after:after.display,off:inactive.opacity,host:hostStyle()===hostBefore,stroke:[...document.querySelectorAll('.sd-header-actions .qm-glyph-icon svg')].map(n=>n.getAttribute('stroke-width')||getComputedStyle(n).strokeWidth)};});
  ok(label+' active contour is present, inactive contour hidden and host untouched',visual.mask.includes('data:image/svg+xml')&&visual.opacity==='1'&&visual.off==='0'&&visual.host);
  ok(label+' header uses local 2.25px icons',visual.stroke.length>=4&&visual.stroke.every(s=>s==='2.25'||s==='2.25px'));
  ok(label+' rail fades from transparent without a hard upper divider',await page.locator('.sd-tabs-shell').evaluate(node=>getComputedStyle(node).backgroundImage.includes('linear-gradient')&&getComputedStyle(node).borderTopWidth==='0px'&&getComputedStyle(document.querySelector('.sd-header')).borderBottomWidth==='0px'));
  if(sequence.start.max>2)ok(label+' each end fits whole equally spaced slots and text gutters match',await page.evaluate(()=>{const bar=document.querySelector('.sd-tabs'),measure=end=>{bar.scrollLeft=end?1e9:0;const bounds=bar.getBoundingClientRect(),visible=[...bar.children].filter(node=>{const b=node.getBoundingClientRect();return b.left>=bounds.left-.6&&b.right<=bounds.right+.6;});const a=visible[0].querySelector('span').getBoundingClientRect(),b=visible.at(-1).querySelector('span').getBoundingClientRect();return Math.abs((a.left-bounds.left)-(bounds.right-b.right))<.6;};return measure(false)&&measure(true);}));
  if(width===393)signatures.set(family,JSON.stringify([visual.mask,visual.height,visual.after]));
 }
 ok('three families have three distinct contour masks',new Set(signatures.values()).size===3);
 // Actual wheel/mouse/keyboard input; no direct dispatch substitutes for drag.
 await page.setViewportSize({width:393,height:900});await page.evaluate(()=>setScene('classic','dark'));
 let box=await page.locator('.sd-tabs').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,100);await page.waitForTimeout(80);
 ok('vertical wheel scrolls only the inner strip',await page.evaluate(()=>document.querySelector('.sd-tabs').scrollLeft>0));
 const beforeDrag=await page.evaluate(()=>{document.querySelector('.sd-tabs').scrollLeft=0;return{active:activeTab,page:scrollY,body:document.querySelector('.sd-body').scrollTop};});
 box=await page.locator('.sd-tabs').boundingBox();await page.mouse.move(box.x+box.width-30,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+40,box.y+box.height/2,{steps:8});await page.mouse.up();await page.waitForTimeout(30);
 ok('mouse drag scrolls without activating a tab or moving parents',await page.evaluate(old=>document.querySelector('.sd-tabs').scrollLeft>50&&activeTab===old.active&&scrollY===old.page&&document.querySelector('.sd-body').scrollTop===old.body&&!document.querySelector('.sd-tabs-dragging'),beforeDrag));
 const partial=await page.evaluate(()=>{const bar=document.querySelector('.sd-tabs'),tab=bar.children[1];document.activeElement?.blur();bar.scrollLeft=0;bar.scrollLeft+=tab.getBoundingClientRect().left-bar.getBoundingClientRect().left+8;const b=bar.getBoundingClientRect();return{x:b.left+6,y:b.top+b.height/2,scroll:bar.scrollLeft,active:activeTab};});
 await page.mouse.move(partial.x,partial.y);await page.mouse.down();await page.mouse.move(partial.x+6,partial.y,{steps:2});await page.mouse.up();await page.waitForTimeout(30);
 const partialAfter=await page.evaluate(()=>({x:document.querySelector('.sd-tabs').scrollLeft,active:activeTab}));
 ok('small drag from a partially visible tab does not jump from focus reveal',Math.abs(partialAfter.x-(partial.scroll-6))<=1&&partialAfter.active===partial.active,{partial,partialAfter});
 await page.evaluate(()=>{const bar=document.querySelector('.sd-tabs');bar.scrollLeft=0;bar.firstElementChild.focus({preventScroll:true});});
 const keyBefore=await page.evaluate(()=>({page:scrollY,body:document.querySelector('.sd-body').scrollTop}));
 for(let i=0;i<7;i++)await page.keyboard.press('Tab');
 ok('keyboard focus reveals the last tab without changing document/body scroll',await page.evaluate(old=>{const bar=document.querySelector('.sd-tabs'),item=document.activeElement.getBoundingClientRect(),b=bar.getBoundingClientRect();return document.activeElement.dataset.tab==='focus'&&item.right<=b.right+.5&&item.left>=b.left-.5&&scrollY===old.page&&document.querySelector('.sd-body').scrollTop===old.body;},keyBefore));
 await page.keyboard.press('Enter');ok('keyboard activation retains the real tab click binding',await page.evaluate(()=>activeTab==='focus'&&document.querySelector('.sd-tabs .sd-tab.active').dataset.tab==='focus'));
 // Unrelated host themes commonly set button/nav margin globally. Explicitly
 // stress only geometry here, then remove the fixture before screenshots.
 const stress=await page.addStyleTag({content:'button{margin:2px 9px 3px 5px!important;box-sizing:content-box!important}nav{margin:2px 7px 0 3px!important}'});
 const stressed=await page.evaluate(()=>{const bar=document.querySelector('.sd-tabs');bar.scrollLeft=0;const first=geometry();bar.scrollLeft=1e9;const end=geometry();return{first,end,box:getComputedStyle(bar.firstElementChild).boxSizing};});
 ok('host nav/button margin and sizing cannot skew gutters',Math.abs(stressed.first.left-8)<=.5&&Math.abs(stressed.end.right-8)<=.5&&Math.abs(stressed.first.first-stressed.end.last)<=.5&&stressed.box==='border-box');await stress.evaluate(node=>node.remove());
 await page.setViewportSize({width:1280,height:900});await page.waitForTimeout(80);ok('production resize wide removes stale fade hints',await page.evaluate(()=>{const g=geometry();return g.max===0&&!g.leftFade&&!g.rightFade;}));
 await page.setViewportSize({width:320,height:900});await page.waitForTimeout(80);ok('production resize narrow restores endpoint hint and active visibility',await page.evaluate(()=>{const g=geometry(),bar=document.querySelector('.sd-tabs'),r=bar.querySelector('.active').getBoundingClientRect(),b=bar.getBoundingClientRect();return g.max>0&&g.leftFade&&!g.rightFade&&r.left>=b.left-.5&&r.right<=b.right+.5;}));
 await page.evaluate(()=>{activeTab='tts';renderModal();});ok('real tab change starts a short contour-only transition',await page.locator('.sd-tabs').evaluate(node=>node.getAnimations({subtree:true}).some(animation=>animation.effect.pseudoElement==='::before'&&animation.effect.getComputedTiming().duration===260)));
 await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>{activeTab='focus';renderModal();});ok('reduced motion skips moving tab contours',await page.locator('.sd-tabs').evaluate(node=>node.getAnimations({subtree:true}).every(animation=>animation.effect.getComputedTiming().duration!==260)));await page.emulateMedia({reducedMotion:'no-preference'});
 for(const [family,mode] of[['classic','dark'],['editorial','light'],['glass','light'],['glass','dark']]){
  await page.setViewportSize({width:393,height:900});await page.evaluate(async({family,mode})=>{await setScene(family,mode);await Promise.all(document.querySelector('.sd-tabs').getAnimations({subtree:true}).map(animation=>animation.finished));document.querySelector('.sd-body').scrollTop=0;document.activeElement?.blur();},{family,mode});
  const path=fileURLToPath(new URL(`${family}${family==='glass'&&mode==='dark'?'-dark':''}-393.png`,qa));const windowBox=await page.locator('.sd-window').boundingBox();await page.screenshot({path,clip:{x:windowBox.x,y:windowBox.y,width:windowBox.width,height:Math.min(600,windowBox.height)},caret:'hide'});screenshots.push(path);
  if(family==='glass'&&mode==='dark')ok('glass night active ink and curve use the exact theme accent',await page.locator('.sd-tabs .sd-tab.active').evaluate(node=>{const cv=document.createElement('canvas'),ctx=cv.getContext('2d'),style=getComputedStyle(node),color=value=>{ctx.fillStyle=value;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].join(',');};return color(style.color)===color(style.getPropertyValue('--qm-accent'))&&color(getComputedStyle(node,'::before').backgroundColor)===color(style.getPropertyValue('--qm-accent'));}));
 }
 await page.evaluate(()=>{window.removeEventListener('resize',resizeHandler);appearanceSession.reset();});assert.deepEqual(errors,[]);assert.equal(external,0);
 console.log(JSON.stringify({passed:checks.length,checks,errors,external,screenshots,scope:'actual renderModal header, dashboard body, main tabs and appearance session; synthetic story data, inert host bindings, no production operations'}));
}finally{clearTimeout(deadline);await context.close();await browser.close();}
