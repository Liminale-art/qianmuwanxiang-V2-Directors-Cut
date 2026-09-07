// Manual world-camera preparation only. No inference, archive mutation or media submission.
import {applyCharacterCasting,characterCastingInput} from './qianmu-character-casting.js';
import {normalizeStoryboardShotSpec} from './qianmu-storyboard.js';
import {applyCharacterReferenceChoice,renderCharacterReferencePicker} from './qianmu-character-reference.js';
import {normalizeStoryboardPromptFormats,storyboardPromptRenderingsSchema,storyboardPromptRenderingSource,
  storyboardPromptFormatBudget,validateStoryboardPromptRenderings,bindStoryboardPromptRenderings,resolveStoryboardPromptRendering} from './qianmu-prompt-formats.js';
const copy = value => JSON.parse(JSON.stringify(value));
const fail = message => { throw Object.assign(new Error(message),{code:'world_shot_preparation'}); };
const escape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

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
        ...(options.promptFormats?.length?{customButtons:[{text:'手动填写',result:2}]}:{})}).show();
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
export function buildWorldPromptRenderingRequest(shot,formatsInput){
  const formats=normalizeStoryboardPromptFormats(formatsInput);if(!formats.length)fail('工作流尚未声明提示格式');
  const source=storyboardPromptRenderingSource(shot);
  const schema={type:'object',additionalProperties:false,required:['schema','prompt_renderings'],properties:{
    schema:{type:'string',enum:[WORLD_RENDERING_SCHEMA]},prompt_renderings:storyboardPromptRenderingsSchema(formats)}};
  // Machine input/output contract only. Final authored creative instructions remain a later Phase 1 task.
  return {schema,schemaId:WORLD_RENDERING_SCHEMA,formats,maxTokens:storyboardPromptFormatBudget(formats,1),messages:[
    {role:'system',content:JSON.stringify({contract:WORLD_RENDERING_SCHEMA,operation:'render_confirmed_visual_facts',source_mutation:false,output_schema:schema})},
    {role:'user',content:JSON.stringify({source_kind:'director_work_order',truth_mode:'speculative',shot:source})},
  ]};
}
export function parseWorldPromptRenderings(raw,shot,formats){
  if(typeof raw!=='string'||new TextEncoder().encode(raw).byteLength>96*1024)fail('整理返回过长或无效，可手动填写');
  let parsed;try{parsed=JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i,'$1'));}catch(_){fail('整理未返回有效 JSON，可手动填写或重新整理');}
  if(!parsed||Array.isArray(parsed)||parsed.schema!==WORLD_RENDERING_SCHEMA||Object.keys(parsed).some(key=>!['schema','prompt_renderings'].includes(key)))fail('整理返回格式不匹配，可手动填写');
  const checked=validateStoryboardPromptRenderings(parsed.prompt_renderings,{formats,characterIds:shot.characters.map(row=>row.id)});
  if(!checked.ok)fail(checked.errors[0].message);return checked.data;
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
export async function openWorldPromptRenderingEditor({shot,promptFormats,context,guard=async()=>{},prepareRenderings,manual=false}){
  const formats=normalizeStoryboardPromptFormats(promptFormats);let values={},message='',expanded=[],scrollTop=0;
  if(!formats.length)fail('工作流尚未声明提示格式');
  const prepare=async()=>{
    await guard();try{
      const result=await prepareRenderings(copy(shot));await guard();
      const checked=validateStoryboardPromptRenderings(result,{formats,characterIds:shot.characters.map(row=>row.id)});
      if(!checked.ok)fail(checked.errors[0].message);
      values=checked.data;message='';
    }catch(error){await guard();message=String(error?.message||'整理失败，可手动填写').slice(0,240);}await guard();
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
    try{return {...copy(shot),promptRenderingPack:await bindStoryboardPromptRenderings(shot,values,{formats,guard})};}
    catch(error){await guard();message=error.message;}
  }
}

export async function verifyWorldPromptRenderings(shot,formats,guard){
  for(const format of normalizeStoryboardPromptFormats(formats))await resolveStoryboardPromptRendering(shot,shot.promptRenderingPack,format,{guard});
}
