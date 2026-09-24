// Real Vibe controller, image decoding and object URLs; isolated read-only assets.
// Saved/selected results are captured in memory. No NAI encoding or provider API.
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const checks=[],errors=[];let external=0,previewBytes;
const deadline=setTimeout(()=>{void browser.close();},120000);
const css=await readFile(new URL('../style.css',import.meta.url),'utf8')+'\n'+await readFile(new URL('../qianmu-theme-skins.css',import.meta.url),'utf8');
const qa=new URL('../dist/local-qa/vibe-library/',import.meta.url);await mkdir(qa,{recursive:true});
try{
  const context=await browser.newContext(),page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin==='https://qianmu.test'&&url.pathname==='/user/images/vibe-synthetic.png'&&previewBytes)return route.fulfill({contentType:'image/png',body:previewBytes});
    if(url.origin==='https://qianmu.test'&&url.pathname==='/')return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:100dvh!important;box-sizing:border-box}#story-director-modal .sd-window{width:100%!important;height:100%!important;max-height:none!important;margin:0!important}</style><div id="story-director-modal" class="open sd-theme-dark sd-storyboard-mode"><section class="sd-window"><main class="sd-body sd-storyboard-body"><div class="sd-storyboard-root"><header class="sd-storyboard-titlebar">隔离 Vibe 库验收</header><div class="sd-storyboard-scroll"><div class="sd-vibe-library-host" id="host"></div></div><nav class="sd-storyboard-nav"></nav></div></main></section></div>`});
    if(url.origin==='https://qianmu.test'&&/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname))return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url))});
    external++;return route.abort();
  });
  await page.goto('https://qianmu.test/');
  previewBytes=Buffer.from(await page.evaluate(async()=>{
    const [vibes,{createQianmuAppearanceSession},settings,{applyQianmuIcons}]=await Promise.all([
      import('/qianmu-vibe-library-view.js'),import('/qianmu-appearance-session.js'),import('/qianmu-appearance-settings.js'),import('/qianmu-icon-renderer.js')]);
    const canvas=document.createElement('canvas');canvas.width=80;canvas.height=100;canvas.getContext('2d').fillStyle='#8bc1b3';canvas.getContext('2d').fillRect(0,0,80,100);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    window.liveUrls=new Set();window.createdUrls=0;const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
    URL.createObjectURL=value=>{const url=create(value);liveUrls.add(url);createdUrls++;return url;};URL.revokeObjectURL=url=>{liveUrls.delete(url);revoke(url);};
    window.appearanceSettings={theme:'dark'};window.appearanceSession=createQianmuAppearanceSession({readSettings:()=>appearanceSettings,loadStyles:()=>({promise:Promise.resolve(true),cancel(){}})});
    appearanceSession.mount(document.getElementById('story-director-modal'));
    window.setAppearance=async(family,mode)=>{appearanceSettings.appearance=settings.updateAppearancePreferences(appearanceSettings,{family,mode});await appearanceSession.sync();};
    window.headValue={summary:{hasImage:false,variants:[{model:'v4full',information:.5},{model:'v4full',information:1}]}};
    window.startVibes=({delayPreview=false,selection=true,editing=true}={})=>{
      window.controller?.dispose();window.host=document.getElementById('host');host.replaceChildren();
      document.querySelector('.sd-storyboard-scroll').scrollTop=0;
      window.headReads=[];window.previewReads=[];window.calls={previews:0,saves:0,applies:0,deletes:0,imports:0,exports:0,icons:0};window.notices=[];window.saved=[];window.applied=[];
      window.state={current:true,model:'nai-diffusion-4-full',precise:false};
      window.rows=Array.from({length:45},(_,i)=>({id:'vibe-'+i,name:'素材 '+String(i).padStart(2,'0'),providerIds:['novel'],modelIds:i===2?['nai-diffusion-4-5-full']:[],previewUrl:'/user/images/vibe-synthetic.png',strength:.6,informationExtracted:1}));
      rows[0]={...rows[0],previewUrl:'',assetRef:{version:1,namespace:'st-user:synthetic',id:'a'.repeat(64)}};
      const issue=item=>{try{vibes.checkStoryboardVibeSelection(rows,[item.id],{supportsVibe:true,modelId:state.model,preciseReference:state.precise});return '';}catch(error){return error.message;}};
      window.controller=vibes.createStoryboardVibeLibraryController({items:()=>rows,gallery:()=>[],modelId:()=>state.model,isCurrent:()=>state.current,
        assets:{head:ref=>new Promise((resolve,reject)=>headReads.push({ref,resolve,reject})),preview:async()=>{calls.previews++;if(delayPreview)await new Promise(resolve=>previewReads.push(resolve));return blob;},
          import:async()=>{calls.imports++;throw Error('import not in this isolated run');},export:async()=>{calls.exports++;throw Error('export not in this isolated run');}},
        selectionIssue:issue,save:async(_node,options)=>{calls.saves++;if(!options.isCurrent())return false;saved.push(options.readDraft());return true;},
        remove:async()=>{calls.deletes++;return false;},onApply:async ids=>{const next=vibes.checkStoryboardVibeSelection(rows,ids,{supportsVibe:true,modelId:state.model,preciseReference:state.precise});calls.applies++;applied.push(next);},
        onNotice:message=>notices.push(message),icons:node=>{calls.icons++;applyQianmuIcons(node);}});
      if(editing)controller.edit(rows[0]);if(selection)controller.beginSelection({id:'synthetic-selection',ids:['vibe-1']});controller.mount(host);
    };
    return [...new Uint8Array(await blob.arrayBuffer())];
  }));
  const ok=(label,value)=>{assert.ok(value,label);checks.push(label);};
  const frame=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const settlePreviews=()=>page.waitForFunction(()=>document.querySelector('[data-vibe-asset-preview="editor"] img')?.naturalWidth===80);
  await page.evaluate(()=>startVibes({editing:false}));await frame();
  ok('the default library shows its collection and a new button, without an editor or metadata read',await page.locator('.sd-vibe-editor').count()===0&&await page.locator('[data-vibe-id]').count()===40&&await page.locator('.sd-vibe-new').isEnabled()&&await page.evaluate(()=>headReads.length===0));
  await page.locator('.sd-vibe-new').click();await page.waitForSelector('.sd-vibe-editor');
  ok('new explicitly opens an empty editor without publishing',await page.locator('.sd-storyboard-vibe-name').inputValue()===''&&await page.evaluate(()=>calls.saves===0&&headReads.length===0));
  await page.locator('.sd-vibe-reset-editor').click();
  ok('cancel closes the new editor and restores the new button without publishing',await page.locator('.sd-vibe-editor').count()===0&&await page.locator('.sd-vibe-new').isEnabled()&&await page.evaluate(()=>calls.saves===0));
  await page.locator('[data-vibe-id="vibe-0"] .sd-vibe-edit').click();await settlePreviews();
  ok('editing a library tile explicitly opens its draft and reads only its encoding metadata',await page.locator('.sd-storyboard-vibe-name').inputValue()==='素材 00'&&await page.evaluate(()=>headReads.length===1&&calls.saves===0));
  const roundtrip=async(family,mode,label)=>{
    const result=await page.evaluate(async({family,mode})=>{
      const input=document.querySelector('.sd-storyboard-vibe-name');input.focus({preventScroll:true});input.setSelectionRange(1,4);
      const nodes=[...host.querySelectorAll('*')],html=host.innerHTML,values=[input.value,input.selectionStart,input.selectionEnd],requests=JSON.stringify(calls),heads=headReads.length,urls=createdUrls;
      await setAppearance(family==='glass'?'editorial':'glass',mode==='light'?'dark':'light');await setAppearance(family,mode);
      return {dom:nodes.every(node=>node.isConnected)&&host.innerHTML===html,focus:document.activeElement===input,values:JSON.stringify([input.value,input.selectionStart,input.selectionEnd])===JSON.stringify(values),calls:JSON.stringify(calls)===requests&&headReads.length===heads,urls:createdUrls===urls};
    },{family,mode});
    ok(label+' swaps appearance without re-rendering, requests, object URLs or losing input: '+JSON.stringify(result),Object.values(result).every(Boolean));
  };
  for(const [family,mode] of [['classic','dark'],['editorial','light'],['editorial','dark'],['glass','light'],['glass','dark']]){
    await page.evaluate(([family,mode])=>setAppearance(family,mode),[family,mode]);
    for(const width of [320,393,1100]){
      const label=`${family}/${mode}/${width}`;await page.setViewportSize({width,height:width===320?568:898});
      await page.evaluate(()=>startVibes());await settlePreviews();
      await page.locator('.sd-storyboard-vibe-name').fill('未保存的名字');
      await roundtrip(family,mode,label+' pending encoding metadata');
      await page.evaluate(()=>{window.nameField=document.querySelector('.sd-storyboard-vibe-name');window.beforePreviewCount=createdUrls;headReads[0].resolve(headValue);});
      await page.waitForSelector('select.sd-storyboard-vibe-info');
      ok(label+' metadata completion only updates the information control and preserves the live editor',await page.evaluate(()=>nameField.isConnected&&document.activeElement===nameField&&nameField.value==='未保存的名字'&&nameField.selectionStart===1&&nameField.selectionEnd===4&&createdUrls===beforePreviewCount));
      await page.locator('.sd-storyboard-vibe-info').selectOption('0.5');
      await roundtrip(family,mode,label+' loaded editor');
      ok(label+' visible controls fit without horizontal overflow',await page.locator('#host').evaluate(node=>node.scrollWidth<=node.clientWidth+1&&[...node.querySelectorAll('.sd-vibe-selection-bar button')].every(button=>button.getBoundingClientRect().right<=node.getBoundingClientRect().right+1)));
      ok(label+' incompatible models remain unselectable and the prior choice remains selected',await page.locator('[data-vibe-id="vibe-2"] .sd-vibe-select').isDisabled()&&await page.locator('[data-vibe-id="vibe-1"] .sd-vibe-select').getAttribute('aria-pressed')==='true');
      if(width===393&&((family==='glass'&&mode==='light')||(family==='editorial'&&mode==='dark')))await page.screenshot({caret:'initial',path:fileURLToPath(new URL(`${family}-${mode}-393.png`,qa))});
      await page.locator('.sd-storyboard-create-vibe').click();await page.waitForFunction(()=>calls.saves===1&&!document.querySelector('.sd-vibe-editor')&&!document.querySelector('.sd-vibe-new').disabled);
      ok(label+' only explicit save publishes the edited values and keeps the asset reference',await page.evaluate(()=>saved[0].name==='未保存的名字'&&Number(saved[0].info)===.5&&saved[0].assetRef.id==='a'.repeat(64)&&calls.applies===0&&calls.deletes===0&&calls.imports===0&&calls.exports===0));
      await page.evaluate(()=>{controller.dispose();controller=null;});await frame();ok(label+' disposal releases every owned preview URL',await page.evaluate(()=>liveUrls.size===0));
    }
  }
  await page.evaluate(()=>startVibes());await settlePreviews();await page.locator('.sd-storyboard-vibe-name').fill('失败后保留');
  await page.evaluate(()=>{window.nameField=document.querySelector('.sd-storyboard-vibe-name');nameField.focus();nameField.setSelectionRange(2,4);headReads[0].reject(Error('编码元数据暂不可读'));});
  await page.waitForSelector('.sd-vibe-head-retry');
  ok('metadata failure keeps the same draft and exposes an explicit read-only retry',await page.evaluate(()=>nameField.isConnected&&nameField.value==='失败后保留'&&nameField.selectionStart===2&&nameField.selectionEnd===4&&notices.length===1&&calls.saves===0));
  for(const width of [320,393,1100]){
    await page.setViewportSize({width,height:898});
    ok(`metadata retry fits its information column at ${width}`,await page.locator('.sd-vibe-head-retry').evaluate(node=>node.getBoundingClientRect().right<=node.parentElement.getBoundingClientRect().right+1&&host.scrollWidth<=host.clientWidth+1));
    if(width===393)await page.screenshot({caret:'initial',path:fileURLToPath(new URL('glass-dark-metadata-retry-393.png',qa))});
  }
  await page.locator('.sd-vibe-head-retry').click();await page.waitForFunction(()=>headReads.length===2);
  await page.evaluate(()=>headReads[1].resolve(headValue));await page.waitForSelector('select.sd-storyboard-vibe-info');
  ok('metadata retry recovers without saving or changing the source',await page.locator('.sd-storyboard-vibe-name').inputValue()==='失败后保留'&&await page.evaluate(()=>calls.saves===0));
  await page.locator('.sd-vibe-search').fill('不存在的素材');await page.waitForFunction(()=>!document.querySelector('[data-vibe-id]'));
  ok('a no-match search leaves the editor intact',await page.locator('.sd-storyboard-vibe-name').inputValue()==='失败后保留');
  await page.locator('.sd-vibe-search').fill('');await page.waitForFunction(()=>document.querySelectorAll('[data-vibe-id]').length===40);
  await page.locator('.sd-vibe-more').click();await page.waitForFunction(()=>document.querySelectorAll('[data-vibe-id]').length===45);
  ok('Vibe pages expand only on explicit more and keep the input draft',await page.locator('.sd-storyboard-vibe-name').inputValue()==='失败后保留');
  await page.evaluate(()=>state.precise=true);await page.locator('.sd-vibe-apply-selection').click();
  await page.waitForFunction(()=>notices.some(message=>message.includes('互斥')));
  ok('changed precise-reference capability blocks confirmation instead of publishing',await page.evaluate(()=>calls.applies===0));
  await page.locator('.sd-vibe-clear-selection').click();await page.locator('.sd-vibe-apply-selection').click();await page.waitForFunction(()=>calls.applies===1);
  ok('explicitly clearing incompatible selections is still permitted',await page.evaluate(()=>applied[0].length===0));
  for(const completion of ['resolve','reject']){
    await page.evaluate(()=>startVibes());await settlePreviews();
    await page.locator('.sd-vibe-source-mode').selectOption('url');
    await page.locator('.sd-vibe-source-url').fill('/user/images/vibe-synthetic.png');await page.locator('.sd-vibe-source-load').click();
    await page.waitForFunction(()=>!document.querySelector('.sd-vibe-preview').hasAttribute('data-vibe-asset-preview'));
    await page.evaluate(completion=>{
      window.currentInfo=document.querySelector('.sd-storyboard-vibe-info');window.beforeNotices=notices.length;
      if(completion==='resolve')headReads[0].resolve(headValue);else headReads[0].reject(Error('旧来源已失效'));
    },completion);await frame();
    ok(`late metadata ${completion} for a replaced source cannot alter its new controls or report an obsolete error`,await page.evaluate(()=>currentInfo.isConnected&&currentInfo.type==='number'&&notices.length===beforeNotices&&calls.saves===0));
  }
  await page.evaluate(()=>startVibes({delayPreview:true}));await page.waitForFunction(()=>previewReads.length>0&&headReads.length===1);
  await page.evaluate(()=>{window.urlsBeforeClose=createdUrls;controller.dispose();controller=null;host.innerHTML='<p>已离开 Vibe 库</p>';for(const resolve of previewReads)resolve();headReads[0].resolve(headValue);});await frame();
  ok('late preview and metadata completion after disposal cannot allocate URLs or repaint',await page.evaluate(()=>liveUrls.size===0&&createdUrls===urlsBeforeClose&&host.textContent==='已离开 Vibe 库'));
  await page.evaluate(()=>appearanceSession.reset());assert.deepEqual(errors,[]);assert.equal(external,0);
  console.log(JSON.stringify({passed:checks.length,checks,errors,external,scope:'actual Vibe editor/list/selection and object URLs with read-only synthetic assets; no encoding, persistence, import or paid API proof'}));
}finally{clearTimeout(deadline);await browser.close();}
