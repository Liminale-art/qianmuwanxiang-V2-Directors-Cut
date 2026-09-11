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
const mobile=process.env.QIANMU_TEST_MOBILE==='1';
const context=await browser.newContext(mobile?{isMobile:true,hasTouch:true,deviceScaleFactor:2}:{}),errors=[],checks=[];let external=0;
// Simulate host/theme defaults absent from the old isolated fixture; not a claim about live ST CSS.
const hostRules='label{margin-block:8px 6px}button{margin-block:5px;min-width:104px}select{margin-block:6px;line-height:1.8}';
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin==='https://qianmu.test'){
    if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${hostRules}</style><style>${css}</style><style>body{margin:0}#story-director-modal{position:relative!important;display:block!important;inset:auto!important;transform:none!important;width:100%!important;height:850px!important;box-sizing:border-box}</style><div id="story-director-modal" class="open sd-theme-dark"><main></main></div>`});
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
    window.owner={focusClock:defaults};window.saved=0;window.generation=0;window.active=true;window.confirmations=[];window.allowConfirm=true;
    window.scope={namespace:'st-user:dialogue-fixture',characterKey:'character:A.png'};
    const store=createFocusLibraryStore();await store.save(scope,{...scope,id:'legacy',speaker:'甲',text:'旧的录音台词',moments:['focus:complete']},new Blob(['legacy audio'],{type:'audio/wav'}));store.close();
    window.escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    window.library=createFocusLibraryRuntime({owner:()=>owner,resolveNamespace:async()=>scope.namespace,save:()=>saved++,context:()=>({characterKey:scope.characterKey}),choices:()=>[{avatar:'A.png',name:'甲'},{avatar:'B.png',name:'乙'}],
      generate:()=>{generation++;throw Error('editor must not generate');},notify:message=>{throw Error(message);},
      ui:{document,host:()=>document.querySelector('#story-director-modal'),escape,icons(){},confirm:async(...args)=>{confirmations.push(args);return allowConfirm;},changed(){}}});
    await library.open();
  },focusDefaults);
  for(const width of mobile?[320,393]:[320,393,1100]){
    await page.setViewportSize({width,height:898});
    const values=await page.evaluate(()=>{const rect=el=>el.getBoundingClientRect().toJSON();return {panel:rect(document.querySelector('.sd-focus-library')),select:rect(document.querySelector('[data-field=folder]')),button:rect(document.querySelector('[data-action=new]'))};});
    ok(`dialogue panel contained at ${width}`,values.panel.x>=0&&values.panel.x+values.panel.width<=width+1);
    ok(`folder and new button share height and baseline at ${width}`,Math.abs(values.select.height-values.button.height)<1&&Math.abs(values.select.bottom-values.button.bottom)<1);
  }
  ok('folder has an accessible name without the removed visible subheading',await page.locator('[data-field=folder]').getAttribute('aria-label')==='选择角色'&&!await page.locator('.sd-focus-library-body').innerText().then(text=>text.includes('角色文件夹')));
  ok('legacy text is visible without changing or generating its recording',await page.locator('.sd-focus-library-item').count()===1&&await page.evaluate(()=>generation===0));
  await page.locator('[data-action=new]').click();await page.locator('[data-action=back]').click();
  ok('leaving an empty new draft creates no row or discard confirmation',await page.evaluate(()=>owner.focusClock.dialogueLibrary.rows.length===1&&confirmations.length===0));
  await page.locator('[data-action=new]').click();await page.locator('[data-field=text]').fill('<script>literal text</script> 新的台词');await page.locator('[data-moment="longBreak:complete"]').click();
  ok('editor has only text and stage fields, no title voice or audio controls',await page.locator('audio,[data-action=generate],[data-field=title],[data-field=voice]').count()===0);
  ok('editor header uses character name without a duplicate name row',await page.locator('.sd-focus-library h3').innerText()==='甲'&&await page.locator('.sd-focus-library-body b').count()===0);
  for(const width of mobile?[320,393]:[320,393,1100]){
    await page.setViewportSize({width,height:898});const back=await page.locator('[data-action=back]').boundingBox(),title=await page.locator('.sd-focus-dialogue h3').boundingBox();
    ok(`square list button sits left of the centered title line at ${width}`,Math.abs(back.width-back.height)<1&&Math.abs(back.y+back.height/2-title.y-title.height/2)<1&&back.x+back.width<title.x+1);
    const tags=await page.locator('[data-moment]').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().toJSON()));
    ok(`four stage tags have equal dimensions and gutters at ${width}`,tags.length===4&&tags.every(b=>Math.abs(b.height-tags[0].height)<1&&Math.abs(b.width-tags[0].width)<1)&&Math.abs(tags[1].left-tags[0].right-8)<1&&Math.abs(tags[2].top-tags[0].bottom-8)<1);
    const gap=await page.evaluate(()=>document.querySelector('.sd-focus-library-body>label').getBoundingClientRect().top-document.querySelector('.sd-focus-dialogue header').getBoundingClientRect().bottom);
    ok(`title to editor gap is compact at ${width}`,gap>=0&&gap<=4);
    if(width===393&&process.env.QIANMU_QA_SCREENSHOTS==='1')await page.locator('.sd-focus-dialogue').screenshot({path:'dist/local-qa/focus-dialogue-137.png'});
  }
  await page.waitForFunction(()=>owner.focusClock.dialogueLibrary.rows.length===2&&owner.focusClock.dialogueLibrary.rows[1].moments.includes('longBreak:complete'));
  ok('typing creates a text record without generation or explicit save/delete buttons',await page.evaluate(()=>generation===0)&&await page.locator('[data-action=save],[data-action=remove]').count()===0);
  await page.locator('[data-action=back]').click();
  ok('text-like markup is escaped',await page.locator('.sd-focus-library-body script').count()===0);
  await page.locator('[data-field=folder]').selectOption('character:B.png');ok('stable role folders remain isolated',await page.locator('.sd-focus-library-item').count()===0);
  await page.evaluate(()=>library.close());await page.evaluate(()=>library.open());
  ok('reopening does not duplicate migrated text',await page.evaluate(()=>owner.focusClock.dialogueLibrary.rows.length===2));
  await page.locator('[data-action=edit]').last().click();
  await page.locator('[data-field=text]').evaluate(el=>{window.liveEditor=el;window.beforeIME=owner.focusClock.dialogueLibrary.revision;el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.value='zhong';el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));});
  await page.waitForTimeout(350);ok('Chinese composition is not persisted halfway',await page.evaluate(()=>owner.focusClock.dialogueLibrary.revision===beforeIME));
  await page.locator('[data-field=text]').evaluate(el=>{el.value='中文输入';el.setSelectionRange(2,2);el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));});
  await page.waitForFunction(()=>owner.focusClock.dialogueLibrary.rows.at(-1).text==='中文输入');
  ok('autosave preserves the live editor and caret',await page.evaluate(()=>liveEditor===document.querySelector('textarea')&&liveEditor.selectionStart===2&&document.activeElement===liveEditor));
  await page.locator('[data-field=text]').fill('修改后的台词');await page.locator('[data-action=back]').click();
  ok('saved text edits survive reloading',await page.evaluate(()=>owner.focusClock.dialogueLibrary.rows.at(-1).text==='修改后的台词'));
  ok('return to list does not ask about unsaved edits',await page.evaluate(()=>confirmations.length===0));
  await page.locator('[data-select]').first().check();ok('checking a row stays in the list and enables batch removal',await page.locator('[data-action=remove-selected]').isEnabled()&&await page.locator('textarea').count()===0);
  await page.locator('[data-field=folder]').selectOption('character:B.png');await page.locator('[data-field=folder]').selectOption('character:A.png');
  ok('switching role clears hidden selections',await page.locator('[data-select]:checked').count()===0&&await page.locator('[data-action=remove-selected]').isDisabled());
  await page.locator('[data-action=select-all]').click();await page.evaluate(()=>allowConfirm=false);await page.locator('[data-action=remove-selected]').click();
  await page.waitForFunction(()=>confirmations.some(args=>args[0]==='删除所选台词'));
  ok('cancelled batch keeps all text',await page.evaluate(()=>owner.focusClock.dialogueLibrary.rows.length===2));
  await page.evaluate(()=>allowConfirm=true);await page.locator('[data-action=remove-selected]').click();await page.waitForFunction(()=>document.querySelector('[role=status]').textContent==='已删除 2 条台词');
  ok('batch delete removes selected text without resurrecting legacy imports on reopen',await page.evaluate(async()=>{await library.close();await library.open();return owner.focusClock.dialogueLibrary.rows.length===0;}));
  ok('list title is restored after editing',await page.locator('.sd-focus-library h3').innerText()==='自定义台词库');
  await page.evaluate(()=>library.close());await page.evaluate(()=>library.open({management:true}));
  ok('legacy original remains in data management',await page.locator('.sd-focus-library-item').count()===1);
  await page.locator('[data-action=edit]').click();ok('legacy management is read-only playback without pre-generation',await page.locator('audio').count()===1&&await page.locator('[data-action=generate],[data-action=save]').count()===0);
  await page.evaluate(()=>library.close());
  await page.evaluate(async()=>{
    const {renderFocusClockView}=await import('/qianmu-focus-view.js');const {bindFocusClockPage}=await import('/qianmu-focus-events.js');window.currentChannel='MiniMax';window.render=mode=>{
      owner.focusClock.voiceMode=mode;const data={f:owner.focusClock,remaining:1500000,total:1500000,phase:{label:'专注'},strongLocked:false,today:[],week:{days:Array.from({length:7},()=>({minutes:0})),history:[],minutes:0,count:0,readingMinutes:0},books:[],weekStart:new Date(),
        voiceContext:{hasCharacter:true,characterName:'甲',characterKey:'character:A',providerId:currentChannel,voice:{voiceId:'v'},options:[{key:'v',label:'清雅'}],selected:'v',enabled:true},voiceCharacters:[],voiceDrawerCount:0,providerLabel:currentChannel,FOCUS_CLOCK_PHASES:{focus:{label:'专注',icon:'fa-clock'}},FOCUS_CLOCK_RELATIONS:{neutral:{label:'普通'}},FOCUS_CLOCK_VOICE_FREQUENCIES:{low:{label:'低',chance:.3}},FOCUS_CLOCK_SOUND_PRESETS:{}};
      document.querySelector('main').innerHTML=renderFocusClockView(data,escape);document.querySelector('.sd-focus-settings').open=true;
      bindFocusClockPage(document.querySelector('main'),{state:()=>owner.focusClock,ui:{save(){},render:()=>render(mode)},voice:{context:()=>data.voiceContext,bind:key=>{window.chosenKey=key;}},sound:{sync(){}},clock:{}});
    };render('custom');
  });
  for(const width of mobile?[320,393]:[320,393,1100]){
    await page.setViewportSize({width,height:898});const shape=await page.evaluate(()=>{
      const inputs=[...document.querySelectorAll('.sd-focus-setting')],labels=[...document.querySelectorAll('.sd-focus-setting-grid>label>span')];
      return {heights:inputs.map(el=>el.getBoundingClientRect().height),left:labels.every(el=>getComputedStyle(el).textAlign==='left'),title:getComputedStyle(document.querySelector('.sd-focus-settings>summary')).fontSize,card:getComputedStyle(document.querySelector('.sd-focus-sound-card h3')).fontSize,
        contained:inputs.every(el=>{const box=el.getBoundingClientRect();return box.x>=0&&box.right<=innerWidth;})};
    });
    ok(`cycle fields equal height, left labels and contained at ${width}`,new Set(shape.heights).size===1&&shape.left&&shape.contained);
    ok(`cycle title matches other cards at ${width}`,shape.title===shape.card);
    const positions=await page.evaluate(()=>['longBreakMinutes','dailyGoal'].map(key=>document.querySelector(`[data-focus-setting="${key}"]`).getBoundingClientRect().toJSON()));
    ok(`daily goal aligns to long rest in the left column at ${width}`,Math.abs(positions[0].x-positions[1].x)<1&&Math.abs(positions[0].width-positions[1].width)<1);
    const picker=await page.locator('.sd-focus-voice-speaker').boundingBox(),character=await page.locator('.sd-focus-voice-character').boundingBox();
    ok(`collapsed voice name control aligns to the role field at ${width}`,Math.abs(picker.height-character.height)<1&&Math.abs(picker.y-character.y)<1&&picker.x+picker.width<=width);
    if(width===393&&process.env.QIANMU_QA_SCREENSHOTS==='1')await page.locator('.sd-focus-voice-card').screenshot({path:'dist/local-qa/focus-voice-137.png'});
  }
  ok('collapsed selection shows only the name with no visible channel badge',await page.locator('.sd-focus-voice-speaker').innerText()==='清雅'&&!await page.locator('.sd-focus-voice-provider').isVisible());
  for(const width of mobile?[320,393]:[320,393,1100]){
    await page.setViewportSize({width,height:898});await page.locator('.sd-focus-voice-speaker').click();
    const box=await page.locator('.sd-focus-voice-menu').boundingBox();
    ok(`expanded voice menu and full channel badge fit at ${width}`,box.x>=0&&box.x+box.width<=width&&await page.locator('.sd-focus-voice-provider').innerText()==='MiniMax'&&await page.locator('.sd-focus-voice-provider').evaluate(el=>el.scrollWidth<=el.clientWidth));
    await page.keyboard.press('Escape');ok(`Escape closes only the voice list at ${width}`,!await page.locator('.sd-focus-voice-menu').isVisible()&&await page.locator('.sd-focus-voice-speaker').isVisible());
  }
  await page.locator('.sd-focus-voice-speaker').click();await page.locator('[data-focus-voice-key="v"]').click();
  ok('choosing a voice uses its stable key then hides badges',await page.evaluate(()=>chosenKey==='v')&&await page.locator('.sd-focus-voice-speaker').innerText()==='清雅'&&!await page.locator('.sd-focus-voice-provider').isVisible());
  await page.evaluate(()=>{currentChannel='豆包';render('custom');});await page.locator('.sd-focus-voice-speaker').click();
  const channelStyle=await page.locator('.sd-focus-voice-provider').evaluate(el=>{const probe=document.createElement('span');probe.style.color='var(--sd-accent)';el.append(probe);const expected=getComputedStyle(probe).color,actual=getComputedStyle(el).color;probe.remove();return {expected,actual};});
  ok('expanded badges follow the current channel and theme accent',await page.locator('.sd-focus-voice-provider').innerText()==='豆包'&&channelStyle.expected===channelStyle.actual);
  await page.locator('.sd-focus-voice-menu-close').click();
  await page.locator('.sd-focus-voice-speaker').click();await page.mouse.click(1,1);
  ok('clicking outside the list dismisses it without changing the voice',!await page.locator('.sd-focus-voice-menu').isVisible()&&await page.evaluate(()=>chosenKey==='v'));
  await page.locator('.sd-focus-voice-speaker').click();await page.keyboard.press('Home');
  ok('keyboard Home moves to the first option',await page.locator('[data-focus-voice-key=""]').evaluate(el=>document.activeElement===el));
  await page.keyboard.press('End');await page.keyboard.press('Enter');
  ok('keyboard selection closes the list and preserves the chosen identity',!await page.locator('.sd-focus-voice-menu').isVisible()&&await page.evaluate(()=>chosenKey==='v'));
  await page.evaluate(()=>render('scene'));ok('scene mode has no dialogue library button',await page.locator('.sd-focus-library-open').count()===0);
  for(const name of ['merry-christmas-mr-lawrence','farewell']){
    const duration=await page.evaluate(name=>new Promise((resolve,reject)=>{
      const audio=new Audio(`/assets/focus-sounds/${name}.mp3`),timer=setTimeout(()=>reject(Error('decode timeout')),8000);
      audio.onloadedmetadata=()=>{clearTimeout(timer);resolve(audio.duration);audio.removeAttribute('src');audio.load();};audio.onerror=()=>{clearTimeout(timer);reject(Error('decode failed'));};audio.load();
    }),name);ok(`bundled ${name} decodes without external URL`,Number.isFinite(duration)&&duration>0);
  }
  assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,mobile,external,errors,paidTTS:false,nativeIndexedDB:true}));
}finally{await context.close();await browser.close();}
