// Actual library controllers and DOM; read-only, manually delayed/failing services.
// No production DB, ST account, provider requests or browser session is used.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const checks=[],errors=[];let external=0;
const deadline=setTimeout(()=>{void browser.close();},120000);
const css=await readFile(new URL('../style.css',import.meta.url),'utf8')+'\n'+await readFile(new URL('../qianmu-theme-skins.css',import.meta.url),'utf8');
const qa=new URL('../dist/local-qa/library-loading/',import.meta.url);await mkdir(qa,{recursive:true});
try{
  const context=await browser.newContext(),page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin==='https://qianmu.test'&&url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important;box-sizing:border-box}#story-director-modal .sd-window{width:100%!important;height:100%!important;max-height:none!important;margin:0!important}</style><div id="story-director-modal" class="open sd-theme-dark sd-storyboard-mode"><section class="sd-window"><main class="sd-body sd-storyboard-body"><div class="sd-storyboard-root"><header class="sd-storyboard-titlebar">隔离资料库验收</header><div class="sd-storyboard-scroll"><div id="host"></div></div><nav class="sd-storyboard-nav"></nav></div></main></section></div>`});
    if(url.origin==='https://qianmu.test'&&/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname))return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url))});
    external++;return route.abort();
  });
  await page.goto('https://qianmu.test/');
  await page.evaluate(async()=>{
    const [{createComfyLibraryController},{createComfyPoolController},{createCharacterArchiveController},{createQianmuAppearanceSession},settings,{applyQianmuIcons}]=await Promise.all([
      import('/qianmu-comfy-library-view.js'),import('/qianmu-comfy-pool-view.js'),import('/qianmu-character-archive-view.js'),
      import('/qianmu-appearance-session.js'),import('/qianmu-appearance-settings.js'),import('/qianmu-icon-renderer.js')]);
    window.updatePreferences=settings.updateAppearancePreferences;
    window.appearanceSettings={theme:'dark'};
    window.appearanceSession=createQianmuAppearanceSession({readSettings:()=>appearanceSettings,loadStyles:()=>({promise:Promise.resolve(true),cancel(){}})});
    appearanceSession.mount(document.getElementById('story-director-modal'));
    window.setAppearance=async(family,mode)=>{appearanceSettings.appearance=updatePreferences(appearanceSettings,{family,mode});await appearanceSession.sync();};
    window.startLibrary=kind=>{
      window.controller?.dispose();window.host?.remove();
      window.host=document.createElement('div');host.id='host';document.querySelector('.sd-storyboard-scroll').replaceChildren(host);
      window.state={account:'st-user:first',visible:true},window.reads=[],window.operations={close:0,writes:0,apply:0,download:0,icons:0},window.notices=[];
      const noWrite=()=>{operations.writes++;throw Error('unexpected write');};
      let rowCount=0;
      const store={list:namespace=>new Promise((resolve,reject)=>reads.push({namespace,resolve:rows=>{rowCount=rows.length;resolve(rows);},reject})),
        usage:async namespace=>({namespace,count:rowCount,versions:rowCount,bytes:rowCount*10,limit:10000}),bindings:async()=>[],close:()=>operations.close++,
        save:noWrite,remove:noWrite,archive:noWrite,purge:noWrite,bind:noWrite};
      const common={store,resolveNamespace:async()=>state.account,isCurrent:()=>state.visible,
        onIcons:node=>{operations.icons++;applyQianmuIcons(node);},notify:message=>notices.push(message),
        onApply:()=>operations.apply++,onSelect:()=>operations.apply++,download:()=>operations.download++,confirm:async()=>false};
      window.controller=kind==='workflow'?createComfyLibraryController(common):kind==='pool'?createComfyPoolController(common):createCharacterArchiveController({...common,getContext:async()=>({chatKey:'synthetic-chat',subjects:[]})});
      window.row=name=>({id:'synthetic-'+name,revision:'r1',version:1,name,nodes:2,totalBytes:10,candidateCount:0,category:'char',aliases:[]});
      controller.mount(host);
    };
  });
  const ok=(name,value)=>{assert.ok(value,name);checks.push(name);};
  const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const waitRead=index=>page.waitForFunction(index=>reads.length>index,index);
  const action=kind=>`[data-${kind==='workflow'?'comfy':kind==='pool'?'pool':'archive'}-action="refresh"]`;
  const list=kind=>kind==='character'?'.sd-character-library':'.sd-comfy-library';
  const done=kind=>page.waitForSelector(`${list(kind)}[aria-busy="false"]`);
  const themeRoundtrip=async(family,mode,label)=>{
    const result=await page.evaluate(async({family,mode})=>{
      const root=host,nodes=[...root.querySelectorAll('*')],html=root.innerHTML,calls=JSON.stringify(operations),count=reads.length;
      await setAppearance(family==='glass'?'editorial':'glass',mode==='light'?'dark':'light');await setAppearance(family,mode);
      return nodes.every(node=>node.isConnected)&&root.innerHTML===html&&reads.length===count&&JSON.stringify(operations)===calls;
    },{family,mode});
    ok(label+' theme change retains the loading/error/empty DOM and makes no service call',result);
  };
  for(const [family,mode] of [['classic','dark'],['editorial','light'],['editorial','dark'],['glass','light'],['glass','dark']]){
    await page.evaluate(([family,mode])=>setAppearance(family,mode),[family,mode]);
    for(const width of [320,393,1100]){
      await page.setViewportSize({width,height:width===320?568:898});
      for(const kind of ['workflow','pool','character']){
        const label=`${family}/${mode}/${width}/${kind}`;
        await page.evaluate(kind=>startLibrary(kind),kind);await waitRead(0);
        ok(label+' first load is visibly pending, not an empty list',/正在读取/.test(await page.locator('#host').innerText()));
        await themeRoundtrip(family,mode,label+' pending');
        await page.evaluate(()=>reads[0].reject(Error('测试读取失败 <标签>')));await done(kind);
        ok(label+' read failure remains visible and escaped',await page.locator('#host [role="alert"]').count()===1&&(await page.locator('#host [role="alert"]').innerText()).includes('测试读取失败 <标签>')&&await page.locator('#host 标签').count()===0);
        await themeRoundtrip(family,mode,label+' failure');
        if(family==='glass'&&mode==='light'&&width===320&&kind==='workflow')await page.screenshot({caret:'initial',path:fileURLToPath(new URL('glass-light-workflow-failed-320.png',qa))});
        await page.locator(action(kind)).click();await waitRead(1);
        await page.evaluate(()=>reads[1].resolve([]));await done(kind);
        ok(label+' retry becomes an explicit, non-error empty state',await page.locator('#host [role="alert"]').count()===0&&/还没有|暂无/.test(await page.locator('#host').innerText()));
        await themeRoundtrip(family,mode,label+' empty');
        ok(label+' empty controls remain within the scroll surface',await page.locator(list(kind)).evaluate(node=>node.scrollWidth<=node.clientWidth+1));
        if(family==='editorial'&&mode==='dark'&&width===393&&kind==='pool')await page.screenshot({caret:'initial',path:fileURLToPath(new URL('editorial-dark-pool-empty-393.png',qa))});
        await page.locator(action(kind)).click();await waitRead(2);
        await page.evaluate(()=>reads[2].resolve([row('已恢复的资料')]));await done(kind);
        ok(label+' next retry shows data without changing saved state',/已恢复的资料/.test(await page.locator('#host').innerText())&&await page.evaluate(()=>operations.writes===0&&operations.apply===0&&operations.download===0));
        await page.locator(action(kind)).click();await waitRead(3);
        await page.evaluate(()=>reads[3].reject(Error('刷新失败，保留已有资料')));await done(kind);
        ok(label+' a failed refresh keeps the previously verified rows and reports the error',/已恢复的资料/.test(await page.locator('#host').innerText())&&await page.locator('#host [role="alert"]').count()===1);
        await page.locator(action(kind)).click();await waitRead(4);
        await page.evaluate(()=>{controller.dispose();host.innerHTML='<p id="departed">已离开资料库</p>';reads[4].resolve([row('迟到的资料')]);});await settle();
        ok(label+' a disposed view ignores late read completion',await page.locator('#departed').count()===1&&!/迟到的资料/.test(await page.locator('#host').innerText())&&await page.evaluate(()=>operations.close===1));
        // The next start must not dispose the already-disposed test owner twice.
        await page.evaluate(()=>window.controller=null);
      }
    }
  }
  // Account changes and remounts are separate from appearance changes; exercise
  // them once per actual controller and ensure old results never paint a new owner.
  for(const kind of ['workflow','pool','character']){
    await page.evaluate(kind=>startLibrary(kind),kind);await waitRead(0);
    await page.evaluate(()=>{state.account='st-user:second';reads[0].resolve([row('旧账户私有资料')]);});await settle();
    ok(kind+' rechecks account after pending list reads',!/旧账户私有资料/.test(await page.locator('#host').innerText()));
    await page.locator(action(kind)).click();await waitRead(1);
    ok(kind+' explicit retry uses the new account',await page.evaluate(()=>reads[1].namespace==='st-user:second'));
    await page.evaluate(()=>reads[1].resolve([row('新账户资料')]));await done(kind);
    await page.locator(action(kind)).click();await waitRead(2);
    await page.evaluate(()=>{
      controller.detach();window.oldHost=host;oldHost.innerHTML='<p>原页面保留</p>';
      host=document.createElement('div');host.id='new-host';oldHost.after(host);controller.mount(host);
      reads[2].resolve([row('旧页面迟到的资料')]);
    });await waitRead(3);
    ok(kind+' remount waits for its own read instead of showing the departed list',!/旧页面迟到的资料/.test(await page.locator('#new-host').innerText())&&await page.evaluate(()=>oldHost.textContent==='原页面保留'));
    await page.evaluate(()=>reads[3].resolve([row('新页面资料')]));await page.waitForSelector(`#new-host ${list(kind)}[aria-busy="false"]`);
    ok(kind+' remount can recover without writes',/新页面资料/.test(await page.locator('#new-host').innerText())&&await page.evaluate(()=>operations.writes===0));
    await page.locator(`#new-host ${action(kind)}`).click();await waitRead(4);
    await page.evaluate(()=>{window.noticeCount=notices.length;controller.dispose();host.textContent='已关闭新页面';reads[4].reject(Error('关闭后的迟到失败'));});await settle();
    ok(kind+' a late rejection after disposal does not repaint or notify',await page.evaluate(()=>host.textContent==='已关闭新页面'&&notices.length===noticeCount&&operations.close===1));
    await page.evaluate(()=>window.controller=null);
    await page.evaluate(()=>oldHost.remove());
  }
  await page.evaluate(()=>{controller?.dispose();appearanceSession.reset();});
  assert.deepEqual(errors,[]);assert.equal(external,0);
  console.log(JSON.stringify({passed:checks.length,checks,errors,external,scope:'three real library owners, read-only delayed services; not production persistence, cloud performance or real-device proof'}));
}finally{clearTimeout(deadline);await browser.close();}
