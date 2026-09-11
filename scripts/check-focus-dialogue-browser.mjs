// Isolated DOM/native storage with no production ST, real TTS, or external network.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {focusDefaults} from '../tests/helpers/focus-lock-fixture.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const css=await readFile(new URL('../style.css',import.meta.url),'utf8'),entry=await readFile(new URL('../index.js',import.meta.url),'utf8');
const presets=entry.match(/const FOCUS_CLOCK_SOUND_PRESETS = Object.freeze\((\{[\s\S]*?\n\})\);/)[1];
assert.equal((presets.match(/new URL\('\.\/assets\/focus-sounds\//g)||[]).length,8);
assert.doesNotMatch(presets,/https?:/);
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext(),errors=[],checks=[];let external=0;
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin==='https://qianmu.test'){
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:850px!important;box-sizing:border-box}</style><div id="story-director-modal" class="open sd-theme-dark"><main></main></div>`});
    if(/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname))return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url),'utf8')});
    if(/^\/assets\/focus-sounds\/[a-z-]+\.mp3$/.test(url.pathname))return route.fulfill({contentType:'audio/mpeg',body:await readFile(new URL('..'+url.pathname,import.meta.url))});
  }
  external++;return route.abort();
});
const ok=(label,condition)=>{assert.ok(condition,label);checks.push(label);};
try{
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto('https://qianmu.test/');
  await page.evaluate(async defaults=>{
    const {createFocusLibraryRuntime}=await import('/qianmu-focus-library-runtime.js');
    const {createFocusLibraryStore}=await import('/qianmu-focus-library-store.js');
    window.owner={focusClock:defaults};window.saved=0;window.generation=0;window.active=true;
    window.scope={namespace:'st-user:dialogue-fixture',characterKey:'character:A.png'};
    const store=createFocusLibraryStore();await store.save(scope,{...scope,id:'legacy',speaker:'甲',text:'旧的录音台词',moments:['focus:complete']},new Blob(['legacy audio'],{type:'audio/wav'}));store.close();
    window.escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    window.library=createFocusLibraryRuntime({owner:()=>owner,resolveNamespace:async()=>scope.namespace,save:()=>saved++,context:()=>({characterKey:scope.characterKey}),choices:()=>[{avatar:'A.png',name:'甲'},{avatar:'B.png',name:'乙'}],
      generate:()=>{generation++;throw Error('editor must not generate');},notify:message=>{throw Error(message);},
      ui:{document,host:()=>document.querySelector('#story-director-modal'),escape,icons(){},confirm:async()=>true,changed(){}}});
    await library.open();
  },focusDefaults);
  for(const width of [320,393,1100]){
    await page.setViewportSize({width,height:898});
    const values=await page.evaluate(()=>{const rect=el=>el.getBoundingClientRect().toJSON();return {panel:rect(document.querySelector('.sd-focus-library')),select:rect(document.querySelector('[data-field=folder]')),button:rect(document.querySelector('[data-action=new]'))};});
    ok(`dialogue panel contained at ${width}`,values.panel.x>=0&&values.panel.x+values.panel.width<=width+1);
    ok(`folder and new button share height and baseline at ${width}`,Math.abs(values.select.height-values.button.height)<1&&Math.abs(values.select.bottom-values.button.bottom)<1);
  }
  ok('legacy text is visible without changing or generating its recording',await page.locator('.sd-focus-library-item').count()===1&&await page.evaluate(()=>generation===0));
  await page.locator('[data-action=new]').click();await page.locator('[data-field=text]').fill('<script>literal text</script> 新的台词');await page.locator('[data-moment="longBreak:complete"]').check();
  ok('editor has only text and stage fields, no title voice or audio controls',await page.locator('audio,[data-action=generate],[data-field=title],[data-field=voice]').count()===0);
  await page.locator('[data-action=save]').click();await page.waitForFunction(()=>document.querySelector('[role=status]').textContent==='台词已保存');
  ok('save creates a text record without generation',await page.evaluate(()=>owner.focusClock.dialogueLibrary.rows.length===2&&generation===0));
  ok('text-like markup is escaped',await page.locator('.sd-focus-library-body script').count()===0);
  await page.locator('[data-field=folder]').selectOption('character:B.png');ok('stable role folders remain isolated',await page.locator('.sd-focus-library-item').count()===0);
  await page.evaluate(()=>library.close());await page.evaluate(()=>library.open());
  ok('reopening does not duplicate migrated text',await page.evaluate(()=>owner.focusClock.dialogueLibrary.rows.length===2));
  await page.locator('[data-action=edit]').last().click();await page.locator('[data-field=text]').fill('修改后的台词');await page.locator('[data-action=save]').click();
  await page.waitForFunction(()=>document.querySelector('[role=status]').textContent==='台词已保存');
  ok('saved text edits survive reloading',await page.evaluate(()=>owner.focusClock.dialogueLibrary.rows.at(-1).text==='修改后的台词'));
  await page.evaluate(()=>library.close());await page.evaluate(()=>library.open({management:true}));
  ok('legacy original remains in data management',await page.locator('.sd-focus-library-item').count()===1);
  await page.locator('[data-action=edit]').click();ok('legacy management is read-only playback without pre-generation',await page.locator('audio').count()===1&&await page.locator('[data-action=generate],[data-action=save]').count()===0);
  await page.evaluate(()=>library.close());
  await page.evaluate(async()=>{
    const {renderFocusClockView}=await import('/qianmu-focus-view.js');window.render=mode=>{
      owner.focusClock.voiceMode=mode;const data={f:owner.focusClock,remaining:1500000,total:1500000,phase:{label:'专注'},strongLocked:false,today:[],week:{days:Array.from({length:7},()=>({minutes:0})),history:[],minutes:0,count:0,readingMinutes:0},books:[],weekStart:new Date(),
        voiceContext:{hasCharacter:true,characterName:'甲',voice:{voiceId:'v'},options:[],enabled:true},voiceCharacters:[],voiceDrawerCount:0,providerLabel:'测试',FOCUS_CLOCK_PHASES:{focus:{label:'专注',icon:'fa-clock'}},FOCUS_CLOCK_RELATIONS:{neutral:{label:'普通'}},FOCUS_CLOCK_VOICE_FREQUENCIES:{low:{label:'低',chance:.3}},FOCUS_CLOCK_SOUND_PRESETS:{}};
      document.querySelector('main').innerHTML=renderFocusClockView(data,escape);document.querySelector('.sd-focus-settings').open=true;
    };render('custom');
  });
  for(const width of [320,393,1100]){
    await page.setViewportSize({width,height:898});const shape=await page.evaluate(()=>{
      const inputs=[...document.querySelectorAll('.sd-focus-setting')],labels=[...document.querySelectorAll('.sd-focus-setting-grid>label>span')];
      return {heights:inputs.map(el=>el.getBoundingClientRect().height),left:labels.every(el=>getComputedStyle(el).textAlign==='left'),title:getComputedStyle(document.querySelector('.sd-focus-settings>summary')).fontSize,card:getComputedStyle(document.querySelector('.sd-focus-sound-card h3')).fontSize,
        contained:inputs.every(el=>{const box=el.getBoundingClientRect();return box.x>=0&&box.right<=innerWidth;})};
    });
    ok(`cycle fields equal height, left labels and contained at ${width}`,new Set(shape.heights).size===1&&shape.left&&shape.contained);
    ok(`cycle title matches other cards at ${width}`,shape.title===shape.card);
  }
  await page.evaluate(()=>render('scene'));ok('scene mode has no dialogue library button',await page.locator('.sd-focus-library-open').count()===0);
  for(const name of ['merry-christmas-mr-lawrence','farewell']){
    const duration=await page.evaluate(name=>new Promise((resolve,reject)=>{
      const audio=new Audio(`/assets/focus-sounds/${name}.mp3`),timer=setTimeout(()=>reject(Error('decode timeout')),8000);
      audio.onloadedmetadata=()=>{clearTimeout(timer);resolve(audio.duration);audio.removeAttribute('src');audio.load();};audio.onerror=()=>{clearTimeout(timer);reject(Error('decode failed'));};audio.load();
    }),name);ok(`bundled ${name} decodes without external URL`,Number.isFinite(duration)&&duration>0);
  }
  assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,external,errors,paidTTS:false,nativeIndexedDB:true}));
}finally{await context.close();await browser.close();}
