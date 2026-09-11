import {focusVoiceCharacterKey} from './qianmu-focus-voice.js';
import {createFocusDialogueAutosave} from './qianmu-focus-dialogue-autosave.js';
const moments={'focus:mid':'专注途中','focus:complete':'专注结束','shortBreak:complete':'小憩结束','longBreak:complete':'长休结束'};

// No audio generation, provider selection or credentials in the dialogue editor.
export async function openFocusDialogue({document,host,library,guard,choices,binding,escape:esc,icons,confirm,onClose=()=>{}}){
  await guard();const portal=document.createElement('div');portal.className='sd-focus-library-portal';
  portal.innerHTML='<section class="sd-focus-library sd-focus-dialogue" role="dialog" aria-modal="true" aria-label="自定义台词库"><header><button type="button" class="sd-icon-btn" data-action="back" title="返回列表" aria-label="返回列表" hidden><i class="fa-solid fa-list"></i></button><h3>自定义台词库</h3><button type="button" class="sd-icon-btn" data-action="close" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button></header><div class="sd-focus-library-body"></div><p role="status" class="sd-focus-library-status"></p></section>';
  host.appendChild(portal);const previous=document.activeElement,siblings=[...host.children].filter(el=>el!==portal).map(el=>[el,el.inert]);siblings.forEach(([el])=>{el.inert=true;});
  const body=portal.querySelector('.sd-focus-library-body'),status=portal.querySelector('[role=status]');
  let closed=false,busy=false,composing=false,data,editing=null,autosave=null,timer=null,folder=binding().characterKey||'';const selected=new Set();
  const check=async()=>{await guard();if(closed||!portal.isConnected)throw Error('台词库页面已关闭');};
  const button=(action,label)=>`<button type="button" class="sd-btn" data-action="${action}">${label}</button>`;
  function title(value){portal.querySelector('h3').textContent=value;portal.querySelector('[role=dialog]').setAttribute('aria-label',value);}
  function close(){if(closed)return;closed=true;clearTimeout(timer);autosave?.dispose();portal.remove();siblings.forEach(([el,inert])=>{el.inert=inert;});if(previous?.isConnected)previous.focus();onClose();}
  function capture(){if(!autosave)return;autosave.update({text:body.querySelector('textarea').value,moments:[...body.querySelectorAll('[data-moment][aria-pressed=true]')].map(el=>el.dataset.moment)});}
  async function flush(){clearTimeout(timer);if(composing)throw Error('请先完成当前文字输入');await autosave?.flush();}
  function schedule(){capture();clearTimeout(timer);timer=setTimeout(()=>{void flush().catch(error=>{if(!closed)status.textContent=error.message||'自动保存失败，请重试编辑';});},250);}
  function folders(){const map=new Map(choices().map(ch=>[focusVoiceCharacterKey(ch.avatar),ch.name]));for(const row of data.rows)if(!map.has(row.characterKey))map.set(row.characterKey,row.speaker);return [...map];}
  function render(){
    autosave?.dispose();autosave=null;editing=null;composing=false;title('自定义台词库');portal.querySelector('[data-action=back]').hidden=true;status.textContent='';const visible=data.rows.filter(row=>!folder||row.characterKey===folder);
    for(const id of selected)if(!visible.some(row=>row.id===id))selected.delete(id);
    body.innerHTML=`<div class="sd-focus-dialogue-folders"><select class="text_pole" data-field="folder" aria-label="选择角色"><option value="">全部角色</option>${folders().map(([key,name])=>`<option value="${esc(key)}" ${key===folder?'selected':''}>${esc(name)}</option>`).join('')}</select>${button('new','新建')}</div>
      ${visible.length?`<div class="sd-focus-dialogue-bulk">${button('select-all','全选')}${button('remove-selected','删除所选')}</div>`:''}
      <div class="sd-focus-library-list">${visible.map(row=>`<article><label class="sd-focus-dialogue-check"><input type="checkbox" data-select="${esc(row.id)}" aria-label="选择台词：${esc(row.text.slice(0,60))}" ${selected.has(row.id)?'checked':''}></label><button type="button" class="sd-focus-library-item" data-action="edit" data-id="${esc(row.id)}"><b>${esc(row.text||'空白台词')}</b><span>${esc(row.speaker)} · ${row.moments.map(key=>moments[key]).join(' / ')||'未启用阶段'}</span></button></article>`).join('')}</div>`;syncSelection();icons(portal);
  }
  function syncSelection(){
    const del=body.querySelector('[data-action=remove-selected]'),all=body.querySelector('[data-action=select-all]');
    if(del){del.disabled=selected.size===0;del.textContent=selected.size?`删除所选（${selected.size}）`:'删除所选';}
    if(all)all.textContent=selected.size&&[...body.querySelectorAll('[data-select]')].every(el=>selected.has(el.dataset.select))?'取消全选':'全选';
  }
  async function reload(){const next=await library.snapshot();await check();data=next;render();}
  function edit(row){
    if(!row&&!folder){status.textContent='请先选择角色文件夹';return;}
    editing=row?structuredClone(row):{characterKey:folder,speaker:folders().find(([key])=>key===folder)?.[1]||'角色',text:'',moments:['focus:complete']};
    title(editing.speaker||'角色');status.textContent='';portal.querySelector('[data-action=back]').hidden=false;
    body.innerHTML=`<label>语音内容<textarea class="text_pole" rows="4" maxlength="2000" data-field="text">${esc(editing.text)}</textarea></label><div class="sd-focus-dialogue-moments" role="group" aria-label="激活阶段">${Object.entries(moments).map(([key,label])=>`<button type="button" data-moment="${key}" aria-pressed="${editing.moments.includes(key)}">${label}</button>`).join('')}</div>`;
    autosave=createFocusDialogueAutosave({library,data,row:editing,guard:check,onSaved:next=>{data=next;if(!closed)status.textContent='';}});
    icons(portal);
    body.querySelector('textarea').focus();
  }
  async function action(name,target){
    if(['back','close'].includes(name))await flush();
    await check();
    if(name==='close'){close();return;}if(name==='back')await reload();
    else if(name==='new')edit(null);
    else if(name==='edit')edit(data.rows.find(row=>row.id===target.dataset.id));
    else if(name==='select-all'){
      const visible=data.rows.filter(row=>!folder||row.characterKey===folder),all=visible.every(row=>selected.has(row.id));selected.clear();if(!all)visible.forEach(row=>selected.add(row.id));render();
    }else if(name==='remove-selected'){
      const ids=[...selected],revision=data.revision;if(!ids.length)return;
      if(!await confirm('删除所选台词',`删除所选 ${ids.length} 条台词？已保存的录音与收藏不会被删除。`))return;await check();
      await library.removeMany(ids,revision);await check();selected.clear();await reload();status.textContent=`已删除 ${ids.length} 条台词`;
    }
  }
  async function run(work){if(busy||closed)return;busy=true;try{await work();}catch(error){if(!closed)status.textContent=error.message||'未完成，请重试';}finally{busy=false;}}
  portal.addEventListener('click',event=>{const stage=event.target.closest('[data-moment]');if(stage&&editing){stage.setAttribute('aria-pressed',stage.getAttribute('aria-pressed')!=='true');schedule();return;}const target=event.target.closest('[data-action]');if(target)void run(()=>action(target.dataset.action,target));});
  portal.addEventListener('compositionstart',()=>{composing=true;clearTimeout(timer);});
  portal.addEventListener('compositionend',()=>{composing=false;if(editing)schedule();});
  portal.addEventListener('input',event=>{if(editing&&!composing&&!event.isComposing)schedule();});
  portal.addEventListener('focusout',()=>{if(editing&&!composing)void flush().catch(error=>{if(!closed)status.textContent=error.message;});});
  portal.addEventListener('change',event=>{const el=event.target;
    if(el.dataset.select){if(busy){el.checked=selected.has(el.dataset.select);return;}el.checked?selected.add(el.dataset.select):selected.delete(el.dataset.select);syncSelection();}
    if(el.dataset.field==='folder'){if(busy){el.value=folder;return;}folder=el.value;selected.clear();render();}
  });
  portal.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();void run(()=>action('close'));}
    if(event.key==='Tab'){const controls=[...portal.querySelectorAll('button,input,select,textarea')].filter(el=>!el.disabled&&el.getClientRects().length);if(event.shiftKey&&document.activeElement===controls[0]){event.preventDefault();controls.at(-1).focus();}else if(!event.shiftKey&&document.activeElement===controls.at(-1)){event.preventDefault();controls[0].focus();}}
  });
  try{await reload();portal.querySelector('[data-action=close]').focus();}catch(error){close();throw error;}
  return {close,element:portal};
}
