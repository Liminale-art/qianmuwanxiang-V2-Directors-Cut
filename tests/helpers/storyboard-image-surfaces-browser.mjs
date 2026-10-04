import assert from 'node:assert/strict';
import {storyboardFunctionSource} from './storyboard-form-fixture.mjs';

const functions = ['storyboardCloseImageInfo','storyboardEditPrompt','storyboardCloseLightbox','storyboardOpenLightbox',
  'storyboardMediaTagChipMarkup','storyboardMediaTagEditorMarkup','storyboardMediaTagValues','storyboardPersistMediaTagEditor','storyboardMediaTagFilterSuggestions','storyboardBindMediaTagEditors',
  'storyboardRecordParameterLabel','storyboardSafeUrl','storyboardRecordChatKey',
  'storyboardVideoDraftModeLabel','storyboardEnsureVideoDraftRuntime','storyboardCloseVideoDraftEditor',
  'storyboardVideoDraftSourceRecord','storyboardVideoDraftShotReader','storyboardVideoDraftCandidateRecords',
  'storyboardVideoDraftEditorMarkup','storyboardOpenVideoDraftEditor'].map(storyboardFunctionSource).join('\n');

// Real root functions, native dialogs and appearance owner. The only replacements
// are account/storage/provider edges; every production write is forbidden.
export async function checkStoryboardImageSurfacesBrowser(page) {
  const checks=[];
  const ok=(label,value)=>{assert.ok(value,label);checks.push(label);};
  await page.evaluate(async source=>{
    const [utils,storyboard,info,characters,appearance,preferences,icons,membership,chatSource,shotReader,drafts]=await Promise.all([
      import('/qianmu-storyboard-utils.js'),import('/qianmu-storyboard.js'),import('/qianmu-image-info-view.js'),
      import('/qianmu-character-shot-view.js'),import('/qianmu-appearance-session.js'),import('/qianmu-appearance-settings.js'),
      import('/qianmu-icon-renderer.js'),import('/qianmu-gallery-membership.js'),import('/qianmu-current-chat-source.js'),
      import('/qianmu-gallery-shot-reader.js'),import('/qianmu-video-draft.js')]);
    Object.assign(window,utils,storyboard,info,icons,membership,chatSource,shotReader);
    Object.assign(window,await import('/qianmu-image-zoom.js'));
    const state=storyboard.createStoryboardDefaults();state.enabled=true;state.source='comfy';
    const store={},metadata={story_director_liminale:store};
    const host={chatId:'surface-fixture',characterId:0,characters:[{avatar:'fixture.png',chat:'surface-fixture'}],chatMetadata:metadata,chat:[{mes:'Synthetic test prose.'}]};
    const forbidden=()=>{calls.forbidden++;throw Error('Production mutation or provider request forbidden');};
    const shot=storyboard.normalizeStoryboardShotSpec({id:'shot-1',scene:'A person stands in a kitchen.',
      intent:{summary:'A person stands in a kitchen.'},characters:[{id:'person-1',name:'Test person',identity:['red hair'],outfit:['blue coat'],action:['standing'],spatial:{region:'center',crop:'full',center:[.5,.5]}}]});
    const canvas=document.createElement('canvas');canvas.width=420;canvas.height=620;
    const paint=canvas.getContext('2d');paint.fillStyle='#8fa69b';paint.fillRect(0,0,420,620);
    const url=canvas.toDataURL('image/png');
    const snapshot={source:'comfy',profile:{...structuredClone(state.profiles.comfy),model:'comfy-workflow'},prompt:'red hair, blue coat, kitchen',negative:'blur',
      payload:{prompt:'red hair, blue coat, kitchen',negative:'blur',shotSpec:shot,parameters:{}}};
    Object.assign(window,{settings:{theme:'light'},calls:{forbidden:0,redraw:0,copy:0},notices:[],fixtureState:state,
      records:[{id:'frame-1',chatKey:host.chatId,floor:0,url,source:'comfy',finalPrompt:snapshot.prompt,negative:snapshot.negative,inline:true},
        {id:'frame-2',chatKey:host.chatId,floor:0,url,source:'comfy',finalPrompt:'second frame',negative:'blur',inline:true}],
      snapshots:new Map(),storyboardImageInfoView:null,storyboardImageInfoOpening:0,
      storyboardAdmissionEpoch:1,storyboardSnapshotEpoch:1,storyboardLightboxEpoch:0,storyboardLightboxEl:null,
      storyboardVideoDraftOpenSequence:0,storyboardVideoDraftStore:null,storyboardVideoDraftEditorEl:null,storyboardVideoDraftEditor:null,
      optionalServiceState:{status:'ready',services:['minimax-h3']},blobStore:{},
      ctx:()=>host,getChatKey:()=>host.chatId,getChatStore:()=>store,storyboardState:()=>state,clone:structuredClone,
      storyboardGalleryRecords:()=>records,storyboardGalleryCollections:()=>window.fixtureCollections||[],
      storyboardReadSnapshotForRecord:async record=>{if(window.snapshotGate?.id===record.id)await snapshotGate.promise;return structuredClone(snapshots.get(record.id));},
      summarizeGalleryRecords:()=>({knownTags:[]}),galleryRecordSourceCharacter:()=> 'Source CHAR',storyboardUpdateGalleryNarrative:()=>({sourceFor:()=>null}),
      renderRunningHubTaskUsage:()=>'',toast:(text,tone)=>notices.push({text,tone}),
      coreadCopyText:async text=>{calls.copy++;calls.lastCopy=text;},saveMetadata:forbidden,saveSettings:forbidden,renderModal:forbidden,
      storyboardGenerate:forbidden,storyboardQueueJob:forbidden,storyboardCallCompiler:forbidden,
      storyboardEnsureVideoCoordinator:forbidden,storyboardRefreshVideoGallery:forbidden,
      storyboardDirectorWorkOrderForRecord:async()=>null,
      storyboardVideoRegion:()=> 'global',storyboardVideoCredentialConfigured:async()=>true,
      storyboardVideoOperationIssueLabel:value=>String(value),refreshOptionalServiceState:async()=>({...optionalServiceState}),
      STORYBOARD_VIDEO_DRAFT_MODE_LABELS:{auto:'自动匹配',i2va:'当前画面为首帧',fl2va:'首尾帧',t2va:'纯文本引导',l2va:'尾帧引导',ref2va:'参考素材'},
      STORYBOARD_VIDEO_REFERENCE_ROLE_LABELS:{subject_reference:'主体',style_reference:'风格',motion_reference:'动作'},
      storyboardRedrawRecord:async(record,options)=>{calls.redraw++;if(window.redrawGate)await redrawGate.promise;await options.verify();
        calls.lastSnapshot=structuredClone(options.snapshotOverride);return window.acceptRedraw===true;},
      storyboardDownloadRecord:forbidden,storyboardRemoveImage:forbidden,storyboardRenderInlineImages:forbidden});
    records.forEach(record=>snapshots.set(record.id,structuredClone(snapshot)));
    const draftStore={list:async()=>[],load:async()=>null,save:forbidden};
    window.featureRuntime={load:async name=>{
      if(window.runtimeGate?.name===name){const gate=runtimeGate;gate.entered=true;await gate.promise;if(gate.fail)throw Error('Delayed fixture runtime failure');}
      if(name==='imageAdmission')return {resolveImageAccountNamespace:async()=> 'st-user:surface-fixture'};
      if(name==='imageZoom')return import('/qianmu-image-zoom.js');
      if(name==='characterShotEditor')return characters;
      if(name==='videoDraft')return drafts;
      if(name==='videoDraftStore')return {createVideoDraftStoreAdapter:()=>draftStore};
      const modules={videoPrompt:'qianmu-video-prompt',videoReadiness:'qianmu-video-readiness',videoPricing:'qianmu-video-pricing',videoConfirmation:'qianmu-video-confirmation'};
      if(!modules[name])throw Error('Unexpected runtime: '+name);
      return import('/'+modules[name]+'.js');
    }};
    window.appearanceSession=appearance.createQianmuAppearanceSession({readSettings:()=>settings,loadStyles:()=>({promise:Promise.resolve(true),cancel(){}})});
    window.setAppearance=async(family,mode='light')=>{settings.appearance=preferences.updateAppearancePreferences(settings,{family,mode});await appearanceSession.sync();};
    window.openInfo=record=>{window.infoResult=storyboardEditPrompt({record:record||records[0]});};
    window.setInput=(selector,value)=>{const field=document.querySelector(selector);field.value=value;field.dispatchEvent(new Event('input',{bubbles:true}));};
    window.deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
    window.rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    window.inspectSurface=selector=>{
      const node=document.querySelector(selector),box=rect(node),css=getComputedStyle(node);
      const fields=[...node.querySelectorAll('textarea,input,select')].filter(item=>item.getClientRects().length);
      return {box,overflow:node.scrollWidth-node.clientWidth,modal:node.matches(':modal'),color:css.color,background:css.backgroundColor,
        family:node.dataset.qmFamily,mode:node.dataset.qmMode,radius:css.borderTopLeftRadius,
        fields:fields.map(field=>({box:rect(field),color:getComputedStyle(field).color,background:getComputedStyle(field).backgroundColor})),
        footer:node.querySelector(':scope > footer')?rect(node.querySelector(':scope > footer')):null};
    };
    (0,eval)(source);
  },functions);
  const viewport=(value,width,height)=>value.left>=-.5&&value.top>=-.5&&value.right<=width+.5&&value.bottom<=height+.5;
  const original=await page.evaluate(()=>JSON.stringify([records,[...snapshots]]));
  for(const family of ['classic','glass','editorial'])for(const mode of ['light','dark'])for(const width of [320,390,960]) {
    const height=width===320?568:800,label=`${family}/${mode}/${width}`;
    await page.setViewportSize({width,height});
    await page.evaluate(async({family,mode})=>{await setAppearance(family,mode);openInfo();},{family,mode});
    await page.waitForSelector('.sd-image-info-dialog');
    const info=await page.evaluate(()=>inspectSurface('.sd-image-info-dialog'));
    ok(label+' info native dialog',info.modal);
    ok(label+' info controls render local visible glyphs',await page.evaluate(()=>{
      const icons=[...document.querySelectorAll('.sd-image-info-dialog button i')];
      return icons.length>5&&icons.every(icon=>{
        const svg=icon.querySelector('svg.qm-glyph-svg');
        if(!svg)return false;
        const box=svg.getBoundingClientRect();
        return !icon.checkVisibility()||(box.width>0&&box.height>0&&[...svg.children].some(group=>getComputedStyle(group).display!=='none'&&group.children.length>0));
      });
    }));
    ok(label+' info contained '+JSON.stringify(info.box),viewport(info.box,width,height)&&info.overflow<=1);
    ok(label+' info footer visible',viewport(info.footer,width,height));
    ok(label+' ST background isolated',info.background!=='rgb(25, 27, 29)'&&info.color!=='rgb(230, 230, 230)');
    ok(label+' fields contained horizontally',info.fields.every(field=>field.box.left>=info.box.left&&field.box.right<=info.box.right));
    await page.locator('.sd-image-info-characters > summary').click();
    const characterFields=await page.evaluate(()=>inspectSurface('.sd-image-info-dialog').fields);
    ok(label+' character inputs contained',characterFields.every(field=>field.box.left>=0&&field.box.right<=width+.5));
    ok(label+' character inputs inherit theme',characterFields.every(field=>field.background!=='rgb(12, 14, 16)'&&field.color!=='rgb(230, 230, 230)'));
    await page.locator('.sd-image-info-characters > summary').click();
    await page.evaluate(()=>setInput('[data-image-info-positive]','Unsaved image draft'));
    await page.locator('[data-image-info-action=preview]').click();
    await page.waitForSelector('.sd-storyboard-lightbox');
    const lightbox=await page.evaluate(()=>{
      const root=document.querySelector('.sd-storyboard-lightbox');return {...inspectSurface('.sd-storyboard-lightbox'),
        stage:rect(root.querySelector('.sd-storyboard-lightbox-stage')),image:rect(root.querySelector('img')),
        close:rect(root.querySelector('.sd-storyboard-lightbox-close')),buttons:[...root.querySelectorAll('button')].map(button=>button.getAttribute('aria-label'))};
    });
    ok(label+' lightbox native/full viewport',lightbox.modal&&viewport(lightbox.box,width,height));
    ok(label+' lightbox image and close contained',viewport(lightbox.image,width,height)&&viewport(lightbox.close,width,height));
    ok(label+' full screen only viewing',lightbox.buttons.join(',')==='关闭');
    ok(label+' full screen stacks above the retained detail',await page.evaluate(()=>Boolean(document.elementFromPoint(innerWidth/2,innerHeight/2)?.closest('.sd-storyboard-lightbox'))));
    await page.mouse.move(width/2,height/2);await page.mouse.wheel(0,-350);
    await page.waitForFunction(()=>Number(document.querySelector('.sd-storyboard-lightbox-stage')?.dataset.imageZoom)>1);
    ok(label+' wheel enlarges only image',await page.evaluate(()=>document.querySelector('.sd-storyboard-lightbox').matches(':modal')&&Number(document.querySelector('.sd-storyboard-lightbox-stage').dataset.imageZoom)>1&&document.documentElement.scrollWidth<=innerWidth));
    await page.locator('.sd-storyboard-lightbox-stage').dblclick({position:{x:width/2,y:height/2}});
    const pinch=await page.evaluate(()=>{
      const stage=document.querySelector('.sd-storyboard-lightbox-stage'),before=Number(stage.dataset.imageZoom),y=innerHeight/2;
      const fire=(type,id,x)=>stage.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerType:'touch',pointerId:id,clientX:x,clientY:y}));
      fire('pointerdown',21,innerWidth/2-40);fire('pointerdown',22,innerWidth/2+40);
      fire('pointermove',21,innerWidth/2-80);fire('pointermove',22,innerWidth/2+80);
      const after=Number(stage.dataset.imageZoom);fire('pointerup',21,innerWidth/2-80);fire('pointerup',22,innerWidth/2+80);
      return {before,after,stillOpen:document.querySelector('.sd-storyboard-lightbox').matches(':modal')};
    });
    ok(label+' two pointers pinch image without closing or changing frame',pinch.before===1&&pinch.after===2&&pinch.stillOpen);
    await page.keyboard.press('Escape');
    ok(label+' lightbox return keeps prompt draft',await page.locator('[data-image-info-positive]').inputValue()==='Unsaved image draft');
    await page.locator('[data-image-info-action=motion]').click();
    await page.waitForSelector('.sd-storyboard-video-draft-layer');
    const motion=await page.evaluate(()=>{
      const root=document.querySelector('.sd-storyboard-video-draft-layer'),editor=root.querySelector('.sd-storyboard-video-draft-editor');
      return {root:inspectSurface('.sd-storyboard-video-draft-layer'),editor:rect(editor),overflow:editor.scrollWidth-editor.clientWidth,
        footer:rect(editor.querySelector(':scope > footer')),infoRetained:Boolean(document.querySelector('.sd-image-info-dialog'))};
    });
    ok(label+' motion native stacked over info',motion.root.modal&&motion.infoRetained);
    ok(label+' motion viewport '+JSON.stringify(motion.editor),viewport(motion.editor,width,height)&&motion.overflow<=1);
    ok(label+' motion footer visible',viewport(motion.footer,width,height));
    ok(label+' motion theme isolated',motion.root.background!=='rgb(25, 27, 29)');
    await page.locator('.sd-storyboard-video-draft-close').click();
    ok(label+' motion return keeps prompt draft',await page.locator('[data-image-info-positive]').inputValue()==='Unsaved image draft');
    await page.locator('.sd-image-info-dialog > footer [data-image-info-close]').click();
    ok(label+' cancel closes',await page.locator('.sd-image-info-dialog').count()===0);
    ok(label+' cancel has no writes',await page.evaluate(()=>calls.forbidden===0&&calls.redraw===0));
  }
  ok('matrix never mutates saved records/snapshots',await page.evaluate(()=>JSON.stringify([records,[...snapshots]]))===original);
  for(const action of ['preview','motion'])for(const fail of [false,true]){
    await page.evaluate(({action,fail})=>{
      window.runtimeGate={name:action==='preview'?'imageZoom':'videoDraft',fail,...deferred()};
      window.childOpenName=action==='preview'?'storyboardOpenLightbox':'storyboardOpenVideoDraftEditor';
      window.childOpenOriginal=window[childOpenName];
      window[childOpenName]=(...args)=>window.childOpenResult=childOpenOriginal(...args);
      window.noticesBeforeChildOpen=notices.length;openInfo();
    },{action,fail});
    await page.waitForSelector('.sd-image-info-dialog');
    await page.locator(`[data-image-info-action=${action}]`).click();
    await page.waitForFunction(()=>runtimeGate.entered===true);
    await page.locator('.sd-image-info-dialog > footer [data-image-info-close]').click();
    await page.evaluate(async()=>{runtimeGate.resolve();await childOpenResult;});
    const label=`cancel delayed ${action} ${fail?'failed':'successful'} load`;
    ok(label+' does not resurrect a child dialog',await page.evaluate(()=>!document.querySelector('.sd-image-info-dialog,.sd-storyboard-lightbox,.sd-storyboard-video-draft-layer')&&!storyboardLightboxEl&&!storyboardVideoDraftEditorEl));
    ok(label+' stays silent and has no writes',await page.evaluate(()=>notices.length===noticesBeforeChildOpen&&calls.forbidden===0&&calls.redraw===0));
    await page.evaluate(()=>{window[childOpenName]=childOpenOriginal;delete window.runtimeGate;delete window.childOpenName;delete window.childOpenOriginal;delete window.childOpenResult;delete window.noticesBeforeChildOpen;});
  }
  await page.evaluate(()=>{openInfo();});await page.waitForSelector('.sd-image-info-dialog');
  await page.evaluate(()=>setInput('[data-image-info-positive]','Copy exactly this edited prompt'));
  await page.locator('[data-image-info-copy=positive]').click();
  await page.waitForFunction(()=>document.querySelector('.sd-image-info-status')?.textContent==='已复制');
  ok('copy reads current input and never generates',await page.evaluate(()=>calls.lastCopy==='Copy exactly this edited prompt'&&calls.redraw===0&&calls.forbidden===0));
  await page.evaluate(()=>{window.redrawGate=deferred();const button=document.querySelector('[data-image-info-generate]');button.click();button.click();button.click();});
  await page.waitForFunction(()=>calls.redraw===1);
  ok('rapid generate reaches exactly one stub submit',await page.evaluate(()=>calls.redraw===1));
  await page.locator('.sd-image-info-dialog > footer [data-image-info-close]').click();
  await page.evaluate(async()=>{redrawGate.resolve();await infoResult;delete window.redrawGate;});
  ok('cancel during pending submit drops local draft',await page.evaluate(()=>!calls.lastSnapshot&&calls.forbidden===0&&!document.querySelector('.sd-image-info-dialog')));
  ok('cancel pending keeps original untouched',await page.evaluate(()=>JSON.stringify([records,[...snapshots]]))===original);
  await page.evaluate(()=>openInfo());await page.waitForSelector('.sd-image-info-dialog');
  await page.evaluate(()=>{setInput('[data-image-info-positive]','');document.querySelector('[data-image-info-generate]').click();});
  await page.waitForFunction(()=>document.querySelector('.sd-image-info-status')?.textContent.includes('请填写'));
  ok('validation error targets visible owner status',await page.locator('.sd-image-info-status').isVisible());
  ok('nested character status not used',await page.locator('.sd-character-shot-status').textContent()==='');
  await page.locator('.sd-image-info-characters > summary').click();
  await page.evaluate(()=>{setInput('[data-image-info-positive]','Manual prompt retained');setInput('[data-shot-character-field=identity]','silver hair');});
  ok('character edits reveal explicit undo',await page.locator('[data-image-info-reset-characters]').isVisible());
  await page.locator('[data-image-info-generate]').click();
  await page.waitForFunction(()=>document.querySelector('.sd-image-info-status')?.textContent.includes('撤销人物修改'));
  ok('unmatched character edit is actionable and makes no submit',await page.evaluate(()=>calls.redraw===1));
  await page.locator('[data-image-info-reset-characters]').click();
  await page.waitForFunction(()=>document.querySelector('.sd-image-info-dialog')?.dataset.charactersChanged==='false');
  ok('undo restores only character input',await page.locator('[data-shot-character-field=identity]').inputValue()==='red hair');
  ok('undo retains independent prompt edit',await page.locator('[data-image-info-positive]').inputValue()==='Manual prompt retained');
  ok('embedded editor has no unbound latest button',await page.locator('.sd-character-shot-latest').count()===0);
  await page.locator('.sd-image-info-dialog > footer [data-image-info-close]').click();
  await page.evaluate(()=>{window.snapshotGate={id:'frame-1',...deferred()};openInfo(records[0]);});
  await page.evaluate(()=>openInfo(records[1]));await page.waitForSelector('.sd-image-info-dialog');
  await page.evaluate(()=>setInput('[data-image-info-positive]','Newer opening edited draft'));
  await page.evaluate(async()=>{snapshotGate.resolve();await new Promise(resolve=>setTimeout(resolve,20));delete window.snapshotGate;});
  ok('late older opening cannot replace new edits',await page.locator('[data-image-info-positive]').inputValue()==='Newer opening edited draft');
  await page.locator('.sd-image-info-dialog > footer [data-image-info-close]').click();
  await page.evaluate(()=>{window.snapshotGate={id:'frame-1',...deferred()};openInfo(records[0]);});
  await page.evaluate(()=>{storyboardCloseImageInfo();snapshotGate.resolve();});
  await page.evaluate(async()=>{await infoResult;delete window.snapshotGate;});
  ok('cancel pending opening does not resurrect dialog',await page.locator('.sd-image-info-dialog').count()===0);
  await page.evaluate(()=>openInfo());await page.waitForSelector('.sd-image-info-dialog');
  const beforeChanged=await page.evaluate(()=>{window.savedPrompt=records[0].finalPrompt;records[0].finalPrompt='Original changed elsewhere';return calls.redraw;});
  await page.locator('[data-image-info-generate]').click();
  await page.waitForFunction(()=>document.querySelector('.sd-image-info-status')?.textContent.includes('已变化'));
  ok('changed original blocks submit without losing draft',await page.evaluate(before=>calls.redraw===before&&document.querySelector('[data-image-info-positive]').value==='red hair, blue coat, kitchen',beforeChanged));
  await page.locator('.sd-image-info-dialog > footer [data-image-info-close]').click();
  await page.evaluate(()=>{records[0].finalPrompt=savedPrompt;delete window.savedPrompt;openInfo();});await page.waitForSelector('.sd-image-info-dialog');
  await page.evaluate(()=>{window.acceptRedraw=true;setInput('[data-image-info-positive]','Exactly one draft submission');const button=document.querySelector('[data-image-info-generate]');button.click();button.click();});
  await page.waitForFunction(()=>!document.querySelector('.sd-image-info-dialog'));
  ok('accepted local callback closes with one extra invocation',await page.evaluate(()=>calls.redraw===2&&calls.lastSnapshot.payload.prompt==='Exactly one draft submission'));
  ok('accepted callback does not overwrite original',await page.evaluate(()=>JSON.stringify([records,[...snapshots]]))===original);
  await page.evaluate(()=>{
    records[0].source='novel';window.styleGate=deferred();
    window.storyboardApplyRecordStyle=async(_record,{verify})=>{await verify();const popup=document.createElement('dialog');popup.id='local-style-fixture';document.body.appendChild(popup);popup.showModal();await styleGate.promise;popup.close();popup.remove();await verify();};
    openInfo();
  });
  await page.waitForSelector('.sd-image-info-dialog');
  await page.evaluate(()=>setInput('[data-image-info-positive]','Draft retained around secondary tools'));
  await page.locator('[data-image-info-action=style]').click();
  await page.waitForSelector('#local-style-fixture');
  ok('secondary original tool is not blocked by the info top layer',await page.evaluate(()=>document.querySelector('#local-style-fixture').matches(':modal')&&!document.querySelector('.sd-image-info-dialog').open));
  await page.evaluate(()=>styleGate.resolve());
  await page.waitForFunction(()=>document.querySelector('.sd-image-info-dialog')?.matches(':modal'));
  ok('secondary tool return retains the exact editing draft',await page.locator('[data-image-info-positive]').inputValue()==='Draft retained around secondary tools');
  await page.locator('.sd-image-info-dialog > footer [data-image-info-close]').click();
  await page.evaluate(()=>{records[0].source='comfy';delete window.styleGate;});
  await page.evaluate(()=>{records[0].recipeUnavailable=true;window.infoResult=storyboardEditPrompt({record:records[0],inspect:true});});
  await page.waitForSelector('.sd-image-info-dialog');
  ok('original-only record is read-only and cannot generate',await page.evaluate(()=>document.querySelector('[data-image-info-positive]').readOnly&&!document.querySelector('[data-image-info-generate]')&&!document.querySelector('[data-image-info-characters]')));
  await page.locator('.sd-image-info-dialog > footer [data-image-info-close]').click();
  await page.evaluate(()=>{delete records[0].recipeUnavailable;});
  await page.evaluate(async()=>{await storyboardOpenLightbox(records);});
  await page.locator('.sd-storyboard-lightbox-next').click();
  ok('actual lightbox sequential navigation',await page.locator('.sd-storyboard-lightbox-index').textContent()==='2 / 2');
  await page.keyboard.press('ArrowLeft');
  ok('actual lightbox keyboard navigation',await page.locator('.sd-storyboard-lightbox-index').textContent()==='1 / 2');
  await page.keyboard.press('Escape');
  await page.evaluate(()=>openInfo());await page.waitForSelector('.sd-image-info-dialog');
  const detail=await page.evaluate(()=>({header:document.querySelector('.sd-image-info-dialog > header').textContent,
    cast:document.querySelector('.sd-image-info-cast').textContent,menus:document.querySelectorAll('[data-image-info-action=download]').length,
    collectionsHidden:document.querySelector('.sd-image-info-collection-editor').hidden,tagHidden:document.querySelector('.sd-media-tag-input-row').hidden}));
  ok('detail top is back, title and model only',detail.header.includes('画面详情')&&detail.header.includes('ComfyUI')&&!/SCREENING ROOM|关闭/.test(detail.header));
  ok('source CHAR precedes appearing character labels',detail.cast.indexOf('Source CHAR')<detail.cast.indexOf('Test person'));
  ok('one image download menu and collapsed metadata inputs',detail.menus===1&&detail.collectionsHidden&&detail.tagHidden);
  await page.locator('[data-image-info-menu-toggle]').click();
  ok('image quick menu reveals download and delete',await page.locator('[data-image-info-action=download]').isVisible()&&await page.locator('[data-image-info-action=delete]').isVisible());
  await page.locator('[data-media-tag-add]').click();await page.locator('.sd-media-tag-input').fill('Cancel-only tag');
  await page.locator('[data-media-tag-cancel]').click();
  ok('tag cancellation hides input without saving',await page.locator('.sd-media-tag-input-row').isHidden()&&await page.evaluate(()=>calls.forbidden===0&&!records[0].tags?.length));
  await page.locator('[data-image-collection-add]').click();await page.locator('[data-image-collection-input]').fill('Cancel-only collection');
  await page.locator('[data-image-collection-cancel]').click();
  ok('collection cancellation hides input without creating',await page.locator('.sd-image-info-collection-editor').isHidden()&&await page.evaluate(()=>calls.forbidden===0));
  await page.locator('.sd-image-info-dialog > footer [data-image-info-close]').click();
  await page.evaluate(()=>{
    window.fixtureCollections=[{id:'existing',name:'Existing collection'}];window.fixtureMetadataSaves=0;
    window.fixtureRefreshes=0;fixtureState.view='gallery';window.rerenderIfOpen=()=>{fixtureRefreshes++;};
    window.originalMetadataSave=saveMetadata;window.saveMetadata=async()=>{if(window.fixtureSaveGate)await fixtureSaveGate.promise;if(window.failFixtureSave)throw Error('Fixture save failed');fixtureMetadataSaves++;};
    openInfo();
  });await page.waitForSelector('.sd-image-info-dialog');
  await page.evaluate(()=>setInput('[data-image-info-positive]','Draft survives metadata edits'));
  await page.locator('[data-image-collection-add]').click();await page.locator('[data-image-collection-choice=existing]').click();
  ok('existing collection selection waits for confirmation',await page.evaluate(()=>fixtureMetadataSaves===0&&!records[0].collectionIds?.length));
  await page.locator('[data-image-collection-cancel]').click();
  ok('cancel existing selection does not attach',await page.evaluate(()=>fixtureMetadataSaves===0&&!records[0].collectionIds?.length));
  await page.locator('[data-image-collection-add]').click();await page.locator('[data-image-collection-choice=existing]').click();await page.locator('[data-image-collection-confirm]').click();
  await page.waitForFunction(()=>fixtureMetadataSaves===1);
  ok('confirmed existing collection becomes one removable chip',await page.locator('[data-image-collection-remove=existing]').count()===1);
  await page.locator('[data-image-collection-add]').click();await page.locator('[data-image-collection-input]').fill('New collection');await page.locator('[data-image-collection-confirm]').click();
  await page.waitForFunction(()=>fixtureMetadataSaves===2);
  ok('typed new name creates and attaches once',await page.evaluate(()=>fixtureCollections.length===2&&records[0].collectionIds.length===2&&fixtureCollections[1].name==='New collection'));
  await page.locator('[data-image-collection-remove=existing]').click();await page.waitForFunction(()=>fixtureMetadataSaves===3);
  ok('remove membership retains other collection and does not delete either collection',await page.evaluate(()=>fixtureCollections.length===2&&records[0].collectionIds.length===1));
  await page.locator('[data-media-tag-add]').click();await page.locator('.sd-media-tag-input').fill('Quiet');await page.locator('[data-media-tag-confirm]').click();await page.waitForFunction(()=>fixtureMetadataSaves===4);
  ok('tag explicit confirm updates its chip',await page.locator('[data-media-tag="Quiet"]').count()===1);
  await page.locator('[data-media-tag="Quiet"] .sd-media-tag-rename').click();await page.locator('.sd-media-tag-input').fill('Not saved');await page.locator('[data-media-tag-cancel]').click();
  ok('inline tag rename cancel preserves value',await page.evaluate(()=>fixtureMetadataSaves===4&&records[0].tags[0]==='Quiet'));
  await page.locator('[data-media-tag="Quiet"] .sd-media-tag-rename').click();await page.locator('.sd-media-tag-input').fill('Evening');await page.locator('[data-media-tag-confirm]').click();await page.waitForFunction(()=>fixtureMetadataSaves===5);
  await page.evaluate(()=>{window.failFixtureSave=true;});
  await page.locator('[data-media-tag="Evening"] .sd-media-tag-remove').click();await page.waitForFunction(()=>document.querySelector('.sd-media-tag-status').textContent==='Fixture save failed');
  ok('failed tag removal retains chip and metadata',await page.locator('[data-media-tag="Evening"]').count()===1&&await page.evaluate(()=>records[0].tags[0]==='Evening'));
  await page.evaluate(()=>{window.failFixtureSave=false;});
  await page.locator('[data-media-tag="Evening"] .sd-media-tag-remove').click();await page.waitForFunction(()=>fixtureMetadataSaves===6);
  ok('successful tag removal leaves no old chip',await page.locator('[data-media-tag]').count()===0);
  ok('successful metadata writes refresh gallery and preserve prompt draft',await page.evaluate(()=>fixtureRefreshes===6&&document.querySelector('[data-image-info-positive]').value==='Draft survives metadata edits'));
  await page.evaluate(()=>{
    window.originalRemoveImage=storyboardRemoveImage;window.deleteGate=deferred();
    window.storyboardRemoveImage=async(_record,verify)=>{await verify();const popup=document.createElement('dialog');popup.id='delete-fixture';document.body.appendChild(popup);popup.showModal();await deleteGate.promise;popup.close();popup.remove();await verify();return false;};
  });
  await page.locator('[data-image-info-menu-toggle]').click();await page.locator('[data-image-info-action=delete]').click();await page.waitForSelector('#delete-fixture');
  ok('delete confirmation is not hidden below detail',await page.evaluate(()=>document.querySelector('#delete-fixture').matches(':modal')&&!document.querySelector('.sd-image-info-dialog').open));
  await page.evaluate(()=>deleteGate.resolve());await page.waitForFunction(()=>document.querySelector('.sd-image-info-dialog').matches(':modal'));
  ok('cancel deletion returns exact unsaved prompt draft',await page.locator('[data-image-info-positive]').inputValue()==='Draft survives metadata edits');
  await page.evaluate(()=>{window.storyboardRemoveImage=originalRemoveImage;delete window.originalRemoveImage;window.fixtureSaveGate=deferred();});
  await page.locator('[data-media-tag-add]').click();await page.locator('.sd-media-tag-input').fill('Saved after close');await page.locator('[data-media-tag-confirm]').click();
  await page.locator('.sd-image-info-dialog > footer [data-image-info-close]').click();
  await page.evaluate(()=>fixtureSaveGate.resolve());await page.waitForFunction(()=>fixtureMetadataSaves===7);
  ok('late successful metadata save refreshes gallery without reopening closed panel',await page.evaluate(()=>fixtureRefreshes===7&&records[0].tags[0]==='Saved after close'&&!document.querySelector('.sd-image-info-dialog')));
  await page.evaluate(()=>{window.saveMetadata=originalMetadataSave;fixtureState.view='create';delete window.originalMetadataSave;delete records[0].tags;delete records[0].collectionIds;delete records[0].collectionId;delete window.fixtureCollections;delete window.fixtureSaveGate;});
  const counters=await page.evaluate(()=>({forbidden:calls.forbidden,redraw:calls.redraw,copy:calls.copy,dialogs:document.querySelectorAll('dialog[open]').length}));
  ok('all owned dialogs cleaned',counters.dialogs===0);
  ok('no persistence/model/provider boundary called',counters.forbidden===0);
  return {checks:checks.length,passed:true,counters,limits:'Real isolated Chromium DOM and root functions; submit/storage/provider boundaries are doubles, not live ST or generation.'};
}
