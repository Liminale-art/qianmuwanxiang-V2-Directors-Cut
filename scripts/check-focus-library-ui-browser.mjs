// Fresh origin and native IndexedDB; production ST, paid TTS and user data are never touched.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext({hasTouch:true}),errors=[];let external=0;
const css=await readFile(new URL('../style.css',import.meta.url),'utf8');
await context.route('**/*',async route=>{const url=new URL(route.request().url());
  if(url.origin==='https://qianmu.test'&&url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:850px!important;box-sizing:border-box}</style><div id="story-director-modal" class="open sd-theme-dark"><main>untouched host</main></div>`});
  if(url.origin==='https://qianmu.test'&&/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname))return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url),'utf8')});
  external++;return route.abort();
});
try {
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto('https://qianmu.test/');
  await page.evaluate(async()=>{
    const {createFocusLibraryStore}=await import('/qianmu-focus-library-store.js'),{openFocusLibrary}=await import('/qianmu-focus-library-ui.js');
    window.store=createFocusLibraryStore();window.scope={namespace:'st-user:fixture',characterKey:'character:A.png'};window.calls={synth:0,download:[],confirm:[]};
    // Decodable silent mono WAV, not a real person's recording.
    const buffer=new ArrayBuffer(1644),v=new DataView(buffer),put=(at,text)=>[...text].forEach((c,i)=>v.setUint8(at+i,c.charCodeAt(0)));
    put(0,'RIFF');v.setUint32(4,1636,true);put(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,8000,true);v.setUint32(28,16000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);put(36,'data');v.setUint32(40,1600,true);
    window.wav=new Blob([buffer],{type:'audio/wav'});window.live=true;
    window.start=async management=>{window.view?.close();view=await openFocusLibrary({document,host:document.querySelector('#story-director-modal'),store,namespace:scope.namespace,isActive:()=>live,
      guard:async()=>{if(!live)throw Error('changed owner');},choices:()=>[{avatar:'A.png',name:'甲'},{avatar:'B.png',name:'乙'}],
      binding:key=>({speaker:key==='character:A.png'?'甲':'乙',providerId:'minimax',voice:{voiceId:'v'},options:[{voiceId:'v',label:'测试音色'}]}),generate:async()=>{calls.synth++;if(window.delayed)return new Promise(resolve=>window.finish=resolve);return wav;},
      escape:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),icons:()=>{},
      confirm:async(...args)=>{calls.confirm.push(args);return true;},notify:()=>{},download:(file,name)=>calls.download.push({file,name}),stopAudio:()=>{}},{management});};
    await start(false);
  });
  const checks=[],ok=(name,value)=>{assert.ok(value,name);checks.push(name);};
  for(const width of [320,393,1100]){
    await page.setViewportSize({width,height:898});const box=await page.locator('.sd-focus-library').boundingBox();
    ok(`library contained at ${width}`,box.x>=0&&box.x+box.width<=width+1&&box.y>=0&&box.y+box.height<=898);
  }
  await page.locator('[data-field=folder]').selectOption('character:A.png');await page.locator('[data-action=new]').click();
  await page.locator('[data-field=text]').fill('<script>not markup</script> 完成了');await page.locator('[data-field=title]').fill('my voice');
  await page.locator('[data-moment="shortBreak:complete"]').check();await page.locator('[data-action=generate]').click();
  await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.includes('请试听'));
  ok('explicit generation asks confirmation exactly once',await page.evaluate(()=>calls.synth===1&&calls.confirm.filter(row=>row[0]==='生成语音').length===1));
  await page.locator('audio').evaluate(audio=>audio.load());await page.waitForFunction(()=>document.querySelector('audio').readyState>=1);
  ok('preview uses a genuinely decodable local audio',await page.locator('audio').evaluate(audio=>Number.isFinite(audio.duration)&&audio.duration>0));
  await page.locator('[data-action=save]').click();await page.waitForSelector('.sd-focus-library-item');
  ok('save produced one original in the independent database',await page.evaluate(async()=>(await store.summary(scope.namespace)).count===1));
  ok('title and script-like text stay escaped',await page.locator('.sd-focus-library-body script').count()===0);
  await page.locator('[data-action=edit]').click();await page.locator('[data-field=text]').fill('changed words');await page.locator('[data-action=save]').click();
  await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.includes('请先生成'));
  ok('text edits cannot save the old sound under new words',await page.evaluate(async()=>(await store.list(scope.namespace))[0].text.startsWith('<script>')));
  await page.locator('[data-action=back]').click();await page.waitForSelector('[data-field=folder]');await page.locator('[data-field=folder]').selectOption('character:B.png');
  ok('another character starts with an empty folder',await page.locator('.sd-focus-library-item').count()===0);
  await page.evaluate(()=>start(true));await page.locator('[data-action=all]').click();await page.locator('[data-action=export]').click();
  await page.waitForFunction(()=>calls.download.length===1);const file=await page.evaluate(async()=>({text:await calls.download[0].file.text(),name:calls.download[0].name}));
  ok('backup does not trigger generation',await page.evaluate(()=>calls.synth===1));
  await page.locator('[data-field=import]').setInputFiles({name:file.name,mimeType:'application/json',buffer:Buffer.from(file.text)});
  await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.includes('可在关闭本页前撤回'));
  ok('import adds a copy and keeps the original',await page.evaluate(async()=>(await store.summary(scope.namespace)).count===2));
  await page.locator('[data-action=undo]').click();await page.waitForFunction(()=>!document.querySelector('[data-action=undo]'));
  ok('undo removes only this import',await page.evaluate(async()=>(await store.summary(scope.namespace)).count===1));
  await page.locator('[data-action=all]').click();await page.locator('[data-action=delete]').click();await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.includes('已删除'));
  ok('selected cleanup accounts for originals and metadata',await page.evaluate(async()=>{const x=await store.summary(scope.namespace);return x.count===0&&x.bytes===0;}));
  // Transaction failure and newer edits must abort an entire selected batch.
  const batchChecks=await page.evaluate(async()=>{
    const checks=[],check=(name,value)=>{if(!value)throw Error(name);checks.push(name);};
    const clip={...scope,id:'batch1',text:'one',moments:['focus:complete']},second={...clip,id:'batch2'};
    let first=await store.batch(scope.namespace,{add:[{clip,blob:wav},{clip:second,blob:wav}]});
    check('batch append commits all originals',first.added.length===2&&(await store.summary(scope.namespace)).count===2);
    const fresh=await store.save(scope,{...first.added[1],text:'new version'},wav,{expectedRevision:first.added[1].revision});
    let failed=false;try{await store.batch(scope.namespace,{remove:first.added});}catch(_){failed=true;}
    check('stale batch deletion leaves every original',failed&&(await store.summary(scope.namespace)).count===2);
    const nativePut=IDBObjectStore.prototype.put,before=await store.summary(scope.namespace);
    try{let writes=0;IDBObjectStore.prototype.put=function(...args){if(this.name==='audio'&&++writes===2)throw Error('synthetic second audio failure');return nativePut.apply(this,args);};
      failed=false;try{await store.batch(scope.namespace,{add:[{clip:{...clip,id:'broken1'},blob:wav},{clip:{...clip,id:'broken2'},blob:wav}]});}catch(_){failed=true;}
    }finally{IDBObjectStore.prototype.put=nativePut;}
    check('second audio failure rolls back the entire import and accounting',failed&&JSON.stringify(await store.summary(scope.namespace))===JSON.stringify(before));
    await store.batch(scope.namespace,{remove:[first.added[0],fresh.clip]});check('exact cleanup leaves zero payload bytes',(await store.summary(scope.namespace)).bytes===0);
    return checks;
  });checks.push(...batchChecks);
  const runtimeChecks=await page.evaluate(async()=>{
    const {createFocusLibraryRuntime}=await import('/qianmu-focus-library-runtime.js');
    const clip={...scope,id:'runtime',text:'finished',moments:['focus:complete','shortBreak:complete','longBreak:complete']};
    await store.save(scope,clip,wav);const notices=[];let owner={},current=true,serial=0;
    const runtime=createFocusLibraryRuntime({owner:()=>owner,resolveNamespace:async()=>scope.namespace,context:()=>({characterKey:scope.characterKey}),choices:()=>[],generate:()=>{throw Error('no generation permitted');},notify:(...args)=>notices.push(args)});
    const found=[];
    for(const phase of ['focus','shortBreak','longBreak']){
      const state={phase,sessionVoiceCues:[],sessionStartedAt:1,task:'read'};
      await runtime.prepare({state,sessionToken:'t',bindingKey:'binding',isCurrent:()=>current,specs:[{type:'complete',progress:1}],uid:()=>String(++serial),save(){}});
      const cue=state.sessionVoiceCues[0];if(cue?.text!=='finished'||cue?.format!=='wav')throw Error('runtime lost original');
      const hit=await runtime.read(cue);if(hit?.blob.size!==wav.size)throw Error('runtime lost audio');found.push(phase);
    }
    const summary=await runtime.summary();if(summary.status!=='ready'||summary.count!==1)throw Error('runtime summary');
    const changed={...scope,namespace:'st-user:someone-else',id:'runtime',revision:1};if(await runtime.read({library:changed})!==null)throw Error('account leak');
    await store.batch(scope.namespace,{remove:await store.list(scope.namespace)});runtime.close();
    return ['real custom preparation and readback across '+found.join('/'),'runtime verifies account before audio read','runtime summary does not require TTS credentials'];
  });checks.push(...runtimeChecks);
  await page.evaluate(()=>start(false));await page.locator('[data-field=folder]').selectOption('character:A.png');await page.locator('[data-action=new]').click();await page.locator('[data-field=text]').fill('later');
  await page.evaluate(()=>window.delayed=true);await page.locator('[data-action=generate]').click();await page.waitForFunction(()=>!!window.finish);
  await page.evaluate(()=>{view.close();finish(wav);});await page.waitForTimeout(40);
  ok('late generation cannot resurrect closed UI or save a recording',await page.evaluate(async()=>!document.querySelector('.sd-focus-library')&&(await store.summary(scope.namespace)).count===0));
  ok('closing restores the host interaction',await page.locator('main').evaluate(el=>!el.inert));
  const managementChecks=await page.evaluate(async()=>{
    const {createFocusLibraryRuntime}=await import('/qianmu-focus-library-runtime.js'),{createCoreadImportViewGuard}=await import('/qianmu-reader-package.js');
    const checks=[],host=document.querySelector('#story-director-modal'),owner={};
    for(const change of ['normal','close','close-reopen']){
      let release,allowed=true;const gate=new Promise(r=>release=r);
      const runtime=createFocusLibraryRuntime({owner:()=>owner,resolveNamespace:async()=>{await gate;return scope.namespace;},available:()=>allowed,
        watchView:root=>createCoreadImportViewGuard(root,'管理',''),choices:()=>[],context:()=>({}),notify(){},
        ui:{document,host:()=>host,escape:String,icons(){},confirm:async()=>false,stopAudio(){},changed(){}}});
      const pending=runtime.open({management:true});if(!runtime.busy)throw Error('loading not reserved');
      if(change==='close')runtime.close();
      if(change==='close-reopen'){host.classList.remove('open');host.classList.add('open');}
      release();await pending;
      if(change==='normal'){
        if(!runtime.busy||!host.querySelector('.sd-focus-library'))throw Error('manager released before closing');
        host.querySelector('[data-action=close]').click();await new Promise(r=>setTimeout(r,0));
        if(runtime.busy)throw Error('close retained activity');
        allowed=false;await runtime.open({management:true});
      }
      if(runtime.busy||host.querySelector('.sd-focus-library'))throw Error('stale manager reopened');
      runtime.close();checks.push('real management lifecycle '+change);
    }
    return checks;
  });checks.push(...managementChecks);
  assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,external,errors,realDOM:true,nativeIndexedDB:true,realAudioDecode:true,paidTTS:false}));
}finally{await context.close();await browser.close();}
