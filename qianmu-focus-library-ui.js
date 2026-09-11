import {focusVoiceCharacterKey,cleanFocusVoice} from './qianmu-focus-voice.js';
import {createFocusLibraryEditor} from './qianmu-focus-library-editor.js';

const moments={'focus:mid':'专注途中','focus:complete':'专注结束','shortBreak:complete':'小憩结束','longBreak:complete':'长休结束'};
// One portal for ordinary editing and storage selection; no ST chat navigation or shared favorites.
export async function openFocusLibrary({document,host,store,namespace,guard,isActive=()=>true,choices,binding,generate,escape:esc,icons,confirm,notify,download,stopAudio,onClose=()=>{}}, {management=false}={}) {
  await guard();const portal=document.createElement('div');portal.className='sd-focus-library-portal';
  portal.innerHTML='<section class="sd-focus-library" role="dialog" aria-modal="true" aria-label="专注语音库"><header><h3>专注语音库</h3><button type="button" class="sd-icon-btn" data-action="close" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button></header><div class="sd-focus-library-body"></div><p class="sd-focus-library-status" role="status"></p></section>';
  host.appendChild(portal);let rows=[],editor=null,url='',folder='',busy=false,closed=false,undo=null,selected=new Set(),dirty=false,editorContext=null;
  const previousFocus=document.activeElement,siblings=[...host.children].filter(el=>el!==portal).map(el=>[el,el.inert]);siblings.forEach(([el])=>{el.inert=true;});
  const body=portal.querySelector('.sd-focus-library-body'),status=portal.querySelector('[role=status]');
  const live=()=>!closed&&portal.isConnected&&isActive();
  const check=async()=>{await guard();if(!live())throw new Error('语音库页面已关闭');};
  function stop(){portal.querySelector('audio')?.pause();if(url){URL.revokeObjectURL(url);url='';}}
  function close(){if(closed)return;closed=true;editor?.close();stop();portal.remove();siblings.forEach(([el,was])=>{el.inert=was;});if(previousFocus?.isConnected)previousFocus.focus();onClose();}
  function paintIcons(){icons(portal);}
  const button=(action,label,icon='')=>`<button type="button" class="sd-btn" data-action="${action}">${icon?`<i class="fa-solid ${icon}"></i>`:''}${label}</button>`;
  function folders(){const map=new Map(choices().map(ch=>[focusVoiceCharacterKey(ch.avatar),ch.name]));for(const row of rows)if(!map.has(row.characterKey))map.set(row.characterKey,row.speaker||'未匹配角色');return [...map];}
  function render(){
    stop();editor?.close();editor=null;dirty=false;
    const options=folders(),visible=folder?rows.filter(row=>row.characterKey===folder):rows;
    body.innerHTML=`<div class="sd-focus-library-toolbar"><label>角色文件夹<select class="text_pole" data-field="folder"><option value="">全部角色</option>${options.map(([key,name])=>`<option value="${esc(key)}" ${key===folder?'selected':''}>${esc(name)}</option>`).join('')}</select></label>${management?'':button('new','新建','fa-plus')}</div>
      ${management?`<p class="sd-muted">所选语音包含音频原件。删除不可恢复，请先备份。导入只新增副本，不覆盖原库。</p><div class="sd-focus-library-toolbar">${button('all','全选此页')}${button('export','导出所选')}${button('import','导入备份')}${button('delete','清理所选')}${undo?button('undo','撤回本次导入'):''}<input hidden type="file" accept=".json,application/json" data-field="import"></div>`:''}
      <div class="sd-focus-library-list">${visible.map(row=>`<article data-id="${esc(row.id)}" data-role="${esc(row.characterKey)}">${management?`<input type="checkbox" aria-label="选择${esc(row.title||row.text)}" data-select="${esc(JSON.stringify([row.characterKey,row.id]))}" ${selected.has(JSON.stringify([row.characterKey,row.id]))?'checked':''}>`:''}<button type="button" class="sd-focus-library-item" data-action="edit"><b>${esc(row.title||row.text)}</b><span>${esc(row.speaker)} · ${row.moments.map(key=>moments[key]).join(' / ')}</span></button></article>`).join('')}</div>`;
    paintIcons();
  }
  async function reload(){rows=await store.list(namespace,{isCurrent:live});await check();const valid=new Set(rows.map(row=>JSON.stringify([row.characterKey,row.id])));selected=new Set([...selected].filter(key=>valid.has(key)));render();}
  async function edit(row){
    const characterKey=row?.characterKey||folder;if(!characterKey){status.textContent='请先选择角色文件夹';return;}
    const scope={namespace,characterKey},context=binding(characterKey);editorContext=structuredClone({providerId:context.providerId,options:context.options||[]});let blob=null;
    if(row){const result=await store.readAudio(scope,row.id,row.revision,{isCurrent:live});await check();if(result.status==='conflict')throw new Error('这条语音已更新，请刷新后打开');if(result.status==='ready')blob=result.blob;}
    stop();const initial=row||{id:crypto.randomUUID(),characterKey,namespace,speaker:context.speaker||folders().find(([key])=>key===characterKey)?.[1]||'角色',title:'',text:'',moments:['focus:complete'],providerId:context.providerId,voice:context.voice};
    editor=createFocusLibraryEditor({scope,initial,blob,isCurrent:live,save:store.save,generate:async(clip,options)=>{await check();return generate(characterKey,clip,options);}});
    const available=context.options||[];
    body.innerHTML=`<div class="sd-focus-library-toolbar">${button('back','返回列表')}<b>${esc(initial.speaker)}</b></div>
      <label>名称<input class="text_pole" maxlength="120" data-field="title" value="${esc(initial.title||'')}"></label>
      <label>语音内容<textarea class="text_pole" maxlength="2000" rows="4" data-field="text">${esc(initial.text)}</textarea></label>
      <label>生成音色<select class="text_pole" data-field="voice"><option value="">${initial.voice?.voiceId?'沿用录音音色':'选择音色'}</option>${available.map((option,i)=>`<option value="${i}">${esc(option.label)}</option>`).join('')}</select></label>
      <div class="sd-focus-library-moments">${Object.entries(moments).map(([key,label])=>`<label><input type="checkbox" data-moment="${key}" ${initial.moments.includes(key)?'checked':''}>${label}</label>`).join('')}</div>
      <audio controls preload="none" aria-label="试听语音"></audio><div class="sd-focus-library-toolbar">${management?'':button('generate',blob?'重新生成':'生成语音','fa-wand-magic-sparkles')+button('save','保存','fa-floppy-disk')}${row?button('remove','删除','fa-trash-can'):''}</div>`;
    if(management)body.querySelectorAll('input,textarea,select').forEach(el=>{el.disabled=true;});
    body.querySelector('audio').addEventListener('play',stopAudio);body.querySelector('audio').addEventListener('error',()=>{if(live())status.textContent='浏览器无法播放这条音频，请检查渠道输出或重新生成。';});preview();paintIcons();status.textContent=row&&!blob?'原件缺失，可重新生成后保存。':'';
  }
  function preview(){stop();const audio=editor?.snapshot().audio;if(audio){url=URL.createObjectURL(audio);body.querySelector('audio').src=url;}else body.querySelector('audio')?.removeAttribute('src');}
  function capture(){
    if(!editor)return;const value=body.querySelector('[data-field=voice]').value,context=editorContext;
    const patch={title:body.querySelector('[data-field=title]').value,text:body.querySelector('[data-field=text]').value,moments:[...body.querySelectorAll('[data-moment]:checked')].map(el=>el.dataset.moment)};
    if(value!==''){const option=context.options?.[Number(value)];if(!option)throw new Error('音色列表已变化，请重开条目');patch.voice=cleanFocusVoice(option);patch.providerId=context.providerId;}
    editor.update(patch);
  }
  function picked(){return rows.filter(row=>selected.has(JSON.stringify([row.characterKey,row.id])));}
  async function action(name,target){
    if(name==='close'){if(dirty&&!await confirm('离开编辑','未保存的语音将丢弃，确定离开？'))return;close();return;}
    await check();
    if(name==='back'){if(dirty&&!await confirm('返回列表','放弃未保存修改？'))return;await check();await reload();}
    else if(name==='new')await edit(null);
    else if(name==='edit'){const article=target.closest('article');await edit(rows.find(row=>row.id===article.dataset.id&&row.characterKey===article.dataset.role));}
    else if(name==='generate'||name==='save'){
      capture();const activeEditor=editor;
      if(name==='generate'&&!await confirm('生成语音','将调用当前配音渠道，可能产生费用。继续？'))return;
      await check();const result=await activeEditor[name]();await check();
      if(result.status==='conflict')throw new Error('原语音已被其他页面修改，未覆盖，请保留文字并重新打开');
      if(name==='save'&&result.status==='saved'){dirty=false;status.textContent='语音已保存';await reload();}
      else if(result.status==='generated'){dirty=true;preview();status.textContent='已生成，请试听后保存';}
    }else if(name==='remove'){
      const row=editor.snapshot().draft;if(!await confirm('删除语音','删除此条音频原件与记录？此操作不可恢复。'))return;await check();
      await store.batch(namespace,{remove:[row]},{isCurrent:live});await check();await reload();status.textContent='已删除，可从此前导出的备份恢复';
    }else if(name==='all'){for(const row of rows.filter(row=>!folder||row.characterKey===folder))selected.add(JSON.stringify([row.characterKey,row.id]));render();}
    else if(name==='export'){const frozen=picked();const {exportFocusLibrary}=await import('./qianmu-focus-library-backup.js');const file=await exportFocusLibrary(frozen,{readAudio:store.readAudio,guard:check});await check();download(file,`qianmu-focus-voices-${Date.now()}.json`);status.textContent=`已导出 ${frozen.length} 条语音（含原件）`;}
    else if(name==='import')body.querySelector('[data-field=import]').click();
    else if(name==='delete'||name==='undo'){
      const frozen=name==='undo'?undo:picked();if(!frozen?.length)throw new Error('请先选择语音');
      if(!await confirm(name==='undo'?'撤回导入':'清理所选',`将删除 ${frozen.length} 条语音及原件。不会删除其他内容；已被修改的条目会阻止整批清理。继续？`))return;
      await check();await store.batch(namespace,{remove:frozen},{isCurrent:live});await check();if(name==='undo')undo=null;selected.clear();await reload();status.textContent='所选记录与音频已删除；如需恢复，请导入此前备份';
    }
  }
  async function run(work){if(busy)return;busy=true;portal.querySelectorAll('button,input,select,textarea').forEach(el=>{el.disabled=true;});
    try{await work();}catch(error){if(live())status.textContent=error.message||'操作未完成';}
    finally{busy=false;if(live())portal.querySelectorAll('button,input,select,textarea').forEach(el=>{el.disabled=!!(management&&editor&&el.matches('input,select,textarea'));});}}
  portal.addEventListener('click',event=>{const target=event.target.closest('[data-action]');if(target)void run(()=>action(target.dataset.action,target));});
  portal.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();void run(()=>action('close'));}
    if(event.key==='Tab'){const controls=[...portal.querySelectorAll('button,input,select,textarea,audio')].filter(el=>!el.disabled&&!el.hidden&&el.getClientRects().length);if(!controls.length)return;
      if(event.shiftKey&&document.activeElement===controls[0]){event.preventDefault();controls.at(-1).focus();}else if(!event.shiftKey&&document.activeElement===controls.at(-1)){event.preventDefault();controls[0].focus();}}
  });
  body.addEventListener('input',event=>{if(editor&&event.target.matches('input,textarea,select')){dirty=true;if(event.target.matches('[data-field=text],[data-field=voice]')){capture();preview();}}});
  body.addEventListener('change',event=>{
    const el=event.target;
    if(el.dataset.select){el.checked?selected.add(el.dataset.select):selected.delete(el.dataset.select);return;}
    if(el.dataset.field==='folder'){folder=el.value;render();return;}
    if(el.dataset.field==='import'){const file=el.files?.[0];el.value='';if(file)void run(async()=>{
      const {inspectFocusLibraryBackup}=await import('./qianmu-focus-library-backup.js');const items=await inspectFocusLibraryBackup(file,{guard:check});
      if(!await confirm('导入专注语音',`已校验 ${items.length} 条语音与原件。将按角色身份新增到当前账户，不覆盖已有语音；重复导入会产生副本。继续？`))return;await check();
      const result=await store.batch(namespace,{add:items.map(({clip,blob})=>({clip:{...clip,namespace,id:crypto.randomUUID()},blob}))},{isCurrent:live});
      await check();undo=result.added;await reload();status.textContent=`已导入 ${undo.length} 条，可在关闭本页前撤回本次导入`;
    });}
  });
  try{await reload();paintIcons();portal.querySelector('[data-action=close]').focus();}catch(error){status.textContent=error.message;}
  return {close,element:portal};
}
