// Real templates, wrapper functions, event branches and CSS. No real books, storage or imports.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {coreadCenterFunctions,coreadRecordsFunctions,coreadApiFunctions,coreadInjectFunctions} from '../tests/helpers/coread-center-fixture.mjs';
import {uniqueClean} from '../qianmu-storyboard-utils.js';
import {storyboardFunctionSource} from '../tests/helpers/storyboard-form-fixture.mjs';
import {normalizeCoreadSource} from '../qianmu-reader.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
const css=await readFile(new URL('../style.css',import.meta.url),'utf8');
const view=await readFile(new URL('../qianmu-reader-center-view.js',import.meta.url),'utf8');
const icons=await readFile(new URL('../qianmu-icon-renderer.js',import.meta.url),'utf8');
function between(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,`Missing event branch: ${start}`);return source.slice(a,b);}
const click=between("    if (e.target.closest('.sd-reader-tour-skip'))", "    if (e.target.closest('.sd-reader-guide-replay'))");
const fileChange=between("    const packInput = e.target.closest('.sd-reader-pack-import-input');",'    const m = coreadMemory();');
const guardChange=between("    if (e.target.closest('.sd-reader-spoiler-filter'))",'\n');
const recordClick=between("    if (e.target.closest('.sd-reader-distillprompt-save'))", "    if (e.target.closest('.sd-reader-sumitem-export'))");
const archiveClick=between("    if (e.target.closest('.sd-reader-slice-clear'))",'    // 词典册：新建词册');
const syncChange=between("    if (e.target.closest('.sd-reader-storagemode'))",'\n');
await mkdir(new URL('../dist/local-qa/',import.meta.url),{recursive:true});
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext({hasTouch:true}),errors=[];let external=0;
await context.route('**/*',route=>{external++;return route.abort();});
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
try{
  await page.setContent(`<style>${css}</style><style>body{margin:0;background:#222}#tour-frame{position:relative;height:320px}</style><div id="story-director-modal" class="sd-theme-dark" hidden></div><div id="sd-reader-portal" class="sd-reader-portal"><div class="sd-reader-stage"><div class="sd-reader-morepage"><div class="sd-reader-morepage-body" id="center"></div></div></div></div>`);
  await page.evaluate(async({view,icons,functions,click,fileChange,guardChange})=>{
    Object.assign(window,await import('data:text/javascript,'+encodeURIComponent(view)));
    Object.assign(window,await import('data:text/javascript,'+encodeURIComponent(icons)));
    const theme=getComputedStyle(document.getElementById('story-director-modal')),portal=document.getElementById('sd-reader-portal');
    for(const key of theme)if(key.startsWith('--sd-'))portal.style.setProperty(key,theme.getPropertyValue(key));
    window.COREAD_MEMORY_ENABLED=true;window.coreadGuideStep=null;
    window.readerDialog={bookId:'book',readBoundary:{progress:12.5},slices:[{id:1},{id:2},{id:3}]};
    window.coreadBookMeta=()=>({title:'长书名<& 用于检查窄屏显示与文本转义'.repeat(4),progress:80});
    window.coreadCurrentReadBoundarySync=()=>{throw Error('Explicit boundary must win');};
    window.coreadSafeSlices=rows=>rows.slice(0,1);
    window.htmlEscape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
    window.memory={spoilerProtection:true};window.coreadMemory=()=>memory;
    window.calls={save:0,invalidate:0,prepare:0,imports:[]};
    window.saveSettings=()=>calls.save++;window.coreadInvalidatePool=()=>calls.invalidate++;
    window.prepareCompanionSetup=()=>calls.prepare++;
    window.coreadImportDataFile=file=>calls.imports.push({name:file?.name,cleared:document.querySelector('.sd-reader-pack-import-input').value===''});
    window.eval(functions);
    window.rerenderMore=()=>{document.getElementById('center').innerHTML=renderCoreadCenterStatus(memory)+`<div class="sd-reader-setup-body sd-reader-center-setup">${renderCoreadSpoilerGuard(memory)}${renderCoreadPackBar()}</div><div id="tour-frame">${renderCoreadGuide()}</div>`;applyQianmuIcons(portal);};
    const root=document.getElementById('center');
    root.addEventListener('click',new Function('e',click));
    root.addEventListener('change',new Function('e',fileChange+'\nconst m=coreadMemory();\n'+guardChange));
    rerenderMore();
  },{view,icons,functions:coreadCenterFunctions,click,fileChange,guardChange});
  const layouts=[];
  for(const width of [320,360,430,1100]){
    await page.setViewportSize({width,height:850});
    await page.evaluate(()=>{coreadGuideStep=null;memory.spoilerProtection=true;calls.save=0;calls.invalidate=0;calls.imports=[];rerenderMore();});
    assert.match(await page.locator('.sd-reader-center-book-copy small').textContent(),/12.5%.*3 条记忆.*2 条进度外隔离/);
    assert.equal(await page.locator('.sd-reader-center-book-copy b').count(),1);
    await page.locator('.sd-reader-setup-guard').tap();
    assert.deepEqual(await page.evaluate(()=>[memory.spoilerProtection,calls.save,calls.invalidate]),[false,1,1]);
    await page.locator('.sd-reader-setup-guard').tap();
    assert.equal(await page.locator('.sd-reader-spoiler-filter').isChecked(),true);
    const input=page.locator('.sd-reader-pack-import-input');
    const hit=await input.evaluate(n=>{const r=n.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===n;});
    assert.equal(hit,true,'native input itself must receive the import tap');
    await input.setInputFiles({name:'fixture.json',mimeType:'application/json',buffer:Buffer.from('{}')});
    assert.deepEqual(await page.evaluate(()=>calls.imports),[{name:'fixture.json',cleared:true}]);
    await page.evaluate(()=>{coreadGuideStep=0;rerenderMore();});
    assert.equal(await page.locator('.sd-reader-tour-prev').isDisabled(),true);
    await page.locator('.sd-reader-tour-next').tap();assert.equal(await page.evaluate(()=>coreadGuideStep),1);
    await page.locator('.sd-reader-tour-prev').tap();assert.equal(await page.evaluate(()=>coreadGuideStep),0);
    await page.evaluate(()=>{coreadGuideStep=coreadGuideSteps().length-1;rerenderMore();});
    assert.equal(await page.locator('.sd-reader-tour-next').getAttribute('title'),'完成');
    const boxes=await page.locator('.sd-reader-center-book,.sd-reader-setup-guard,.sd-reader-packbar,.sd-reader-tour').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,right:r.right,width:r.width,overflow:n.scrollWidth-n.clientWidth};}));
    for(const box of boxes)assert.ok(box.x>=0&&box.right<=width+1&&box.width>0&&box.overflow<=1,JSON.stringify({width,box}));
    await page.screenshot({path:fileURLToPath(new URL(`../dist/local-qa/coread-center-${width}.png`,import.meta.url)),fullPage:true});
    await page.locator('.sd-reader-tour-next').tap();assert.deepEqual(await page.evaluate(()=>[coreadGuideStep,memory.guideSeen,memory.moreTab]),[null,true,'setup']);
    assert.equal(await page.locator('.sd-reader-tour').count(),0);
    await page.evaluate(()=>{coreadGuideStep=0;memory.guideSeen=false;rerenderMore();});
    await page.locator('.sd-reader-tour-skip').tap();assert.deepEqual(await page.evaluate(()=>[coreadGuideStep,memory.guideSeen]),[null,true]);
    layouts.push({width,boxes,nativeInputHit:hit});
  }
  await page.evaluate(({functions,normalize,handler})=>{
    coreadGuideStep=null;window.reader={normalizeCoreadSource:window.eval('('+normalize+')')};
    window.getChatStore=()=>({coreadBound:[]});window.coreadWorldSyncBusy=false;
    window.DEFAULT_DISTILL_TEXT_PROMPT='fixture';window.DEFAULT_MAINLINE_SUMMARY_PROMPT='fixture';
    window.toast=()=>{};readerDialog.messages=[];readerDialog.cursor=0;
    window.eval(functions);
    window.rerenderMore=()=>{const root=document.getElementById('center');root.innerHTML=`<div class="sd-reader-mtab-body">${renderMemRecordsTab(memory)}</div>`;root.querySelectorAll('details').forEach(n=>n.open=true);applyQianmuIcons(document.getElementById('sd-reader-portal'));};
    window.resetRecords=()=>{memory={worldSyncMode:'none',summaryItems:[{id:'fixed',title:'内置条目',text:'fixed',order:1,builtin:true},{id:'custom',title:'自定义<&',text:'custom',order:2}]};calls.save=0;rerenderMore();};
    document.getElementById('center').addEventListener('click',new Function('e','const m=coreadMemory(),morePage=document.getElementById("center");'+handler));
    resetRecords();
  },{functions:coreadRecordsFunctions,normalize:normalizeCoreadSource.toString(),handler:recordClick});
  const recordActions=[];
  for(const width of [320,360,430,1100])for(const action of ['click','tap','keyboard']){
    await page.setViewportSize({width,height:850});await page.evaluate(()=>resetRecords());
    const activate=async selector=>{const n=page.locator(selector);if(action==='keyboard'){await n.focus();await n.press('Enter');}else await n[action]();};
    assert.equal(await page.locator('.sd-reader-sumitem-del[data-id="fixed"]').count(),0);
    await activate('.sd-reader-sumitem-up[data-id="custom"]');
    assert.deepEqual(await page.evaluate(()=>[memory.summaryItems.find(x=>x.id==='custom').order,calls.save]),[1,1]);
    await activate('.sd-reader-sumitem-down[data-id="custom"]');
    assert.deepEqual(await page.evaluate(()=>[memory.summaryItems.find(x=>x.id==='custom').order,calls.save]),[2,2]);
    for(const [selector,key,value]of [['distillprompt','distillTextPrompt','new distill'],['mainlineprompt','mainlineSummaryPrompt','new mainline']]){
      await page.locator(`.sd-reader-${selector}-text`).fill('  '+value+'  ');
      const saves=await page.evaluate(()=>calls.save);await activate(`.sd-reader-${selector}-save`);
      assert.equal(await page.evaluate(key=>memory[key],key),value);assert.equal(await page.evaluate(()=>calls.save),saves+1);
      assert.equal(await page.locator(`.sd-reader-${selector}-save`).evaluate(n=>n.closest('details').open),true);
    }
    const idle=await page.evaluate(()=>calls.save);
    await page.locator('.sd-reader-sumitem[data-id="custom"] .sd-reader-promptblock-acts').evaluate(n=>n.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})));
    assert.equal(await page.locator('.sd-reader-sumitem[data-id="custom"]').evaluate(n=>n.open),true);
    assert.equal(await page.evaluate(()=>calls.save),idle);
    await activate('.sd-reader-sumitem-del[data-id="custom"]');
    assert.deepEqual(await page.evaluate(()=>memory.summaryItems.map(x=>x.id)),['fixed']);assert.equal(await page.evaluate(()=>calls.save),idle+1);
    recordActions.push({width,action,once:true});
  }
  await page.evaluate(({archiveClick,syncChange})=>{
    window.confirmAnswer=false;
    window.coreadSetWorldSyncMode=mode=>calls.modes.push(mode);
    window.coreadOpenSliceManagerDialog=()=>calls.managers.push('slices');
    window.coreadOpenArchivePage=()=>calls.managers.push('archives');
    window.confirmDialog=async(title,message)=>{calls.confirmations.push({title,message});return confirmAnswer;};
    window.coreadClearAllSlices=async()=>{calls.clears++;};
    const root=document.getElementById('center');
    root.addEventListener('click',new Function('e',archiveClick));
    root.addEventListener('change',new Function('e',syncChange));
  },{archiveClick,syncChange});
  const recordLayouts=[];
  for(const width of [320,360,430,1100]){
    await page.setViewportSize({width,height:850});
    await page.evaluate(()=>{coreadWorldSyncBusy=false;readerDialog.slices=[{id:1},{id:2}];confirmAnswer=false;Object.assign(calls,{modes:[],managers:[],confirmations:[],clears:0});resetRecords();});
    const boxes=await page.locator('.sd-reader-memory-overview,.sd-reader-storagemode,.sd-reader-sumitem').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {kind:n.className,x:r.x,right:r.right,width:r.width,overflow:n.scrollWidth-n.clientWidth};}));
    for(const box of boxes)assert.ok(box.x>=0&&box.right<=width+1&&box.width>0&&box.overflow<=1,JSON.stringify({width,box}));
    for(const mode of ['shared','dedicated','none'])await page.locator('.sd-reader-storagemode').selectOption(mode);
    assert.deepEqual(await page.evaluate(()=>calls.modes),['shared','dedicated','none']);
    await page.evaluate(()=>{coreadWorldSyncBusy=true;rerenderMore();});
    assert.equal(await page.locator('.sd-reader-storagemode').isDisabled(),true);
    await page.evaluate(()=>{coreadWorldSyncBusy=false;rerenderMore();});
    await page.locator('.sd-reader-slice-manage').tap();await page.locator('.sd-reader-arch-manage').tap();
    assert.deepEqual(await page.evaluate(()=>calls.managers),['slices','archives']);
    await page.locator('.sd-reader-slice-clear').tap();
    assert.deepEqual(await page.evaluate(()=>[calls.confirmations.length,calls.clears]),[1,0]);
    assert.match(await page.evaluate(()=>calls.confirmations[0].message),/本聊天里这本书.*不可恢复/);
    await page.evaluate(()=>{confirmAnswer=true;});await page.locator('.sd-reader-slice-clear').tap();
    await page.waitForFunction(()=>calls.clears===1);
    assert.equal(await page.evaluate(()=>calls.confirmations.length),2);
    await page.locator('.sd-reader-memory-overview').scrollIntoViewIfNeeded();
    await page.screenshot({path:fileURLToPath(new URL(`../dist/local-qa/coread-records-${width}.png`,import.meta.url)),fullPage:true});
    await page.evaluate(()=>{readerDialog.slices=[];rerenderMore();});
    assert.equal(await page.locator('.sd-reader-slice-clear').isDisabled(),true);
    assert.equal(await page.locator('.sd-reader-slice-manage').isEnabled(),true);
    recordLayouts.push({width,boxes,confirmationBeforeClear:true,busyDisabled:true});
  }
  assert.deepEqual(errors,[]);assert.equal(external,0);
  await page.evaluate(({functions,apiClick,apiChange,switchChange})=>{
    window.coreadCenterPage='';window.ctx=()=>({});window.settings={apiProfiles:[]};
    window.coreadAssistantConfig=()=>({});window.coreadComicConfig=()=>({pagesPerBatch:3});
    window.coreadSetPipelineStatus=(...args)=>calls.pipeline.push(args);
    window.coreadEnsureVectors=async()=>{calls.vectors++;return {vecs:{fixture:[]}};};
    window.coreadPipelineFailed=()=>{throw Error('Unexpected fixture vector failure');};
    window.coreadTestMemConn=(kind,button)=>calls.api.push(['test',kind,button.dataset.kind]);
    window.coreadFetchMemModels=(kind,button)=>calls.api.push(['fetch',kind,button.dataset.kind]);
    window.coreadSaveMemProfile=kind=>calls.api.push(['save',kind]);
    window.coreadLoadMemProfile=(kind,id)=>{calls.api.push(['load',kind,id]);rerenderMore();};
    window.coreadDeleteMemProfile=(kind,id)=>calls.api.push(['delete',kind,id]);
    window.toast=(message,kind)=>calls.notices.push([message,kind]);
    window.eval(functions);
    window.rerenderMore=()=>{document.getElementById('center').innerHTML=renderCompanionMoreBody();applyQianmuIcons(document.getElementById('sd-reader-portal'));};
    window.resetApi=()=>{
      memory={guideSeen:true,moreTab:'api',summaryTemperature:0,summaryMaxTokens:0,summaryContextChars:0};coreadGuideStep=null;readerDialog.slices=[{id:'fixture'}];
      Object.assign(calls,{api:[],pipeline:[],vectors:0,notices:[],save:0});
      for(const kind of ['summary','vector','rerank'])Object.assign(memory,{[kind+'Models']:['listed'],[kind+'Model']:'missing-'+kind,[kind+'Profiles']:[{id:'profile-'+kind,name:'预设<&'}],[kind+'ProfileSel']:'profile-'+kind,[kind+'ApiKey']:'synthetic-only-'+kind});
      rerenderMore();
    };
    const root=document.getElementById('center');
    root.addEventListener('click',new Function('e','const morePage=document.getElementById("center");'+apiClick));
    root.addEventListener('change',new Function('e','const m=coreadMemory();'+apiChange+switchChange));
    resetApi();
  },{functions:coreadApiFunctions+'\n'+storyboardFunctionSource('renderCompanionMoreBody'),
    apiClick:between("    const testBtn = e.target.closest('.sd-reader-mem-test');",'    // ── 记忆记录 tab'),
    apiChange:between("    const modelPick = e.target.closest('.sd-reader-mem-modelpick');","  });\n  morePage?.addEventListener('input'"),
    switchChange:between("    if (e.target.closest('.sd-reader-sum-stream'))",'\n')+between("    if (e.target.closest('.sd-reader-vector-en'))","    if (e.target.closest('.sd-reader-autodistill-en'))")});
  const apiLayouts=[];
  for(const width of [320,360,430,1100]){
    await page.setViewportSize({width,height:850});await page.evaluate(()=>resetApi());
    for(const kind of ['summary','vector','rerank']){
      const pick=page.locator(`.sd-reader-mem-modelpick[data-kind="${kind}"]`),profile=page.locator(`.sd-reader-mem-profile[data-kind="${kind}"]`);
      assert.equal(await pick.inputValue(),'missing-'+kind);
      await pick.selectOption('listed');assert.equal(await page.evaluate(k=>memory[k+'Model'],kind),'listed');
      await profile.selectOption('');await profile.selectOption('profile-'+kind);
      assert.equal(await profile.inputValue(),'profile-'+kind);
      for(const action of ['test','fetch','save'])await page.locator(`.sd-reader-mem-${action}[data-kind="${kind}"]`).tap();
      await page.locator(`.sd-reader-mem-profile-del[data-kind="${kind}"]`).tap();
      assert.deepEqual(await page.evaluate(k=>calls.api.filter(x=>x[1]===k),kind),[['load',kind,'profile-'+kind],['test',kind,kind],['fetch',kind,kind],['save',kind],['delete',kind,'profile-'+kind]]);
      assert.equal(await page.evaluate(k=>memory[k+'ProfileSel'],kind),'');
      assert.equal(await page.locator(`.sd-reader-${kind}-apikey`).inputValue(),'synthetic-only-'+kind);
    }
    for(const [selector,key]of [['sum-stream','summaryStream'],['vector-en','vectorEnabled'],['rerank-en','rerankEnabled']]){
      const toggle=page.locator(`.sd-reader-${selector}`).locator('..');
      await toggle.tap();assert.equal(await page.evaluate(k=>memory[k],key),true);
      if(key==='vectorEnabled')await page.waitForFunction(()=>calls.vectors===1);
      await toggle.tap();assert.equal(await page.evaluate(k=>memory[k],key),false);
    }
    assert.deepEqual(await page.evaluate(()=>calls.pipeline),[['vector','ok'],['rerank','ok']]);
    const boxes=await page.locator('.sd-reader-mem-modelpick,.sd-reader-mprofile,.sd-reader-mactions').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,right:r.right,width:r.width,overflow:n.scrollWidth-n.clientWidth};}));
    for(const box of boxes)assert.ok(box.x>=0&&box.right<=width+1&&box.width>0&&box.overflow<=1,JSON.stringify({width,box}));
    await page.locator('.sd-reader-mem-modelpick[data-kind="vector"]').scrollIntoViewIfNeeded();
    await page.screenshot({path:fileURLToPath(new URL(`../dist/local-qa/coread-api-${width}.png`,import.meta.url)),fullPage:true});
    apiLayouts.push({width,boxes,threeKindsRouted:true});
  }
  assert.deepEqual(errors,[]);assert.equal(external,0);
  await page.evaluate(({functions,unique,dictClick,injectChange,injectInput})=>{
    window.uniqueClean=window.eval('('+unique+')');window.COREAD_DEFAULT_DICT='default';window.coreadCurrentDictId='';
    window.coreadRecentSlices=()=>[];window.coreadRecallSlices=()=>[{slice:readerDialog.slices[0],hits:['关键词'],score:1.25}];
    window.coreadActiveDict=()=>({关键词:['同义词']});window.coreadBoundDicts=()=>store.coreadDictBound;
    window.getChatStore=()=>store;window.saveMetadata=()=>calls.metadata++;
    window.coreadPromptText=async(...args)=>{calls.prompts.push(args);return promptAnswer;};
    window.coreadOpenDictEntryDialog=async(...args)=>{if(args[3]?.tagName!=='BUTTON')throw Error('Dictionary editor must retain its originating button');calls.entries.push(args.slice(0,3));return false;};
    window.uid=()=> 'new-fixture';window.eval(functions);
    window.resetInject=()=>{
      memory={guideSeen:true,moreTab:'inject',recallScanMessages:2,recentInject:1,recallCount:3,rerankTopN:4,mainlineFeedback:false,mainlineRecall:0,mainlineRecent:0,mainlineDepth:0,
        dictBooks:[{id:'default',name:'默认词册',pairs:{}},{id:'custom"',name:'自定义<&',pairs:{'关键词<&':['同义词<&']}}]};
      window.store={coreadDictBound:[]};coreadCurrentDictId='custom"';window.promptAnswer=null;confirmAnswer=false;
      Object.assign(calls,{metadata:0,prompts:[],entries:[],confirmations:[],notices:[],save:0,invalidate:0});
      readerDialog.slices=[{id:'a',batch:1,summary:'实际注入的安全摘要。'.repeat(8),keywords:['关键词'],src:'book'}];
      readerDialog.lastInjected={channel:'companion',items:[{id:'a',hits:['关键词']}]};readerDialog.messages=[{text:'当前语境'.repeat(30)}];rerenderMore();
    };
    const root=document.getElementById('center');
    root.addEventListener('click',new Function('e','const m=coreadMemory();'+dictClick));
    root.addEventListener('change',new Function('e','const m=coreadMemory();'+injectChange));
    root.addEventListener('input',new Function('e','const m=coreadMemory();'+injectInput));
    resetInject();
  },{functions:coreadInjectFunctions,unique:uniqueClean.toString(),
    dictClick:between('    // 词典册：新建词册','    // 测试按钮：综合自检'),
    injectChange:between("    if (e.target.closest('.sd-reader-dict-booksel'))",'    // 总结提示词预设下拉')+between("    if (e.target.closest('.sd-reader-mainline-toggle'))",'\n'),
    injectInput:between("    if (e.target.closest('.sd-reader-inj-recall'))",'    const map = [')});
  const injectLayouts=[];
  for(const width of [320,360,430,1100]){
    await page.setViewportSize({width,height:850});await page.evaluate(()=>resetInject());
    assert.equal(await page.locator('.sd-reader-mainline-recall').isDisabled(),true);
    await page.locator('.sd-reader-mainline-toggle').locator('..').tap();assert.equal(await page.evaluate(()=>memory.mainlineFeedback),true);
    const fields=[['inj-recall','recallCount',-1,0],['inj-recent','recentInject',5,5],['inj-scan','recallScanMessages',99,50],['inj-reranktop','rerankTopN',-1,1],['mainline-recall','mainlineRecall',3,3],['mainline-recent','mainlineRecent',2,2],['mainline-depth','mainlineDepth',99,20]];
    for(const [sel,key,value,expected]of fields){
      const node=page.locator('.sd-reader-'+sel);await node.evaluate(n=>{window.originalNumericInput=n;});
      const saves=await page.evaluate(()=>calls.save);await node.fill(String(value));
      assert.equal(await page.evaluate(k=>memory[k],key),expected);assert.equal(await page.evaluate(()=>calls.save),saves+1);
      assert.equal(await node.evaluate(n=>n===originalNumericInput),true,'numeric typing must not replace the focused control');
    }
    await page.locator('.sd-reader-mainline-toggle').locator('..').tap();assert.equal(await page.locator('.sd-reader-mainline-depth').isDisabled(),true);
    await page.locator('.sd-reader-injrow').evaluate(n=>{n.closest('details').open=true;});
    const boxes=await page.locator('.sd-reader-injslice,.sd-reader-dict-selector,.sd-reader-dict-row,.sd-reader-injrow,.sd-reader-scanbox').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {kind:n.className,x:r.x,right:r.right,width:r.width,overflow:n.scrollWidth-n.clientWidth};}));
    for(const box of boxes)assert.ok(box.x>=0&&box.right<=width+1&&box.width>0&&box.overflow<=1,JSON.stringify({width,box}));
    await page.locator('.sd-reader-dict-selector').scrollIntoViewIfNeeded();await page.screenshot({path:fileURLToPath(new URL(`../dist/local-qa/coread-inject-${width}.png`,import.meta.url)),fullPage:true});
    await page.locator('.sd-reader-dict-booksel').selectOption('default');assert.equal(await page.locator('.sd-reader-dictbook-delbtn').count(),0);
    await page.locator('.sd-reader-dict-booksel').selectOption('custom"');
    await page.locator('.sd-reader-dictbook-bind').tap();assert.deepEqual(await page.evaluate(()=>store.coreadDictBound),['custom"']);
    await page.locator('.sd-reader-dictbook-bind').tap();assert.deepEqual(await page.evaluate(()=>store.coreadDictBound),[]);
    await page.locator('.sd-reader-dict-row-edit').tap();await page.locator('.sd-reader-dict-addentry').tap();
    assert.deepEqual(await page.evaluate(()=>calls.entries),[['custom"','关键词<&',['同义词<&']],['custom"','',[]]]);
    await page.locator('.sd-reader-dict-row-del').tap();assert.equal(await page.locator('.sd-reader-dict-row').count(),1);
    await page.evaluate(()=>{confirmAnswer=true;});await page.locator('.sd-reader-dict-row-del').tap();await page.waitForFunction(()=>!Object.keys(memory.dictBooks[1].pairs).length);
    await page.evaluate(()=>{promptAnswer='  重命名  ';});await page.locator('.sd-reader-dictbook-rename').tap();await page.waitForFunction(()=>memory.dictBooks[1].name==='重命名');
    await page.locator('.sd-reader-dictbook-bind').tap();await page.evaluate(()=>{confirmAnswer=false;});await page.locator('.sd-reader-dictbook-delbtn').tap();assert.equal(await page.evaluate(()=>memory.dictBooks.length),2);
    await page.evaluate(()=>{confirmAnswer=true;});await page.locator('.sd-reader-dictbook-delbtn').tap();await page.waitForFunction(()=>memory.dictBooks.length===1);
    assert.deepEqual(await page.evaluate(()=>[coreadCurrentDictId,store.coreadDictBound,calls.confirmations.length]),['default',[],4]);
    await page.evaluate(()=>{promptAnswer=null;});await page.locator('.sd-reader-dictbook-add').tap();assert.equal(await page.evaluate(()=>memory.dictBooks.length),1);
    await page.evaluate(()=>{promptAnswer=' 新词册 ';});await page.locator('.sd-reader-dictbook-add').tap();await page.waitForFunction(()=>coreadCurrentDictId==='new-fixture');
    assert.equal(await page.locator('.sd-reader-dict-booksel').inputValue(),'new-fixture');assert.equal(await page.evaluate(()=>memory.dictBooks[1].name),'新词册');
    injectLayouts.push({width,boxes,numericIdentityPreserved:true,syntheticDictionaryActions:true});
  }
  assert.deepEqual(errors,[]);assert.equal(external,0);
  console.log(JSON.stringify({layouts,recordActions,recordLayouts,apiLayouts,injectLayouts,realEventBranches:true,realTemplates:true,external,errors,limits:'isolated DOM; API/profile/vector/dictionary dialogs are fakes; no real credentials, data import/deletion/sync, host navigation, guide positioning, record expansion memory or physical iOS validation'}));
}finally{await context.close();await browser.close();}
