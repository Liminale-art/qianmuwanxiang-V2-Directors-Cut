// Actual read-only manager controllers and appearance session in an isolated host.
// No database writes, encoding, export, restore, removal or provider calls.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const checks=[],errors=[];let external=0;
const deadline=setTimeout(()=>{void browser.close();},120000);
const css=await readFile(new URL('../style.css',import.meta.url),'utf8')+'\n'+await readFile(new URL('../qianmu-theme-skins.css',import.meta.url),'utf8');
const qa=new URL('../dist/local-qa/vibe-managers/',import.meta.url);await mkdir(qa,{recursive:true});
try{
  const context=await browser.newContext(),page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin==='https://qianmu.test'&&url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important;box-sizing:border-box}#story-director-modal .sd-window{width:100%!important;height:100%!important;max-height:none!important;margin:0!important}</style><div id="story-director-modal" class="open sd-theme-dark sd-storyboard-mode"><section class="sd-window"><main class="sd-body sd-storyboard-body"><div class="sd-storyboard-root"><header class="sd-storyboard-titlebar">隔离 Vibe 管理验收</header><div class="sd-storyboard-scroll"><div class="sd-vibe-library-host" id="host"></div></div><nav class="sd-storyboard-nav"></nav></div></main></section></div>`});
    if(url.origin==='https://qianmu.test'&&/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname))return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url))});
    external++;return route.abort();
  });
  await page.goto('https://qianmu.test/');
  await page.evaluate(async()=>{
    const [{createVibeReviewController},{createVibeStorageController},{createVibePreservationController},{createQianmuAppearanceSession},settings,{applyQianmuIcons}]=await Promise.all([
      import('/qianmu-vibe-review.js'),import('/qianmu-vibe-storage.js'),import('/qianmu-vibe-preservation-view.js'),import('/qianmu-appearance-session.js'),import('/qianmu-appearance-settings.js'),import('/qianmu-icon-renderer.js')]);
    window.appearanceSettings={theme:'dark'};window.appearanceSession=createQianmuAppearanceSession({readSettings:()=>appearanceSettings,loadStyles:()=>({promise:Promise.resolve(true),cancel(){}})});
    appearanceSession.mount(document.getElementById('story-director-modal'));
    window.setAppearance=async(family,mode)=>{appearanceSettings.appearance=settings.updateAppearancePreferences(appearanceSettings,{family,mode});await appearanceSession.sync();};
    window.startManager=kind=>{
      window.controller?.dispose();window.host=document.getElementById('host');host.replaceChildren();document.querySelector('.sd-storyboard-scroll').scrollTop=0;
      window.reads=[];window.forbidden=[];window.closeCount=0;window.current=true;window.kind=kind;
      const read=(method,...args)=>new Promise((resolve,reject)=>reads.push({method,args,resolve,reject}));
      const actions=new Proxy({list:()=>read('list'),archivePage:after=>read('archivePage',after),reviewHistory:row=>read('reviewHistory',row),page:(section,after)=>read('page',section,after)},
        {get(target,key){if(key in target)return target[key];return ()=>{forbidden.push(key);throw Error('Not a read-only operation: '+key);};}});
      const options={actions,icons:applyQianmuIcons,isCurrent:()=>current,onClose:()=>{closeCount++;controller.dispose();host.textContent='已返回';}};
      options.createPreservation=async onClose=>createVibePreservationController({actions,icons:applyQianmuIcons,isCurrent:()=>current,onClose});
      controller=({review:createVibeReviewController,storage:createVibeStorageController,preservation:createVibePreservationController})[kind](options);controller.mount(host);
    };
    window.result=(count=45)=>{
      const ns='st-user:synthetic';
      if(kind==='review')return Array.from({length:count},(_,i)=>({namespace:ns,cacheKey:String(i).padStart(64,'0'),attemptId:'synthetic-'+i,status:i===0?'unknown':i===1?'rejected':'ready',updatedAt:1000+i,
        identity:{remoteModelId:'nai-diffusion-4-full',parameters:{information_extracted:.5}},pastReviews:[{attemptId:'previous',feeReview:{method:'local-user',at:1000}}],reviewArchive:i===0?{count:45}:undefined}));
      if(kind==='storage')return {namespace:ns,items:Array.from({length:count},(_,i)=>({id:String(i).padStart(64,'0'),name:'保留原始画面与编码 '+i,type:i%2?'encoding':'image',bytes:1024,previewBytes:128,variants:2,pending:i===0?1:0,receiptCount:1})),
        usage:{countLimit:1024,bytes:count*1024,previewBytes:count*128,limit:512*1048576},receiptBytes:400,receiptCount:3,pendingCount:1,metadata:{bytes:200},library:[]};
      return {rows:Array.from({length:Math.min(count,40)},(_,i)=>({key:JSON.stringify([ns,String(i).padStart(64,'0')]),readable:i!==0})),next:count>40?'page-2':'',missing:false};
    };
    window.finishRead=(index,count)=>{const entry=reads[index];let value=result(count);if(entry.method==='archivePage')value={rows:value,next:count>40?'archive-2':'',count};entry.resolve(value);};
  });
  const ok=(label,value)=>{assert.ok(value,label);checks.push(label);};
  const waitIdle=()=>page.waitForFunction(()=>!host.textContent.includes('正在读取…'));
  const controls={review:['.sd-vibe-review-refresh','.sd-vibe-review-close','.sd-vibe-review-rows article'],storage:['.sd-vibe-storage-refresh','.sd-vibe-storage-close','.sd-vibe-storage-list>label'],preservation:['.sd-preserve-refresh','.sd-preserve-close','.sd-vibe-review-rows article']};
  for(const [family,mode] of [['classic','dark'],['editorial','light'],['editorial','dark'],['glass','light'],['glass','dark']])for(const width of [320,393,1100])for(const kind of Object.keys(controls)){
    const label=`${family}/${mode}/${width}/${kind}`,[refresh,close,row]=controls[kind];
    await page.setViewportSize({width,height:width===320?568:898});await page.evaluate(([family,mode,kind])=>{return setAppearance(family,mode).then(()=>startManager(kind));},[family,mode,kind]);
    ok(label+' pending read is not an empty result',await page.locator('#host').textContent().then(text=>text.includes('正在读取…'))&&await page.locator('.sd-vibe-empty').count()===0&&await page.locator('#host>section').getAttribute('aria-busy')==='true');
    const pending=await page.evaluate(async({family,mode})=>{const node=host.firstElementChild,n=reads.length;await setAppearance('glass',mode==='light'?'dark':'light');await setAppearance(family,mode);return node===host.firstElementChild&&reads.length===n&&forbidden.length===0;},{family,mode});
    ok(label+' switching appearance during the first read neither remounts nor restarts it',pending);
    await page.evaluate(()=>reads[0].reject(Error('读取失败 <img src=x onerror=alert(1)>')));await page.waitForFunction(()=>host.textContent.includes('读取失败'));
    ok(label+' failure remains visible and escaped, not empty',await page.locator('#host img').count()===0&&await page.locator('.sd-vibe-empty').count()===0&&!await page.locator(refresh).isDisabled()&&await page.locator('#host>section').getAttribute('aria-busy')==='false');
    await page.locator(refresh).click();await page.evaluate(()=>finishRead(1,0));await waitIdle();
    ok(label+' confirmed empty has an explicit message',await page.locator('.sd-vibe-empty').count()===1);
    await page.locator(refresh).click();await page.evaluate(()=>finishRead(2,45));await waitIdle();
    ok(label+' read-only list renders one bounded page',await page.locator(row).count()===40&&await page.locator('.sd-vibe-empty').count()===0);
    if(kind==='storage')await page.locator('[data-vibe-storage-id]').nth(1).check();
    if(kind==='review')await page.locator('.sd-vibe-fee-history').first().evaluate(node=>{node.open=true;});
    const state=await page.evaluate(async({family,mode,refresh})=>{
      const scroller=document.querySelector('.sd-storyboard-scroll'),focus=host.querySelector(refresh);scroller.scrollTop=70;focus.focus({preventScroll:true});
      const top=scroller.scrollTop,nodes=[...host.querySelectorAll('*')],html=host.innerHTML,n=reads.length;
      await setAppearance(family==='glass'?'editorial':'glass',mode==='light'?'dark':'light');await setAppearance(family,mode);
      return {nodes:nodes.every(node=>node.isConnected)&&html===host.innerHTML,focus:document.activeElement===focus,scroll:Math.abs(scroller.scrollTop-top)<1,reads:reads.length===n,writes:forbidden.length===0};
    },{family,mode,refresh});
    ok(label+' theme changes keep live nodes, focus, scroll, selections and reads: '+JSON.stringify(state),Object.values(state).every(Boolean));
    ok(label+' controls and long records fit narrow and wide layouts',await page.locator('#host').evaluate(node=>node.scrollWidth<=node.clientWidth+1));
    if(family!=='classic'){
      const skin=await page.locator(row).first().evaluate(node=>{const style=getComputedStyle(node);return {radius:style.borderTopRightRadius,filter:style.backdropFilter};});
      ok(label+' record cards follow the chosen surface',skin.radius===(family==='glass'?'22px':'0px')&&(family!=='glass'||skin.filter.includes('blur')));
      if(kind==='review')ok(label+' unresolved and rejected fees keep distinct warning edges',await page.locator(row).first().evaluate(node=>getComputedStyle(node).borderLeftColor==='rgb(207, 156, 67)')&&await page.locator(row).nth(1).evaluate(node=>getComputedStyle(node).borderLeftColor==='rgb(207, 114, 114)'));
    }
    if(width===393&&((family==='glass'&&mode==='light'&&kind==='storage')||(family==='editorial'&&mode==='dark'&&kind==='review'))){await page.evaluate(()=>document.querySelector('.sd-storyboard-scroll').scrollTop=0);await page.screenshot({caret:'initial',path:fileURLToPath(new URL(`${family}-${mode}-${kind}-393.png`,qa))});}
    await page.locator(refresh).click();await page.evaluate(()=>reads[3].reject(Error('刷新未完成')));await page.waitForFunction(()=>host.textContent.includes('刷新未完成'));
    ok(label+' refresh failure preserves the previous verified records',await page.locator(row).count()===40&&await page.locator('.sd-vibe-empty').count()===0);
    await page.locator(refresh).click();await page.locator(close).click();await page.evaluate(()=>finishRead(4,1));
    const late=await page.evaluate(()=>({closeCount,text:host.textContent,forbidden}));
    ok(label+' late reads after close cannot replace the destination or write: '+JSON.stringify(late),late.closeCount===1&&late.text==='已返回'&&late.forbidden.length===0);
  }
  await page.evaluate(()=>setAppearance('glass','light'));await page.setViewportSize({width:393,height:898});
  await page.evaluate(()=>{startManager('review');finishRead(0,45);});await waitIdle();
  await page.locator('.sd-vibe-review-more').click();ok('review pagination reveals existing records without extra reads',await page.locator('[data-vibe-review-row]').count()===45&&await page.evaluate(()=>reads.length===1));
  await page.locator('.sd-vibe-review-details').click();await page.evaluate(()=>reads[1].resolve({receipt:result(1)[0],reviews:Array.from({length:45},(_,i)=>({attemptId:'history-'+i,feeReview:{method:'local-user',at:1000+i}}))}));
  await page.waitForSelector('.sd-vibe-history-next');await page.locator('.sd-vibe-history-next').click();ok('review history pages locally and preserves unknown fee wording',await page.locator('.sd-vibe-review-rows article').count()===5&&await page.locator('#host').textContent().then(text=>text.includes('原结果及费用未知'))&&await page.evaluate(()=>reads.length===2));
  await page.locator('.sd-vibe-history-close').click();await page.locator('.sd-vibe-review-history').click();await page.evaluate(()=>finishRead(2,45));await waitIdle();
  await page.locator('.sd-vibe-review-history-next').click();await page.evaluate(()=>finishRead(3,1));await waitIdle();
  ok('archive next page uses the returned cursor',await page.evaluate(()=>reads[3].method==='archivePage'&&reads[3].args[0]==='archive-2'));
  await page.locator('.sd-vibe-review-history-prev').click();await page.evaluate(()=>finishRead(4,45));await waitIdle();ok('archive previous page restores its cursor',await page.evaluate(()=>reads[4].args[0]===''));
  await page.evaluate(()=>{startManager('storage');finishRead(0,45);});await waitIdle();await page.locator('.sd-vibe-storage-select').click();
  ok('bulk selection excludes pending files',!await page.locator('[data-vibe-storage-id]').first().isChecked()&&await page.locator('.sd-vibe-storage-remove').textContent().then(text=>text.includes('44')));
  await page.locator('.sd-vibe-storage-more').click();ok('storage pagination keeps the explicit selection without reads',await page.locator('[data-vibe-storage-id]').count()===45&&await page.locator('[data-vibe-storage-id]').last().isChecked()&&await page.evaluate(()=>reads.length===1));
  await page.locator('[data-vibe-storage-id]').first().check();ok('selecting a pending file disables deletion',await page.locator('.sd-vibe-storage-remove').isDisabled());
  await page.evaluate(()=>{startManager('preservation');finishRead(0,45);});await waitIdle();
  ok('unowned preservation records cannot be exported',await page.locator('[data-preserve-row]').first().isDisabled());
  await page.locator('.sd-preserve-next').click();await page.evaluate(()=>finishRead(1,1));await waitIdle();ok('preservation next page reads the exact cursor',await page.evaluate(()=>reads[1].args[1]==='page-2'));
  await page.locator('.sd-preserve-section').selectOption('receipts');await page.evaluate(()=>reads[2].resolve({rows:[],next:'',missing:true}));await waitIdle();
  ok('new preservation partition starts at its first page without creating storage',await page.evaluate(()=>reads[2].args[0]==='receipts'&&reads[2].args[1]===''&&forbidden.length===0)&&await page.locator('#host').textContent().then(text=>text.includes('未创建或升级数据库'))&&await page.locator('.sd-preserve-prev').isDisabled());
  for(const kind of ['review','storage']){
    await page.evaluate(kind=>{startManager(kind);finishRead(0,45);},kind);await waitIdle();
    if(kind==='storage')await page.locator('[data-vibe-storage-id]').nth(1).check();
    await page.locator('.sd-vibe-preserve-open').click();await page.waitForSelector('.sd-vibe-preservation');
    await page.evaluate(()=>reads[1].resolve({rows:[],next:'',missing:false}));await waitIdle();
    ok(kind+' opens the real nested preservation controller read-only',await page.locator('.sd-vibe-empty').count()===1&&await page.evaluate(()=>reads[1].method==='page'&&forbidden.length===0));
    await page.locator('.sd-preserve-close').click();
    ok(kind+' returning from preservation restores prior records without reading them again',await page.locator(controls[kind][2]).count()===40&&await page.evaluate(()=>reads.length===2));
    if(kind==='storage')ok('storage explicit selection survives nested preservation',await page.locator('[data-vibe-storage-id]').nth(1).isChecked());
  }
  for(const kind of Object.keys(controls))for(const outcome of ['resolve','reject']){
    await page.evaluate(kind=>startManager(kind),kind);const before=await page.locator('#host').innerHTML();
    await page.evaluate(outcome=>{current=false;outcome==='resolve'?finishRead(0,1):reads[0].reject(Error('stale account'));},outcome);
    ok(`${kind}/${outcome} stale account leaves the inactive owner untouched`,await page.locator('#host').innerHTML()===before&&await page.evaluate(()=>forbidden.length===0));
  }
  for(const kind of Object.keys(controls)){
    await page.evaluate(kind=>startManager(kind),kind);await page.locator(controls[kind][1]).click();await page.evaluate(()=>reads[0].reject(Error('late closed failure')));
    ok(kind+' closed owner ignores late read failure',await page.evaluate(()=>host.textContent==='已返回'&&forbidden.length===0));
  }
  await page.evaluate(()=>{controller.dispose();appearanceSession.reset();});
  assert.deepEqual(errors,[]);assert.equal(external,0);console.log(JSON.stringify({passed:checks.length,checks,errors,external}));
}finally{clearTimeout(deadline);await browser.close();}
