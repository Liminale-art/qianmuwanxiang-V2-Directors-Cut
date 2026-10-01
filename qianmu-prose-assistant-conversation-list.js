import {qianmuIconElement} from './qianmu-icon-renderer.js?v=1.59.416';

// A metadata-only view. The owner performs all history reads and mutations.
export function createProseAssistantConversationList({document,onOpen,onNew,onDelete,onRefresh,onRename}={}){
 if(!document||![onOpen,onNew,onDelete,onRefresh].every(callback=>typeof callback==='function'))throw TypeError('特助对话列表环境不可用');
 if(onRename!==undefined&&typeof onRename!=='function')throw TypeError('特助对话改名不可用');
 const make=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
 const element=make('section'),toolbar=make('div'),search=make('input'),list=make('div'),empty=make('p');
 element.className='qm-pa-conversation-list';element.setAttribute('aria-label','最近特助对话');toolbar.className='qm-pa-conversation-toolbar';
 search.type='search';search.className='text_pole';search.placeholder='搜索对话';search.setAttribute('aria-label','搜索特助对话');
 list.className='qm-pa-conversation-rows';list.setAttribute('aria-label','特助对话条目');empty.className='qm-pa-conversation-empty';
 const action=(label,name,glyph)=>{const button=make('button');button.type='button';button.dataset.paListAction=name;button.title=label;button.setAttribute('aria-label',label);button.append(qianmuIconElement(glyph,{document}));return button;};
 const refresh=action('刷新对话','refresh','fa-rotate-right'),create=action('新聊天','new','fa-plus'),multiple=action('多选对话','select','fa-list-check'),remove=action('删除所选对话','delete','fa-trash-can');
 toolbar.append(search,refresh,create,multiple,remove);element.append(toolbar,list,empty);
 let disposed=false,busy=false,refreshable=false,entries=[],currentKey='',limit=30,selecting=false,query='',editing=null;
 const selected=new Set(),rows=new Map(),listeners=[];
 const listen=(target,type,callback)=>{target.addEventListener(type,callback);listeners.push(()=>target.removeEventListener(type,callback));};
 const date=value=>{const at=new Date(value);return Number.isFinite(at.getTime())?at.toLocaleDateString('zh-CN'):'';};
 const title=entry=>String(entry.title||entry.charName||'场外对话');
 const filtered=()=>{const words=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);return entries.filter(entry=>{
  const at=new Date(entry.createdAt),iso=Number.isFinite(at.getTime())?at.toISOString().slice(0,10):'';
  const label=[title(entry),entry.charName||'',date(entry.createdAt),iso].join(' ').toLocaleLowerCase();return entry.key===editing?.key||words.every(word=>label.includes(word));
 });};
 function paint(){
  if(disposed)return;
  if(editing&&!entries.some(entry=>entry.key===editing.key)){editing.box.remove();editing=null;}
  const found=filtered(),visible=found.slice(0,limit),draftEntry=found.find(entry=>entry.key===editing?.key);
  if(draftEntry&&!visible.includes(draftEntry))visible.push(draftEntry);
  const shown=new Set(visible.map(entry=>entry.key));
  for(const button of [refresh,create,multiple,remove])button.disabled=busy||!!editing;
  refresh.disabled=(busy&&!refreshable)||!!editing?.saving;
  multiple.disabled=busy||!!editing||!found.length;multiple.setAttribute('aria-pressed',String(selecting));multiple.title=selecting?'全选已加载对话':'多选对话';multiple.setAttribute('aria-label',multiple.title);
  remove.hidden=!selecting||selected.size===0;remove.disabled=busy||!!editing||selected.size===0;search.disabled=!!editing;
  element.setAttribute('aria-busy',String(busy||editing?.saving===true));
  for(const [key,row] of rows)if(!shown.has(key)){if(editing?.key===key)editing=null;row.element.remove();rows.delete(key);}
  for(const [index,entry] of visible.entries()){
   let row=rows.get(entry.key);
   if(!row){const shell=make('div'),button=make('button'),name=make('span'),meta=make('span'),time=make('time'),badge=make('span','当前'),rename=action('改名','rename','fa-pen');
    shell.className='qm-pa-conversation-item';button.type='button';button.className='qm-pa-conversation-row';button.dataset.paConversationKey=entry.key;name.className='qm-pa-conversation-title';meta.className='qm-pa-conversation-meta';badge.className='qm-pa-conversation-current';rename.dataset.paRenameKey=entry.key;meta.append(time,badge);button.append(name,meta);shell.append(button,rename);row={element:shell,button,name,time,badge,rename};rows.set(entry.key,row);
   }
   const active=entry.key===currentKey,checked=selected.has(entry.key),label=title(entry),when=date(entry.createdAt);
   if(row.name.textContent!==label)row.name.textContent=label;if(row.time.textContent!==when)row.time.textContent=when;
   row.button.disabled=busy||!!editing;row.element.classList.toggle('is-selected',checked);row.badge.hidden=!active;
   row.button.hidden=editing?.key===entry.key;row.rename.hidden=!onRename||selecting||editing?.key===entry.key;row.rename.disabled=busy||!!editing;
   if(selecting)row.button.setAttribute('aria-pressed',String(checked));else row.button.removeAttribute('aria-pressed');
   if(active)row.button.setAttribute('aria-current','true');else row.button.removeAttribute('aria-current');
   row.button.setAttribute('aria-label',[label,when,active?'当前对话':''].filter(Boolean).join(' · '));
   if(list.children[index]!==row.element)list.insertBefore(row.element,list.children[index]||null);
  }
  if(editing){editing.input.disabled=busy||editing.saving;editing.save.disabled=busy||editing.saving;editing.cancel.disabled=editing.saving;}
  empty.hidden=found.length>0;empty.textContent=query.trim()?'没有匹配的对话':busy?'正在读取…':'暂无对话';
 }
 function finishRename(key){
  if(disposed||editing?.key!==key)return;const previous=editing;editing=null;previous.box.remove();paint();if(previous.row.rename.isConnected&&!previous.row.rename.hidden)previous.row.rename.focus({preventScroll:true});
 }
 function startRename(key){
  if(disposed||busy||selecting||editing||!onRename)return;const row=rows.get(key),entry=entries.find(item=>item.key===key);if(!row||!entry)return;
  const box=make('div'),input=make('input'),save=action('保存名称','save-name','fa-check'),cancel=action('取消改名','cancel-name','fa-xmark'),error=make('p');
  // Native maxLength counts UTF-16 units; validate code points without truncating existing names.
  box.className='qm-pa-conversation-edit';box.dataset.paConversationEditor=key;input.type='text';input.className='text_pole';input.value=title(entry);input.setAttribute('aria-label','对话名称');error.className='qm-pa-conversation-error';error.setAttribute('role','status');
  box.append(input,save,cancel,error);row.element.append(box);editing={key,row,box,input,save,cancel,error,original:input.value,saving:false};paint();input.focus({preventScroll:true});input.setSelectionRange(0,input.value.length);
 }
 async function saveRename(){
  const draft=editing;if(disposed||busy||!draft||draft.saving)return;const raw=draft.input.value,value=raw.trim();
  if(raw===draft.original){finishRename(draft.key);return;}
  const invalid=!value||Array.from(value).length>40?'名称请使用 1–40 个字。':/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029<>]/u.test(raw)?'名称不能包含换行、<、> 或不可见控制字符。':'';
  if(invalid){draft.error.textContent=invalid;draft.input.focus({preventScroll:true});return;}
  draft.saving=true;draft.error.textContent='';paint();
  try{if(await onRename(draft.key,value)===false)throw Error();if(!disposed&&editing===draft)finishRename(draft.key);}
  catch{if(!disposed&&editing===draft)draft.error.textContent='改名未完成，请重试。';}
  finally{if(!disposed&&editing===draft){draft.saving=false;paint();}}
 }
 function resetSelection(){if(disposed)return;selecting=false;selected.clear();paint();}
 listen(search,'input',()=>{if(disposed)return;query=search.value;limit=30;list.scrollTop=0;resetSelection();});
 listen(toolbar,'click',event=>{
  const button=event.target.closest?.('[data-pa-list-action]');if(!button||disposed||button.disabled)return;event.stopPropagation();
  const name=button.dataset.paListAction;
  if(name==='new')onNew();else if(name==='refresh')onRefresh();else if(name==='delete'){if(selected.size)onDelete([...selected]);}
  else if(name==='select'){if(selecting)for(const entry of filtered().slice(0,limit))selected.add(entry.key);else selecting=true;paint();}
 });
 listen(list,'click',event=>{
  const control=event.target.closest?.('[data-pa-list-action]'),editor=event.target.closest?.('[data-pa-conversation-editor]');
  if(control||editor){event.stopPropagation();if(disposed||control?.disabled)return;if(control?.dataset.paListAction==='rename')startRename(control.dataset.paRenameKey);else if(control?.dataset.paListAction==='save-name')void saveRename();else if(control?.dataset.paListAction==='cancel-name'&&editing&&!editing.saving)finishRename(editing.key);return;}
  const row=event.target.closest?.('[data-pa-conversation-key]');if(!row||disposed||busy||editing||row.disabled)return;event.stopPropagation();const key=row.dataset.paConversationKey;
  if(!rows.has(key))return;
  if(selecting){if(selected.has(key))selected.delete(key);else selected.add(key);if(!selected.size)selecting=false;paint();}else onOpen(key);
 });
 listen(list,'keydown',event=>{if(!event.target.closest?.('[data-pa-conversation-editor]'))return;event.stopPropagation();if(event.isComposing)return;
  if(event.key==='Escape'){event.preventDefault();if(editing&&!editing.saving)finishRename(editing.key);}
  else if(event.key==='Enter'&&event.target===editing?.input){event.preventDefault();void saveRename();}
 });
 listen(list,'scroll',()=>{if(disposed||busy||list.scrollHeight-list.clientHeight-list.scrollTop>24||limit>=filtered().length)return;limit+=30;paint();});
 return Object.freeze({element,render({entries:next,currentKey:key='',busy:pending=false,refreshable:allowRefresh=false}={}){
  if(disposed)return;if(!Array.isArray(next))throw TypeError('特助对话目录不可用');
  entries=next.filter(entry=>entry&&typeof entry.key==='string'&&!entry.deleted).slice().sort((a,b)=>(b.lastUsedAt||b.updatedAt||b.createdAt||0)-(a.lastUsedAt||a.updatedAt||a.createdAt||0)||(b.updatedAt||0)-(a.updatedAt||0)||a.key.localeCompare(b.key));
  const keys=new Set(entries.map(entry=>entry.key)),hadSelection=selected.size>0;for(const key of selected)if(!keys.has(key))selected.delete(key);if(hadSelection&&!selected.size)selecting=false;
  currentKey=key;busy=pending===true;refreshable=allowRefresh===true;paint();
 },resetSelection,finishRename,dispose(){if(disposed)return;disposed=true;listeners.splice(0).forEach(remove=>remove());editing=null;rows.clear();selected.clear();element.remove();}});
}
