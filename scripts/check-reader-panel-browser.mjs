// Real reading sidebar templates and delegated event branches; all book data/services are isolated fixtures.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {coreadPanelFunctions} from '../tests/helpers/coread-panel-fixture.mjs';
import {storyboardFunctionSource as section} from '../tests/helpers/storyboard-form-fixture.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const source=await readFile(new URL('../index.js',import.meta.url),'utf8'),css=await readFile(new URL('../style.css',import.meta.url),'utf8');
const view=await readFile(new URL('../qianmu-reader-panel-view.js',import.meta.url),'utf8'),icons=await readFile(new URL('../qianmu-icon-renderer.js',import.meta.url),'utf8');
const between=(a,b)=>{const start=source.indexOf(a),end=source.indexOf(b,start+a.length);assert.ok(start>=0&&end>start);return source.slice(start,end);};
const shell=between('      <!-- 目录 / 笔记 / 书签 抽屉','      <!-- 对话抽屉');
const events=between('  // 抽屉内 目录/笔记/书签 切页','  // 笔记编辑浮层：');
const functions=coreadPanelFunctions+'\n'+['coreadFindReaderNote','coreadNoteSource','coreadNotePlainText','coreadDeleteNote','updateReaderArticle'].map(section).join('\n');
await mkdir(new URL('../dist/local-qa/',import.meta.url),{recursive:true});
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext({hasTouch:true});
const errors=[];let external=0;await context.route('**/*',route=>{external++;return route.abort();});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
try{
  await page.setContent(`<style>${css}</style><style>body{margin:0;background:#222}</style><div id="story-director-modal" class="sd-theme-dark" hidden></div><div id="sd-reader-portal" class="sd-reader-portal"><div class="sd-reader-stage" data-reader-panel="toc"></div></div>`);
  await page.evaluate(async({view,icons,functions,shell,events})=>{
    Object.assign(window,await import('data:text/javascript,'+encodeURIComponent(view)),await import('data:text/javascript,'+encodeURIComponent(icons)));
    const theme=getComputedStyle(document.getElementById('story-director-modal')),portal=document.getElementById('sd-reader-portal');for(const key of theme)if(key.startsWith('--sd-'))portal.style.setProperty(key,theme.getPropertyValue(key));
    window.htmlEscape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
    window.coreadBookMeta=id=>id===readerView.bookId?panelMeta:null;window.saveSettings=()=>panelCalls.push(['save']);
    window.coreadSaveProgress=()=>panelCalls.push(['progress',readerView.chapterIndex,readerView.scrollRatio]);window.refreshReaderPortal=()=>panelCalls.push(['refresh']);
    window.exitNoteEdit=()=>{};window.loadInlineImages=()=>{};window.buildReaderParagraphs=text=>'<p>'+htmlEscape(text)+'</p>';
    window.coreadCopyText=text=>panelCalls.push(['copy',text]);window.coreadOpenExcerptDialog=id=>panelCalls.push(['image',id]);window.openReaderNoteDialog=id=>panelCalls.push(['edit',id]);
    window.eval(functions);window.renderPanelShell=new Function('meta','cache','ci','activePanel','listDrawerH','return `'+shell+'`');
    window.bindPanelEvents=new Function('stageRoot','const q=sel=>stageRoot.querySelector(sel);\n'+events);
    window.resetPanelFixture=()=>{
      window.panelCalls=[];window.readerView={bookId:'book',chapterIndex:0,scrollRatio:.42,noteSearch:'',noteFilter:'all'};
      window.panelMeta={title:'测试书',author:'作者',notes:[
        {id:'one',kind:'highlight',chapterIndex:0,text:'湖边 <img src=x> 湖边 '.repeat(15),annotation:'湖边想法',at:100,tags:['蓝色']},
        {id:'two',kind:'highlight',chapterIndex:1,text:'雨中的树',annotation:'',at:200,tags:['green']},
        {id:'mark',kind:'bookmark',chapterIndex:1,text:'第二章'}]};
      window.readerContentCache={chapters:[{title:'第一章',content:'原正文'},{title:'第二章',content:'后文'}]};
      window.readerDialog={messages:[{id:'voice',role:'friend',voiced:true,text:'已配音 <voice>',ts:1},{id:'unvoiced',role:'friend',text:'未生成语音'}]};
      const stage=document.querySelector('.sd-reader-stage');stage.dataset.readerPanel='toc';stage.innerHTML='<article class="sd-reader-article">原正文</article>'+renderPanelShell(panelMeta,readerContentCache,0,'toc',500);
      bindPanelEvents(stage);applyQianmuIcons(stage);
    };resetPanelFixture();
  },{view,icons,functions,shell,events});
  const layouts=[];
  for(const width of [320,360,430,1100]){
    await page.setViewportSize({width,height:898});await page.evaluate(()=>resetPanelFixture());
    await page.locator('[data-ptab="notes"]').tap();
    const input=page.locator('.sd-reader-notes-search input');await input.fill('蓝色');
    assert.equal(await page.locator('.sd-reader-ptab-notes .sd-reader-note-item:visible').count(),1);
    await input.evaluate(el=>window.searchInputBefore=el);await input.press('Backspace');
    assert.equal(await input.evaluate(el=>el===window.searchInputBefore&&document.activeElement===el),true);
    await input.fill('not-present');assert.equal(await page.locator('.sd-reader-notes-none').isVisible(),true);
    await input.fill('');await page.locator('.sd-reader-notes-filter').selectOption('excerpt');
    assert.equal(await page.locator('.sd-reader-ptab-notes .sd-reader-note-item:visible').count(),1);
    await page.locator('.sd-reader-notes-filter').selectOption('all');
    const row=page.locator('article[data-note="one"]');await row.locator('.sd-reader-note-tools-toggle').tap();
    assert.equal(await row.locator('.sd-reader-note-tools').isVisible(),true);
    const box=await row.locator('.sd-reader-note-tools').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1);
    await row.locator('.sd-reader-note-copy').tap();assert.ok((await page.evaluate(()=>panelCalls.find(x=>x[0]==='copy')[1])).includes('湖边想法'));
    await row.locator('.sd-reader-note-image').tap();await row.locator('.sd-reader-note-edit').tap();
    assert.deepEqual(await page.evaluate(()=>panelCalls.filter(x=>['image','edit'].includes(x[0]))),[['image','one'],['edit','one']]);
    await page.locator('.sd-reader-notes-search input').tap();assert.equal(await row.locator('.sd-reader-note-tools').isVisible(),false);
    await row.locator('.sd-reader-note-tools-toggle').click();await row.locator('.sd-reader-note-favorite').click();
    assert.equal(await page.locator('.sd-reader-ptab-notes article').first().getAttribute('data-note'),'one');
    assert.equal(await page.evaluate(()=>readerView.scrollRatio),.42);assert.equal(await page.evaluate(()=>panelCalls.filter(x=>x[0]==='save').length),1);
    await row.locator('.sd-reader-note-tools-toggle').focus();await row.locator('.sd-reader-note-tools-toggle').press('Enter');
    await row.locator('.sd-reader-note-del').click();assert.equal(await row.count(),0);
    assert.deepEqual(await page.evaluate(()=>panelMeta.notes.map(n=>n.id)),['two','mark']);
    await page.locator('[data-ptab="marks"]').tap();await page.locator('.sd-reader-ptab-marks .sd-reader-note-jump').tap();
    assert.deepEqual(await page.evaluate(()=>panelCalls.filter(x=>x[0]==='progress')),[['progress',1,0]]);
    await page.locator('.sd-reader-ptab-marks .sd-reader-note-del').tap();assert.equal(await page.locator('.sd-reader-ptab-marks .sd-reader-panel-empty').isVisible(),true);
    await page.locator('[data-ptab="notes"]').tap();
    const bounds=await page.locator('.sd-reader-notes-toolbar').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+1);
    assert.equal(await page.locator('.sd-reader-toc img').count(),0);
    await page.screenshot({path:fileURLToPath(new URL(`../dist/local-qa/reader-panel-${width}.png`,import.meta.url))});
    const voice=await page.evaluate(()=>{const html=renderReaderVoiceClips();readerDialog.messages=[];return {html,empty:renderReaderVoiceClips()};});
    assert.ok(voice.html.includes('&lt;voice&gt;'));assert.ok(!voice.html.includes('未生成语音'));assert.ok(voice.empty.includes('声音抽屉是空的'));
    layouts.push({width,toolbar:bounds,tools:box,searchFocus:true,delegatedActions:true,voiceScope:true});
  }
  assert.equal(external,0);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({layouts,realTemplates:true,realDelegatedEvents:true,external,errors,limits:'isolated book records; fake clipboard/image/editor/persistence/host navigation; no physical iOS, real audio playback or user-data deletion'}));
}finally{await context.close();await browser.close();}
