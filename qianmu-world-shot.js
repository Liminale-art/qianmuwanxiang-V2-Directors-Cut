// World-camera preparation only. No autonomous inference, archive mutation or media submission.
export {createWorldPromptAttempt} from './qianmu-world-prompt-diagnostics.js?v=1.59.278';
import {applyCharacterCasting,characterCastingInput} from './qianmu-character-casting.js';
import {normalizeStoryboardShotSpec} from './qianmu-storyboard.js?v=1.59.278';
import {applyCharacterReferenceChoice,renderCharacterReferencePicker} from './qianmu-character-reference.js';
import {STORYBOARD_STILL_EXPRESSION_INSTRUCTIONS,STORYBOARD_WORLD_STILL_INSTRUCTION,storyboardStillFormatInstructions} from './qianmu-still-frame-instructions.js';
import {galleryKeywordSchema,GALLERY_KEYWORD_INSTRUCTION} from './qianmu-gallery-keywords.js';
import {rememberWorldGalleryKeywords,worldGalleryKeywords,carryWorldGalleryKeywords} from './qianmu-world-gallery-keywords.js';
import {normalizeStoryboardPromptFormats,storyboardPromptRenderingsSchema,storyboardPromptRenderingSource,
  storyboardPromptFormatBudget,validateStoryboardPromptRenderings,bindStoryboardPromptRenderings,resolveStoryboardPromptRendering} from './qianmu-prompt-formats.js';
const copy = value => JSON.parse(JSON.stringify(value));
const fail = message => { throw Object.assign(new Error(message),{code:'world_shot_preparation'}); };
const escape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const pendingGenerations = new WeakMap();
const stagedStyles = new WeakMap();

export async function prepareWorldStyleSelection(state,inputGuard,dependencies,options){
  if(state.routing?.styleLibrary!==true)return null;
  const runtime=await import('./qianmu-world-ensemble.js?v=1.59.278');inputGuard.assertCurrent();
  return runtime.prepareWorldStyleSelection(state,inputGuard,dependencies,options);
}
export async function bindWorldGenerationStyles(handoff,owner,selection,guard){
  if(!selection)return;
  const pending=pendingGenerations.get(handoff);
  if(!pending||pending.owner!==owner||pending.bindingStyles)fail('世界风格交接归属无效');
  pending.bindingStyles=true;Object.defineProperty(pending.draft,'worldStyleRequired',{value:true,enumerable:true});
  pending.styles=await selection.bind(pending.draft.promptDraft.shots,guard);
  if(pendingGenerations.get(handoff)!==pending)fail('世界画面已交接，不能再修改风格');
}
export async function resolveWorldGenerationStyles(draft,planned,guard){
  const styles=stagedStyles.get(draft);if(!styles){if(draft?.worldStyleRequired)fail('世界风格交接已丢失，未改用其他线路');return null;}
  stagedStyles.delete(draft);
  return styles.resolve(planned,guard);
}

// A single-use, page-local handoff. Keep the editable workbench untouched;
// only the existing image queue may persist the resulting job and its trace.
export function createWorldGenerationHandoff(state,{shotSpec,prompt,negative='',title='',stages=[]}) {
  if(!shotSpec?.productionContext?.packetId || typeof prompt!=='string' || !prompt.trim()) fail('世界画面缺少已确认的提示');
  const shot={id:shotSpec.id,title,purpose:shotSpec.narrativePurpose || title,role:shotSpec.shotRole || 'custom',
    shotType:shotSpec.subjectKind==='character'?'portrait':shotSpec.subjectKind==='environment'?'environment':'custom',
    prompt:prompt.trim(),negative:String(negative),safePrompt:'',tags:worldGalleryKeywords(shotSpec),sensitive:Boolean(shotSpec.sensitive),shotSpec:copy(shotSpec),userEdited:false,promptLocked:false};
  const draft={...state,prompt:shot.prompt,negative:shot.negative,promptMode:'manual',target:'gallery',floor:'',inlineByDefault:false,
    pendingParagraphSelection:null,manualParagraphIndex:null,pendingParagraphIndex:null,pendingShotType:'',
    routing:copy(state.routing),
    // A world shot owns a fresh execution draft. In particular, prose ensemble
    // recovery flags or future prose receipts must never enter its gallery path.
    promptDraft:{planId:'',compiled:shot.prompt,negative:shot.negative,compiledAt:Date.now(),compiledBy:'director-work-order',
      userEditedCompiled:false,userEditedNegative:false,artistPositiveBaked:false,artistNegativeBaked:false,sourceSummary:['导演工作单',title],shots:[shot]},
    pendingCompilerStages:copy(stages)};
  const handoff=Object.freeze({});pendingGenerations.set(handoff,{owner:state,draft});return handoff;
}
export function consumeWorldGenerationHandoff(handoff,owner) {
  const pending=pendingGenerations.get(handoff);
  if(!pending || pending.owner!==owner)fail('世界画面已交接或所属设置已变化，未重复提交');
  if(pending.bindingStyles&&!pending.styles)fail('世界风格尚未核对完成，未提交');
  pendingGenerations.delete(handoff);if(pending.styles)stagedStyles.set(pending.draft,pending.styles);return pending.draft;
}

