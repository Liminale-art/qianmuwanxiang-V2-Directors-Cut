import {qianmuIconElement} from './qianmu-icon-renderer.js';

// A metadata-only view. The owner performs all history reads and mutations.
export function createProseAssistantConversationList({document,onOpen,onNew,onDelete,onRefresh}={}){
 if(!document||![onOpen,onNew,onDelete,onRefresh].every(callback=>typeof callback==='function'))throw TypeError('特助对话列表环境不可用');
 const make=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
 const element=make('section'),toolbar=make('div'),search=make('input'),list=make('div'),empty=make('p');
 element.className='qm-pa-conversation-list';element.setAttribute('aria-label','最近特助对话');toolbar.className='qm-pa-conversation-toolbar';
 search.type='search';search.className='text_pole';search.placeholder='搜索对话';search.setAttribute('aria-label','搜索特助对话');
 list.className='qm-pa-conversation-rows';list.setAttribute('aria-label','特助对话条目');empty.className='qm-pa-conversation-empty';
 const action=(label,name,glyph)=>{const button=make('button');button.type='button';button.dataset.paListAction=name;button.title=label;button.setAttribute('aria-label',label);button.append(qianmuIconElement(glyph,{document}));return button;};
 const refresh=action('刷新对话','refresh','fa-rotate-right'),create=action('新聊天','new','fa-plus'),multiple=action('多选对话','select','fa-list-check'),remove=action('删除所选对话','delete','fa-trash-can');
 toolbar.append(search,refresh,create,multiple,remove);element.append(toolbar,list,empty);
 let disposed=false,busy=false,refreshable=false,entries=[],currentKey='',limit=30,selecting=false,query='';
 const selected=new Set(),rows=new Map(),listeners=[];
 const listen=(target,type,callback)=>{target.addEventListener(type,callback);listeners.push(()=>target.removeEventListener(type,callback));};
 const date=value=>{const at=new Date(value);return Number.isFinite(at.getTime())?at.toLocaleDateString('zh-CN'):'';};
 const title=entry=>String(entry.title||entry.charName||'场外对话');
 const filtered=()=>{const words=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);return entries.filter(entry=>{
  const at=new Date(entry.createdAt),iso=Number.isFinite(at.getTime())?at.toISOString().slice(0,10):'';
  const label=[title(entry),entry.charName||'',date(entry.createdAt),iso].join(' ').toLocaleLowerCase();return words.every(word=>label.includes(word));
 });};
 function paint(){
  if(disposed)return;
  const found=filtered(),visible=found.slice(0,limit),shown=new Set(visible.map(entry=>entry.key));
  for(const button of [refresh,create,multiple,remove])button.disabled=busy;
  refresh.disabled=busy&&!refreshable;
  multiple.disabled=busy||!found.length;multiple.setAttribute('aria-pressed',String(selecting));multiple.title=selecting?'全选已加载对话':'多选对话';multiple.setAttribute('aria-label',multiple.title);
  remove.hidden=!selecting||selected.size===0;remove.disabled=busy||selected.size===0;
  element.setAttribute('aria-busy',String(busy));
  for(const [key,row] of rows)if(!shown.has(key)){row.button.remove();rows.delete(key);}
  for(const [index,entry] of visible.entries()){
   let row=rows.get(entry.key);
   if(!row){const button=make('button'),name=make('span'),meta=make('span'),time=make('time'),badge=make('span','当前');
    button.type='button';button.className='qm-pa-conversation-row';button.dataset.paConversationKey=entry.key;name.className='qm-pa-conversation-title';meta.className='qm-pa-conversation-meta';badge.className='qm-pa-conversation-current';meta.append(time,badge);button.append(name,meta);row={button,name,time,badge};rows.set(entry.key,row);
   }
   const active=entry.key===currentKey,checked=selected.has(entry.key),label=title(entry),when=date(entry.createdAt);
   if(row.name.textContent!==label)row.name.textContent=label;if(row.time.textContent!==when)row.time.textContent=when;
   row.button.disabled=busy;row.button.classList.toggle('is-selected',checked);row.button.classList.toggle('is-current',active);row.badge.hidden=!active;
   if(selecting)row.button.setAttribute('aria-pressed',String(checked));else row.button.removeAttribute('aria-pressed');
   if(active)row.button.setAttribute('aria-current','true');else row.button.removeAttribute('aria-current');
   row.button.setAttribute('aria-label',[label,when,active?'当前对话':''].filter(Boolean).join(' · '));
   if(list.children[index]!==row.button)list.insertBefore(row.button,list.children[index]||null);
  }
  empty.hidden=found.length>0;empty.textContent=query.trim()?'没有匹配的对话':busy?'正在读取…':'暂无对话';
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
  const row=event.target.closest?.('[data-pa-conversation-key]');if(!row||disposed||busy||row.disabled)return;event.stopPropagation();const key=row.dataset.paConversationKey;
  if(!rows.has(key))return;
  if(selecting){if(selected.has(key))selected.delete(key);else selected.add(key);if(!selected.size)selecting=false;paint();}else onOpen(key);
 });
 listen(list,'scroll',()=>{if(disposed||busy||list.scrollHeight-list.clientHeight-list.scrollTop>24||limit>=filtered().length)return;limit+=30;paint();});
 return Object.freeze({element,render({entries:next,currentKey:key='',busy:pending=false,refreshable:allowRefresh=false}={}){
  if(disposed)return;if(!Array.isArray(next))throw TypeError('特助对话目录不可用');
  entries=next.filter(entry=>entry&&typeof entry.key==='string'&&!entry.deleted).slice().sort((a,b)=>(b.lastUsedAt||b.updatedAt||b.createdAt||0)-(a.lastUsedAt||a.updatedAt||a.createdAt||0)||(b.updatedAt||0)-(a.updatedAt||0)||a.key.localeCompare(b.key));
  const keys=new Set(entries.map(entry=>entry.key)),hadSelection=selected.size>0;for(const key of selected)if(!keys.has(key))selected.delete(key);if(hadSelection&&!selected.size)selecting=false;
  currentKey=key;busy=pending===true;refreshable=allowRefresh===true;paint();
 },resetSelection,dispose(){if(disposed)return;disposed=true;listeners.splice(0).forEach(remove=>remove());rows.clear();selected.clear();element.remove();}});
}
