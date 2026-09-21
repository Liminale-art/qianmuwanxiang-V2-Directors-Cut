// Isolated production editor with a synthetic Popup host, never a real ST account.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const release=JSON.parse(await readFile(new URL('../release-files.json',import.meta.url),'utf8'));
const allowed=new Set(release.files.filter(file=>/^qianmu-[\w-]+\.js$/.test(file)));
const css=await readFile(new URL('../style.css',import.meta.url),'utf8');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const page=await browser.newPage(),errors=[],checks=[];let external=0;
page.on('pageerror',error=>errors.push(error.message));
await page.route('**/*',async route=>{
  const url=new URL(route.request().url()),file=url.pathname.slice(1);
  if(url.origin==='https://qianmu.test'&&url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body></body></html>'});
  if(url.origin==='https://qianmu.test'&&allowed.has(file))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../'+file,import.meta.url),'utf8')});
  external++;return route.abort();
});
try{
  await page.goto('https://qianmu.test/');await page.addStyleTag({content:css});
  await page.addStyleTag({content:'body{margin:0;padding:8px;box-sizing:border-box} .fixture-popup{width:min(100%,640px);box-sizing:border-box;margin:auto} .fixture-actions{display:flex;flex-wrap:wrap;gap:6px} .fixture-actions button{min-height:36px}'});
  await page.evaluate(async()=>{
    window.world=await import('./qianmu-world-shot.js');
    const core=await import('./qianmu-storyboard.js');
    window.shot=core.normalizeStoryboardShotSpec({subject:'厨房',characters:[{id:'alice',name:'Alice',identity:['blue hair']}],promptAtoms:{global:['kitchen']}});
    window.values={tags:{global:'kitchen, soft light',negative:'blur',characters:[{character_id:'alice',positive:'blue hair'}]}};
    window.context={POPUP_TYPE:{CONFIRM:1},Popup:class{
      constructor(content,type,unused,options){this.content=content;this.options=options;}
      show(){return new Promise(resolve=>{
        const popup=document.createElement('section');popup.className='fixture-popup';popup.append(this.content);
        const actions=document.createElement('div');actions.className='fixture-actions';
        const buttons=[{text:this.options.okButton,result:1},{text:this.options.cancelButton,result:0},...(this.options.customButtons||[])];
        for(const item of buttons){const button=document.createElement('button');button.textContent=item.text;button.onclick=()=>{popup.remove();resolve(item.result);};actions.append(button);}
        popup.append(actions);document.body.append(popup);
      });}
    }};
    window.start=(mode)=>{
      window.llm=0;window.manual=0;window.result=undefined;window.failure='';
      const options={shot:window.shot,context,guard:async()=>true,promptFormats:['tags'],useManualStyle:()=>{window.manual++;},
        prepareRenderings:async()=>{window.llm++;if(mode==='failed')throw Error('格式不匹配');return structuredClone(window.values);}};
      const pending=mode==='confirm'?world.openWorldShotConfirmation(options):world.openWorldPromptRenderingEditor({...options,manual:mode==='manual'});
      pending.then(value=>{window.result=value;},error=>{window.failure=error.message;});
    };
  });
  for(const width of [320,393,1280])for(const mode of ['confirm','manual','failed','success','cancel']){
    await page.setViewportSize({width,height:900});await page.evaluate(mode=>start(mode),mode);
    if(mode==='confirm'){
      await page.getByRole('button',{name:'手动填写（当前方案）',exact:true}).click();
    }
    await page.locator('[data-world-format]').waitFor();
    const overflow=await page.evaluate(()=>{const el=document.querySelector('.sd-world-shot-dialog');return el.scrollWidth-el.clientWidth;});
    assert.ok(overflow<=1,`${width}/${mode} editor overflow ${overflow}`);
    if(mode==='cancel'){
      await page.getByRole('button',{name:'取消',exact:true}).click();
      await page.waitForFunction(()=>window.result===null);assert.equal(await page.evaluate(()=>manual),0);
    }else{
      if(mode==='failed')assert.match(await page.locator('[role=status]').innerText(),/手动填写将使用当前方案/);
      if(['manual','confirm','failed'].includes(mode)){
        await page.locator('[data-world-global]').fill('kitchen, soft light');
        await page.locator('[data-world-character]').fill('blue hair');
      }
      await page.getByRole('button',{name:'确认生成',exact:true}).click();
      await page.waitForFunction(()=>window.result?.promptRenderingPack||window.failure);
      const result=await page.evaluate(()=>({manual,llm,failure,hasPack:Boolean(window.result?.promptRenderingPack)}));
      assert.equal(result.failure,'');assert.equal(result.hasPack,true);
      assert.equal(result.manual,mode==='success'?0:1);assert.equal(result.llm,['manual','confirm'].includes(mode)?0:1);
    }
    checks.push(`${width}/${mode}`);
  }
  assert.deepEqual(errors,[]);assert.equal(external,0);
  console.log(JSON.stringify({checks:checks.length,errors,external,productionWrites:false,modelRequests:0,host:'synthetic Popup, real editor and DOM events'}));
}finally{await browser.close();}