function parts(values,count,length,label) {
  const rows=[];
  for (const value of values) {
    if (typeof value !== 'string') fail(`${label}格式无效`);
    for (let row of value.split(/\r?\n/).map(text=>text.trim()).filter(Boolean)) {
      while (row.length > length) {
        let end = Math.max(row.lastIndexOf(' ',length),row.lastIndexOf(',',length),row.lastIndexOf('，',length));
        if (end < length/2) end=length;
        // Do not split a surrogate pair when no word boundary is available.
        if (/^[\uDC00-\uDFFF]$/.test(row[end])) end--;
        rows.push(row.slice(0,end)); row=row.slice(end).trim();
        if (rows.length > count) fail(`${label}过长，请精简后重试`);
      }
      if (row) rows.push(row);
      if (rows.length > count) fail(`${label}过长，请精简后重试`);
    }
  }
  return rows;
}

export function prepareWorldCharacterShot(input,prepared) {
  characterCastingInput(prepared);
  const visible=(input.characters || []).filter(row=>row.visible!==false);
  if (visible.length > 12 || visible.some(row=>!row.id || !row.name)
    || new Set(visible.map(row=>row.id)).size!==visible.length) fail('出镜人物过多或身份重复，请先核对导演素材');
  const bound=applyCharacterCasting({...copy(input),characters:visible},prepared);
  const byId=new Map((prepared?.entries||[]).map(row=>[row.identity.subjectId,row.identity]));
  const characters=bound.shot.characters.map(row=>({...row,
    // World orders have not passed the prose extractor. Keep base identity and current state separate,
    // and present both for manual review instead of guessing how to reconcile contradictory text.
    identity:parts(row.identity?.length ? row.identity : [byId.get(row.id)?.appearance || ''],30,500,'人物形象'),
    temporaryState:parts(row.temporaryState || [],20,500,'当前状态'),
  }));
  const shot={...bound.shot,characters,promptAtoms:{...bound.shot.promptAtoms,
    global:parts(bound.shot.promptAtoms?.global || [],40,800,'画面描述')}};
  return {shot:normalizeStoryboardShotSpec(shot),warnings:bound.warnings};
}

export function captureWorldShotConfirmation(shot,{characters,referenceChoice,sensitive},useReference=false) {
  if (!Array.isArray(characters) || characters.length!==shot.characters.length
    || characters.some((row,index)=>row.id!==shot.characters[index].id)) fail('出镜人物已变化，请重新确认');
  const next=copy(shot);
  next.characters=characters.map((row,index)=>({...next.characters[index],
    identity:parts([row.identity],30,500,'人物形象'),temporaryState:parts([row.temporaryState],20,500,'当前状态')}));
  next.sensitive=Boolean(shot.sensitive || sensitive);
  return useReference ? applyCharacterReferenceChoice(next,referenceChoice) : next;
}

