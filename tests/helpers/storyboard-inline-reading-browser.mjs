import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {storyboardFunctionSource as section} from './storyboard-form-fixture.mjs';

// Isolated real DOM/layout checks; no ST account, private prose or paid request.
export async function checkStoryboardInlineReadingBrowser(page) {
  const source=await readFile(new URL('../../qianmu-storyboard-inline-reading.js',import.meta.url),'utf8');
  const css=await readFile(new URL('../../style.css',import.meta.url),'utf8');
  await page.setContent('<!doctype html><style>body{margin:0}#chat{padding:12px}.mes_text{max-width:100%}</style><main id="chat"><article class="mes"><div class="mes_text"></div></article></main>');
  await page.addStyleTag({content:css});
  await page.evaluate(async({source,markup})=>{
    window.reading=await import('data:text/javascript,'+encodeURIComponent(source));
    Object.assign(window,{htmlEscape:value=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;'),
      storyboardSafeUrl:value=>value,storyboardInlineVideoForRecord:()=>null,storyboardInlineSlotKey:()=>'',snip:value=>value});
    window.eval(markup);
  },{source,markup:section('storyboardInlineRecordMarkup')});
  const cases=[];
  for(const html of ['<p>Alpha</p><p>Beta</p><p>Gamma</p>',
    '<div class="outer"><div><p>Alpha</p><p>Beta</p><p>Gamma</p></div></div>',
    '<p><em>Alpha</em><br><strong>Beta</strong><br>Gamma</p>',
    'Alpha\nBeta\nGamma',
    '<div>Alpha<br>Beta<br>Gamma</div>',
    '<p>Alpha</p><div hidden>Invisible</div><p style="display:none">Invisible</p><div class="mes_reasoning">Ignored</div><p>Beta</p><p>Gamma</p>']) {
    const result=await page.evaluate(html=>{
      const root=document.querySelector('.mes_text');root.innerHTML=html;
      const paragraphs=reading.storyboardProseParagraphs(root);
      const score=(anchor,text,index)=>text===anchor.paragraphText?70+(anchor.paragraphIndex===index?15:0):0;
      const resolve=()=>reading.resolveStoryboardProseAnchor(root,[{paragraphAnchor:{paragraphText:'Beta',paragraphIndex:1}}],{score});
      const first=document.createElement('div');first.className='sd-storyboard-inline';first.dataset.qianmuTransient='storyboard';first.textContent='Image B1';
      const tails=new Map();reading.insertStoryboardProseImage(root,resolve(),first,tails);
      const second=document.createElement('div');second.className='sd-storyboard-inline';second.dataset.qianmuTransient='storyboard';second.textContent='Image B2';
      reading.insertStoryboardProseImage(root,resolve(),second,tails);
      const flat=[];const walk=node=>{if(node.nodeType===3&&node.nodeValue.trim())flat.push(node.nodeValue.trim());else for(const child of node.childNodes)walk(child);};walk(root);
      const missing=reading.resolveStoryboardProseAnchor(root,[{paragraphAnchor:{paragraphText:'Unrelated',paragraphIndex:1}}],{score});
      const lost=document.createElement('div');lost.textContent='WRONG';
      const inserted=reading.insertStoryboardProseImage(root,missing,lost,tails);
      first.remove();second.remove();
      return {paragraphs:paragraphs.map(item=>item.text),after:reading.storyboardProseParagraphs(root).map(item=>item.text),flat,inserted};
    },html);
    assert.deepEqual(result.paragraphs,['Alpha','Beta','Gamma']);assert.deepEqual(result.after,result.paragraphs);
    const beta=result.flat.indexOf('Beta'),b1=result.flat.indexOf('Image B1'),b2=result.flat.indexOf('Image B2'),gamma=result.flat.indexOf('Gamma');
    assert.ok(beta<b1&&b1<b2&&b2<gamma,JSON.stringify(result));assert.equal(result.inserted,false);
    cases.push('paragraph '+cases.length);
  }
  const collision=await page.evaluate(()=>{
    const root=document.querySelector('.mes_text');root.innerHTML='<p>Same</p><p>Same</p>';
    return reading.resolveStoryboardProseAnchor(root,[{paragraphAnchor:{paragraphText:'Same'}}],{score:(_a,text)=>text==='Same'?70:0}).fallback;
  });assert.equal(collision,true);
  for(const width of [320,390,960]) {
    await page.setViewportSize({width,height:800});
    const layout=await page.evaluate(async()=>{
      const root=document.querySelector('.mes_text');root.innerHTML='<p>Paragraph</p>';
      for(const name of ['B1','B2','B3']){
        const wrapper=document.createElement('div');wrapper.className='sd-storyboard-inline sd-storyboard-reading-shot is-completed';
        const record={id:name,url:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="silver"/></svg>')};
        wrapper.innerHTML='<div class="sd-storyboard-inline-reel">'+storyboardInlineRecordMarkup(record,{key:name,records:[record,{id:'old'}]})+'</div>';
        wrapper.querySelector('figure').classList.add('actions-open');root.append(wrapper);
      }
      await Promise.all([...root.querySelectorAll('img')].map(image=>image.decode()));
      return [...root.querySelectorAll('figure,.sd-storyboard-inline-actions,.sd-storyboard-inline-version')].map(node=>{
        const r=node.getBoundingClientRect();return {x:r.x,right:r.right,top:r.top,bottom:r.bottom,figure:node.tagName==='FIGURE'};
      });
    });
    assert.ok(layout.every(rect=>rect.x>=0&&rect.right<=width),`${width}: inline overflow`);
    const figures=layout.filter(rect=>rect.figure);assert.equal(figures.length,3);
    assert.ok(figures[0].bottom<=figures[1].top&&figures[1].bottom<=figures[2].top);
    cases.push(`layout ${width}`);
  }
  const integrated=await page.evaluate(async functions=>{
    Object.assign(window,reading);
    const root=document.querySelector('.mes_text');root.innerHTML='<p>Alpha</p><p>Beta</p><p>Gamma</p>';
    root.closest('.mes').setAttribute('mesid','4');
    const image='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40"/>');
    const records=['A1','B1','B2','B3'].map((id,index)=>({id,variantRootId:id,planShotId:id,taskId:'job-'+id,inline:true,
      chatKey:'chat',floor:4,swipeId:0,messageHash:'body',url:image,createdAt:1,imageIndex:0,
      paragraphAnchor:{paragraphIndex:index===0?0:1,paragraphText:index===0?'Alpha':'Beta'}}));
    const state={enabled:true,shotPlans:[],logs:[]},store={},context={chatMetadata:{},chat:[null,null,null,null,{mes:'body'}]};
    const calls=[];
    Object.assign(window,{storyboardInlineRecordValid:record=>record.inline,storyboardGalleryRecords:()=>records,
      storyboardState:()=>state,getChatKey:()=> 'chat',ctx:()=>context,getChatStore:()=>store,hashText:value=>value,
      storyboardAdmissionEpoch:1,storyboardReconcileGalleryLinks(){},storyboardReconcileShotPlans(){},storyboardInjectMessageButtons(){},
      proseFloorTools:{refresh(){},collectionClick:()=>false},storyboardCollapsedInlineFloors:new Set(),
      sortStoryboardInlineRecords:items=>items,storyboardCleanMessageText:value=>String(value||'').trim(),
      scoreStoryboardParagraphAnchor:(anchor,text,index)=>text===anchor.paragraphText?70+(anchor.paragraphIndex===index?15:0):0,
      storyboardReleaseInlineVideoPlaybacks(){},applyQianmuIcons(){},saveMetadata:async()=>calls.push('save'),
      storyboardOpenLightbox:record=>calls.push(['preview',record.id]),storyboardOpenImageInfo:record=>calls.push(['info',record.id]),
      storyboardOpenImageLog:record=>calls.push(['log',record.id]),toast:()=>calls.push('warning'),
      STORYBOARD_INLINE_MARK:'',storyboardInlineSlotKey:()=>''});
    window.eval(functions);
    const ids=()=>[...root.querySelectorAll('figure[data-storyboard-record]')].map(node=>node.dataset.storyboardRecord);
    const click=async(id,action)=>{const button=root.querySelector(`figure[data-storyboard-record="${id}"] [data-storyboard-chat-action="${action}"]`);
      await storyboardOnChatClick({target:button,preventDefault(){},stopPropagation(){}});};
    storyboardRenderInlineImages();const initial=ids();
    const oldWrapper=root.querySelector('figure[data-storyboard-record="B2"]').closest('.sd-storyboard-inline');
    storyboardRenderInlineImages();const reused=oldWrapper===root.querySelector('figure[data-storyboard-record="B2"]').closest('.sd-storyboard-inline');
    const source=records.find(record=>record.id==='B2');
    records.push({...source,id:'B2-new-1',taskId:'redraw',createdAt:10,imageIndex:1},{...source,id:'B2-new-0',taskId:'redraw',createdAt:10,imageIndex:0});
    storyboardRenderInlineImages();const redraw=ids();
    await click('B2-new-0','previous-version');const selected=ids();
    storyboardRenderInlineImages();const reopened=ids();
    await click('B2','image-info');await click('B2','image-log');
    await click('B2','collapse');const folded=[...root.querySelectorAll('.sd-storyboard-inline.is-collapsed')].length;
    const button=root.querySelector('.sd-storyboard-inline.is-collapsed [data-storyboard-chat-action="expand"]');
    await storyboardOnChatClick({target:button,preventDefault(){},stopPropagation(){}});
    const unfolded=[...root.querySelectorAll('.sd-storyboard-inline.is-collapsed')].length;
    records.push({...source,id:'B2-latest',taskId:'newest',createdAt:20});storyboardRenderInlineImages();
    const latest=ids();state.enabled=false;storyboardRenderInlineImages();const removed=root.querySelectorAll('.sd-storyboard-inline').length;
    return {initial,reused,redraw,selected,reopened,latest,folded,unfolded,removed,calls,prose:context.chat[4].mes,recordCount:records.length};
  },['storyboardMessageParagraphNodes','storyboardInlineAnchorNode','storyboardReadingShots','storyboardRenderInlineImages','storyboardInsertInlineWrapper',
    'storyboardSelectInlineVersion','storyboardCaptureInlineView','storyboardRestoreInlineView','storyboardDisposeInlineWrapper','storyboardOnChatClick'].map(section).join('\n'));
  assert.deepEqual(integrated.initial,['A1','B1','B2','B3']);assert.equal(integrated.reused,true);
  assert.deepEqual(integrated.redraw,['A1','B1','B2-new-0','B3']);
  assert.deepEqual(integrated.selected,integrated.initial);assert.deepEqual(integrated.reopened,integrated.initial);
  assert.deepEqual(integrated.latest,['A1','B1','B2-latest','B3']);
  assert.deepEqual(integrated.calls,['save',['info','B2'],['log','B2']]);
  assert.equal(integrated.folded,1);assert.equal(integrated.unfolded,0);assert.equal(integrated.removed,0);
  assert.equal(integrated.prose,'body');assert.equal(integrated.recordCount,7);
  cases.push('actual renderer, click routing, redraw, persisted version, collapse, disable');
  return {cases:cases.length+1,passed:true,limits:'Isolated real DOM; no live ST/server or paid generation.'};
}
