import {focusVoiceCharacterKey} from './qianmu-focus-voice.js';
const moments={'focus:mid':'专注途中','focus:complete':'专注结束','shortBreak:complete':'小憩结束','longBreak:complete':'长休结束'};

// No audio generation, provider selection or credentials in the dialogue editor.
export async function openFocusDialogue({document,host,library,guard,choices,binding,escape:esc,icons,confirm,onClose=()=>{}}){
  await guard();const portal=document.createElement('div');portal.className='sd-focus-library-portal';
  portal.innerHTML='<section class="sd-focus-library" role="dialog" aria-modal="true" aria-label="自定义台词库"><header><h3>自定义台词库</h3><button class="sd-icon-btn" data-action="close" aria-label="关闭"><i class="fa-solid fa-xmark"></i></button></header><div class="sd-focus-library-body"></div><p role="status" class="sd-focus-library-status"></p></section>';
  host.appendChild(portal);const previous=document.activeElement,siblings=[...host.children].filter(el=>el!==portal).map(el=>[el,el.inert]);siblings.forEach(([el])=>{el.inert=true;});
  const body=portal.querySelector('.sd-focus-library-body'),status=portal.querySelector('[role=status]');
  let closed=false,busy=false,dirty=false,data,editing=null,folder=binding().characterKey||'';
  const check=async()=>{await guard();if(closed||!portal.isConnected)throw Error('台词库页面已关闭');};
  const button=(action,label)=>`<button class="sd-btn" data-action="${action}">${label}</button>`;
  function close(){if(closed)return;closed=true;portal.remove();siblings.forEach(([el,inert])=>{el.inert=inert;});if(previous?.isConnected)previous.focus();onClose();}
  function folders(){const map=new Map(choices().map(ch=>[focusVoiceCharacterKey(ch.avatar),ch.name]));for(const row of data.rows)if(!map.has(row.characterKey))map.set(row.characterKey,row.speaker);return [...map];}
  function render(){
    editing=null;dirty=false;
    body.innerHTML=`<div class="sd-focus-library-toolbar"><label>角色文件夹<select class="text_pole" data-field="folder"><option value="">全部角色</option>${folders().map(([key,name])=>`<option value="${esc(key)}" ${key===folder?'selected':''}>${esc(name)}</option>`).join('')}</select></label>${button('new','新建')}</div>
      <div class="sd-focus-library-list">${data.rows.filter(row=>!folder||row.characterKey===folder).map(row=>`<article><button class="sd-focus-library-item" data-action="edit" data-id="${esc(row.id)}"><b>${esc(row.text)}</b><span>${esc(row.speaker)} · ${row.moments.map(key=>moments[key]).join(' / ')}</span></button></article>`).join('')}</div>`;icons(portal);
  }
  async function reload(){const next=await library.snapshot();await check();data=next;render();}
  function edit(row){
    if(!row&&!folder){status.textContent='请先选择角色文件夹';return;}
    editing=row?structuredClone(row):{characterKey:folder,speaker:folders().find(([key])=>key===folder)?.[1]||'角色',text:'',moments:['focus:complete']};
    body.innerHTML=`<div class="sd-focus-library-toolbar">${button('back','返回列表')}<b>${esc(editing.speaker)}</b></div><label>语音内容<textarea class="text_pole" rows="4" maxlength="2000" data-field="text">${esc(editing.text)}</textarea></label><div class="sd-focus-library-moments">${Object.entries(moments).map(([key,label])=>`<label><input type="checkbox" data-moment="${key}" ${editing.moments.includes(key)?'checked':''}>${label}</label>`).join('')}</div><div class="sd-focus-library-toolbar">${button('save','保存')}${editing.id?button('remove','删除'):''}</div>`;
    body.querySelector('textarea').focus();
  }
  async function action(name,target){
    if(['back','close'].includes(name)&&dirty&&!await confirm('放弃修改','离开将丢弃未保存的台词，继续？'))return;
    await check();
    if(name==='close'){close();return;}if(name==='back')await reload();
    else if(name==='new')edit(null);
    else if(name==='edit')edit(data.rows.find(row=>row.id===target.dataset.id));
    else if(name==='save'){
      const draft={...editing,text:body.querySelector('textarea').value,moments:[...body.querySelectorAll('[data-moment]:checked')].map(el=>el.dataset.moment)};
      await library.put(draft,data.revision);await check();await reload();status.textContent='台词已保存';
    }else if(name==='remove'){
      if(!await confirm('删除台词','删除这条台词？已保存的录音不会被删除。'))return;await check();
      await library.remove(editing.id,data.revision);await check();await reload();status.textContent='台词已删除';
    }
  }
  async function run(work){if(busy||closed)return;busy=true;try{await work();}catch(error){if(!closed)status.textContent=error.message||'未完成，请重试';}finally{busy=false;}}
  portal.addEventListener('click',event=>{const target=event.target.closest('[data-action]');if(target)void run(()=>action(target.dataset.action,target));});
  portal.addEventListener('input',()=>{if(editing)dirty=true;});
  portal.addEventListener('change',event=>{if(event.target.dataset.field==='folder'&&!busy){folder=event.target.value;render();}});
  portal.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();void run(()=>action('close'));}
    if(event.key==='Tab'){const controls=[...portal.querySelectorAll('button,input,select,textarea')].filter(el=>!el.disabled&&el.getClientRects().length);if(event.shiftKey&&document.activeElement===controls[0]){event.preventDefault();controls.at(-1).focus();}else if(!event.shiftKey&&document.activeElement===controls.at(-1)){event.preventDefault();controls[0].focus();}}
  });
  try{await reload();portal.querySelector('[data-action=close]').focus();}catch(error){close();throw error;}
  return {close,element:portal};
}