export function renderWorldShotConfirmation(shot,{title='',model='',useReference=false,warnings=[],fields,message='',promptFormats=[]}={}) {
  return `<div class="sd-world-shot-dialog"><h3>造物之眼</h3><b>${escape(title)}</b><p>${escape(shot.promptAtoms?.global?.join('\n') || shot.narrativePurpose)}</p>
    <small>导演视角 · ${escape(model)} · ${promptFormats.length?'整理会调用取景 API，下一步确认后才生图。':'确认后生成。'}不自动写入正文或推演事实。</small>
    <div class="sd-world-shot-people">${shot.characters.map((row,index)=>{
      const field=fields?.characters?.[index],warning=warnings.find(item=>item.characterId===row.id || item.characterId===row.archiveSnapshot?.sourceCharacterId);
      return `<details data-world-person="${index}" ${shot.characters.length===1?'open':''}><summary><b>${escape(row.name)}</b><small>${row.archiveSnapshot?`${escape(row.archiveSnapshot.name)} · v${row.archiveSnapshot.archiveVersion}`:warning?'匹配冲突，未绑定档案':'未绑定档案'}</small></summary>
        <div class="sd-world-shot-fields"><label><span>本镜基础形象</span><textarea class="text_pole" data-world-field="identity" rows="3">${escape(field?.identity ?? row.identity.join('\n'))}</textarea></label>
        <label><span>本镜当前状态</span><textarea class="text_pole" data-world-field="temporaryState" rows="3">${escape(field?.temporaryState ?? row.temporaryState.join('\n'))}</textarea></label></div></details>`;
    }).join('')}</div>
    ${shot.characters.length?'<small>请核对基础形象是否与本镜状态冲突；这里只改本镜，不修改角色库。未绑定人物按本镜文字生成。</small>':''}
    ${useReference?`${renderCharacterReferencePicker(shot)}<small>参考图可能额外计费，与 Vibe 不可同时使用。</small>`:''}
    <label class="sd-world-shot-sensitive"><input type="checkbox" data-world-sensitive ${(shot.sensitive || fields?.sensitive)?'checked':''} ${shot.sensitive?'disabled':''}><span>画面含敏感情节，需按渠道能力适配</span></label>
    <p role="status">${escape(message)}</p></div>`;
}

export async function openWorldShotConfirmation({shot,context,guard=async()=>{},...options}) {
  let fields,message='',expanded=[],scrollTop=0;
  for (;;) {
    await guard();
    const wrap=document.createElement('div');wrap.innerHTML=renderWorldShotConfirmation(shot,{...options,fields,message});
    for (const [index,open] of expanded) wrap.querySelector(`[data-world-person="${index}"]`).open=open;
    const picker=wrap.querySelector('.sd-character-reference-picker');if (picker && fields) picker.value=fields.referenceChoice;
    const clearStatus=()=>{wrap.querySelector('[role=status]').textContent='';};
    wrap.addEventListener('input',clearStatus);wrap.addEventListener('change',clearStatus);
    let result,frame;
    try {
      const opening=new context.Popup(wrap,context.POPUP_TYPE.CONFIRM,'',{okButton:options.promptFormats?.length?'整理提示':'确认生成',cancelButton:'取消',
        ...(options.promptFormats?.length?{customButtons:[{text:options.useManualStyle?'手动填写（当前方案）':'手动填写',result:2}]}:{})}).show();
      frame=requestAnimationFrame(()=>{if(wrap.isConnected)wrap.querySelector('.sd-world-shot-dialog').scrollTop=scrollTop;});
      result=await opening;
    } finally {if(frame!==undefined)cancelAnimationFrame(frame);}
    await guard(); if(!result)return null;
    fields={characters:shot.characters.map((row,index)=>{const element=wrap.querySelector(`[data-world-person="${index}"]`);
      return {id:row.id,identity:element.querySelector('[data-world-field=identity]').value,temporaryState:element.querySelector('[data-world-field=temporaryState]').value};}),
      referenceChoice:picker?.value,sensitive:wrap.querySelector('[data-world-sensitive]').checked};
    expanded=[...wrap.querySelectorAll('[data-world-person]')].map(row=>[row.dataset.worldPerson,row.open]);scrollTop=wrap.querySelector('.sd-world-shot-dialog').scrollTop;
    try {
      const confirmed=captureWorldShotConfirmation(shot,fields,options.useReference);
      if(!options.promptFormats?.length)return confirmed;
      const rendered=await openWorldPromptRenderingEditor({shot:confirmed,context,guard,...options,manual:String(result)==='2'});
      if(rendered?.back){shot=confirmed;continue;}
      return rendered;
    }catch(error){await guard();message=error.message;}
  }
}

export const WORLD_RENDERING_SCHEMA='qianmu.world.renderings.v1';
export function buildWorldPromptRenderingRequest(shot,formatsInput,{styleSelection=null,galleryKeywords}={}){
  const formats=normalizeStoryboardPromptFormats(formatsInput);if(!formats.length)fail('工作流尚未声明提示格式');
  const source=storyboardPromptRenderingSource(shot);
  const schema={type:'object',additionalProperties:false,required:['schema','prompt_renderings'],properties:{
    schema:{type:'string',enum:[WORLD_RENDERING_SCHEMA]},prompt_renderings:storyboardPromptRenderingsSchema(formats)}};
  const styles=styleSelection?.request();
  if(styles){schema.required.push('style_selections');schema.properties.style_selections=styles.schema;}
  const keywords=galleryKeywordSchema(galleryKeywords);
  if(keywords){schema.required.push('gallery_keywords');schema.properties.gallery_keywords=keywords;}
  // Use the same self-contained visual-expression guidance as ordinary stills,
  // without introducing narrative planning, another request or prose context.
  return {schema,schemaId:WORLD_RENDERING_SCHEMA,formats,maxTokens:storyboardPromptFormatBudget(formats,1)+(styles?500:0)+(keywords?250:0),messages:[
    {role:'system',content:JSON.stringify({contract:WORLD_RENDERING_SCHEMA,operation:'render_confirmed_visual_facts',source_mutation:false,
      instructions:[STORYBOARD_WORLD_STILL_INSTRUCTION,...STORYBOARD_STILL_EXPRESSION_INSTRUCTIONS,storyboardStillFormatInstructions(formats),
        ...(keywords?[GALLERY_KEYWORD_INSTRUCTION]:[]),
        ...(styles?['每镜仅从style_catalogue选择一个S1方案并填写style_selections及简短reason，按本画面表现增益选择，不按配额轮换；没有明确增益选current。不改变人物、状态、事实或构图；不把艺术家名、方案元数据、路线或工作流参数抄入提示。']:[])],output_schema:schema})},
    {role:'user',content:JSON.stringify({source_kind:'director_work_order',truth_mode:'speculative',shot:source,...(styles?{style_catalogue:styles.catalogue}:{}),...(keywords?{gallery_keyword_vocabulary:keywords.items.enum}:{})})},
  ]};
}
export function parseWorldPromptRenderings(raw,shot,formats,{styleSelection=null,galleryKeywords}={}){
  if(typeof raw!=='string'||new TextEncoder().encode(raw).byteLength>96*1024)fail('整理返回过长或无效，可手动填写');
  let parsed;try{parsed=JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i,'$1'));}catch(_){fail('整理未返回有效 JSON，可手动填写或重新整理');}
  const keywords=galleryKeywordSchema(galleryKeywords);
  if(!parsed||Array.isArray(parsed)||parsed.schema!==WORLD_RENDERING_SCHEMA||Object.keys(parsed).some(key=>!['schema','prompt_renderings',...(styleSelection?['style_selections']:[]),...(keywords?['gallery_keywords']:[])].includes(key)))fail('整理返回格式不匹配，可手动填写');
  const checked=validateStoryboardPromptRenderings(parsed.prompt_renderings,{formats,characterIds:shot.characters.map(row=>row.id)});
  if(!checked.ok)fail(checked.errors[0].message);
  rememberWorldGalleryKeywords(checked.data,parsed.gallery_keywords,galleryKeywords);
  styleSelection?.accept(parsed.style_selections,shot);return checked.data;
}
const formatNames={tags:'标签表达',natural_language:'自然语言',character_blocks:'人物分块'};
export function renderWorldPromptRenderingEditor(shot,formatsInput,values={},message=''){
  const formats=normalizeStoryboardPromptFormats(formatsInput);
  return `<div class="sd-world-shot-dialog sd-world-rendering-editor"><h3>确认画面提示</h3><small>只整理已确认的这一镜；可逐人修改，确认后才生图。</small>
    ${formats.map((format,index)=>`<details data-world-format="${format}" ${index===0?'open':''}><summary>${formatNames[format]}</summary><div class="sd-world-shot-fields">
      <label><span>公共画面</span><textarea class="text_pole" rows="3" maxlength="4000" data-world-global>${escape(values[format]?.global||'')}</textarea></label>
      ${shot.characters.map((character,i)=>`<label><span>${escape(character.name||character.id)}</span><textarea class="text_pole" rows="3" maxlength="1600" data-world-character="${i}">${escape(values[format]?.characters?.find(row=>row.character_id===character.id)?.positive||'')}</textarea></label>`).join('')}
      <label><span>画面排除项</span><textarea class="text_pole" rows="2" maxlength="2000" data-world-negative>${escape(values[format]?.negative||'')}</textarea></label>
    </div></details>`).join('')}<p role="status">${escape(message)}</p></div>`;
}
export async function openWorldPromptRenderingEditor({shot,promptFormats,context,guard=async()=>{},prepareRenderings,manual=false,useManualStyle}){
  const formats=normalizeStoryboardPromptFormats(promptFormats);let values={},keywordSource=null,message='',expanded=[],scrollTop=0,manualStyle=manual;
  if(!formats.length)fail('工作流尚未声明提示格式');
  const prepare=async()=>{
    await guard();try{
      const result=await prepareRenderings(copy(shot));await guard();
      const checked=validateStoryboardPromptRenderings(result,{formats,characterIds:shot.characters.map(row=>row.id)});
      if(!checked.ok)fail(checked.errors[0].message);
      values=checked.data;keywordSource=result;message='';manualStyle=false;
    }catch(error){await guard();keywordSource=null;manualStyle=true;message=String(error?.message||'整理失败，可手动填写').slice(0,240)+(useManualStyle?'；手动填写将使用当前方案。':'');}await guard();
  };
  if(!manual)await prepare();
  for(;;){
    await guard();const wrap=document.createElement('div');wrap.innerHTML=renderWorldPromptRenderingEditor(shot,formats,values,message);
    for(const [format,open]of expanded)wrap.querySelector(`[data-world-format="${format}"]`).open=open;
    let result,frame;try{
      const opening=new context.Popup(wrap,context.POPUP_TYPE.CONFIRM,'',{okButton:'确认生成',cancelButton:'取消',customButtons:[{text:'重新整理',result:2},{text:'修改人物',result:3}]}).show();
      frame=requestAnimationFrame(()=>{if(wrap.isConnected)wrap.querySelector('.sd-world-shot-dialog').scrollTop=scrollTop;});result=await opening;
    }finally{if(frame!==undefined)cancelAnimationFrame(frame);}
    await guard();if(!result)return null;if(String(result)==='3')return {back:true};
    values=Object.fromEntries(formats.map(format=>{const root=wrap.querySelector(`[data-world-format="${format}"]`);return [format,{
      global:root.querySelector('[data-world-global]').value,negative:root.querySelector('[data-world-negative]').value,
      characters:shot.characters.map((character,index)=>({character_id:character.id,positive:root.querySelector(`[data-world-character="${index}"]`).value})),
    }];}));
    expanded=[...wrap.querySelectorAll('[data-world-format]')].map(row=>[row.dataset.worldFormat,row.open]);scrollTop=wrap.querySelector('.sd-world-shot-dialog').scrollTop;
    if(String(result)==='2'){await prepare();continue;}
    try{const promptRenderingPack=await bindStoryboardPromptRenderings(shot,values,{formats,guard});if(manualStyle)await useManualStyle?.(shot);return carryWorldGalleryKeywords({...copy(shot),promptRenderingPack},keywordSource);}
    catch(error){await guard();message=error.message;}
  }
}

export async function verifyWorldPromptRenderings(shot,formats,guard){
  for(const format of normalizeStoryboardPromptFormats(formats))await resolveStoryboardPromptRendering(shot,shot.promptRenderingPack,format,{guard});
}
