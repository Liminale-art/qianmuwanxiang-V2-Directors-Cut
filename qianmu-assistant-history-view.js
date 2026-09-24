import {createAssistantHistoryManager} from './qianmu-assistant-history-manager.js';
import {qianmuIconElement} from './qianmu-icon-renderer.js';

export function openAssistantHistoryManager({parent,isCurrent,check,confirm,download,otherModules=0,createManager=createAssistantHistoryManager,...options}){
 if(!parent?.isConnected||typeof isCurrent!=='function'||typeof check!=='function'||typeof confirm!=='function'||typeof download!=='function')throw Error('助手历史管理环境不可用');
 const document=parent.ownerDocument,view=document.defaultView,focused=document.activeElement;
 let closed=false,busy=false,manager=null,page=null,resolve,detail=false;const selected=new Set(),finished=new Promise(done=>resolve=done);
 const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
 const dialog=el('dialog',undefined,'qm-assistant-manager');dialog.setAttribute('aria-label','管理 ST 助手记录');
 const header=el('header'),title=el('strong','ST 助手记录'),toolbar=el('nav'),main=el('main'),list=el('section'),preview=el('pre'),footer=el('footer'),status=el('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');preview.hidden=true;
 const buttons=[],rowControls=[];
 const button=(label,icon,action,text,track=true)=>{const b=el('button');b.type='button';b.title=label;b.setAttribute('aria-label',label);const glyph=qianmuIconElement('fa-'+icon,{document});if(glyph)b.append(glyph);if(text)b.append(el('span',text));b.addEventListener('click',()=>{void action();});if(track)buttons.push(b);return b;};
 const back=button('返回会话列表','arrow-left',()=>{detail=false;preview.hidden=true;list.hidden=false;title.textContent='ST 助手记录';controls();});
 const closeButton=button('关闭助手记录','xmark',()=>stop());header.append(back,title,closeButton);
 const reload=button('刷新助手记录','rotate',()=>load(0,null)),all=button('选择本页全部记录','list-check',()=>{
  if(busy||manager?.progress()||!page)return;const ids=page.rows.filter(row=>row.status==='ready').map(row=>row.id),full=ids.every(id=>selected.has(id));selected.clear();if(!full)for(const id of ids)selected.add(id);paint();
 });
 const previous=button('上一页助手记录','chevron-left',()=>load(Math.max(0,page.offset-8),page.snapshot)),next=button('下一页助手记录','chevron-right',()=>load(page.nextOffset,page.snapshot)),position=el('small');
 toolbar.append(reload,all,position,previous,next);
 const hint=el('p','仅当前 ST 账户，每页 8 份。选择只在本页有效；备份包含所选完整私人问答。','qm-assistant-manager-hint');
 const boundary=el('p','清空不删除原聊天，不回收旧版本文件。关闭只停止后续操作，未确认的写入可能已保存。','qm-assistant-manager-hint');
 const actions=el('div',undefined,'qm-assistant-manager-actions'),exportButton=button('备份选中助手记录','download',backup,'备份选中'),clearButton=button('清空选中助手会话','trash-can',clear,'清空选中');actions.append(exportButton,clearButton);
 main.append(list,preview);footer.append(status,boundary,actions);dialog.append(header,hint,toolbar,main,footer);
 if(otherModules>0)hint.textContent+=` 同时勾选的其他 ${otherModules} 个模块本次不处理。`;
 const current=()=>!closed&&parent.isConnected&&isCurrent()===true;
 const guard=()=>{check();if(!current())throw Error('助手管理页面已变化');};
 function controls(){
  const pending=manager?.progress();for(const b of buttons)b.disabled=busy;
  closeButton.disabled=false;back.hidden=!detail;back.disabled=busy;reload.disabled=busy||Boolean(pending);all.disabled=busy||detail||!page||Boolean(pending);
  previous.disabled=busy||detail||!page||page.offset===0||Boolean(pending);next.disabled=busy||detail||!page||page.nextOffset===null||Boolean(pending);
  exportButton.disabled=busy||detail||selected.size===0;clearButton.disabled=busy||detail||selected.size===0;
  for(const row of rowControls){row.checkbox.disabled=busy||Boolean(pending)||!row.ready;row.open.disabled=busy||!row.ready;}
  clearButton.title=pending?'重试原清空范围':'清空选中助手会话';dialog.setAttribute('aria-busy',String(busy));
 }
 function paint(){
  list.replaceChildren();rowControls.length=0;if(!page){position.textContent='';controls();return;}
  position.textContent=page.total?`${page.offset+1}–${page.offset+page.rows.length} / ${page.total}`:'0 份';
  if(!page.rows.length)list.append(el('p','当前账户没有助手会话文件。'));
  for(const row of page.rows){
   const item=el('article'),checkbox=el('input'),label=el('label'),text=el('div');checkbox.type='checkbox';checkbox.checked=selected.has(row.id);checkbox.disabled=row.status!=='ready'||busy||Boolean(manager?.progress());checkbox.setAttribute('aria-label','选择 '+row.title);
   checkbox.addEventListener('change',()=>{if(busy||manager?.progress())return;if(checkbox.checked)selected.add(row.id);else selected.delete(row.id);controls();});
   const name=el('strong',row.title),metadata=el('small',row.status==='ready'?`${row.owner} · ${row.count} 轮 · ${(row.bytes/1024).toFixed(1)} KiB${row.updatedAt?' · '+new Date(row.updatedAt).toLocaleDateString():''}`:'读取失败，未按空会话处理；请刷新重试');text.append(name,metadata);label.append(checkbox,text);
   const open=button('查看 '+row.title,'eye',()=>show(row),undefined,false);rowControls.push({checkbox,open,ready:row.status==='ready'});item.append(label,open);list.append(item);
  }
  options.applyIcons?.(dialog);controls();
 }
 async function operate(work){
  if(busy||!current())return;busy=true;controls();
  try{guard();await work();guard();}
  catch(cause){if(!current()){stop();return;}try{guard();await manager?.guard();}catch{stop();return;}
   const p=manager?.progress();status.textContent=(p?`已确认 ${p.confirmed}/${p.total}；${p.uncertain?'当前写入未确认，请保留窗口重试。':''}`:'')+(String(cause?.code||'').startsWith('assistant_history_')?cause.message:'助手记录操作未完成，请刷新核对；未按空记录处理。');
  }finally{busy=false;if(!closed){controls();if(!detail)paint();}}
 }
 async function load(offset=0,snapshot=null){return operate(async()=>{
  status.textContent='正在读取本页助手记录…';preview.textContent='';preview.hidden=true;list.hidden=false;detail=false;title.textContent='ST 助手记录';selected.clear();
  page=null;paint();if(!manager){const created=await createManager({...options,isCurrent:current});try{guard();}catch(cause){created.close();throw cause;}manager=created;}guard();
  const result=await manager.page(offset,snapshot);guard();page=result;paint();status.textContent='选择会话可备份或清空；查看不会修改内容。';
 });}
 async function show(row){return operate(async()=>{const state=await manager.view(row.id);guard();detail=true;title.textContent=row.title;list.hidden=true;preview.hidden=false;
  preview.textContent=state.rows.length?state.rows.map(item=>`USER\n${item.user}\n\n场外特助${item.status==='complete'?'':item.status==='failed'?'（未完成）':'（已停止）'}\n${item.assistant}`).join('\n\n────────\n\n'):'此会话已清空。';
 });}
 async function backup(){return operate(async()=>{const text=await manager.backup([...selected]);guard();await download(new Blob([text],{type:'application/json;charset=utf-8'}),'qianmu-assistant-history.json');guard();status.textContent='已发起完整备份下载，请确认文件保存成功。未发送给模型或外部服务。';});}
 async function clear(){return operate(async()=>{
  const result=await manager.clear([...selected],confirm);guard();if(result.status==='cancelled'){status.textContent='已取消，未清空记录。';return;}
  const receipt=result.status==='empty'?'所选会话已经为空，未追加写入。':`已清空 ${result.confirmed} 份会话；旧版本文件保留，未释放其磁盘空间。`;
  page=null;selected.clear();detail=false;preview.textContent='';preview.hidden=true;list.hidden=false;title.textContent='ST 助手记录';paint();
  try{page=await manager.page(0,null);guard();paint();status.textContent=receipt;}catch(cause){guard();status.textContent=receipt+' 列表暂未刷新，请点击刷新核对。';}
 });}
 function stop(){if(closed)return;closed=true;manager?.close();selected.clear();preview.textContent='';list.replaceChildren();observer.disconnect();view.removeEventListener('pagehide',stop);dialog.removeEventListener('cancel',cancel);dialog.removeEventListener('close',stop);if(dialog.open)dialog.close();dialog.remove();if(focused?.isConnected&&document.visibilityState!=='hidden')focused.focus({preventScroll:true});resolve();}
 const cancel=event=>{event.preventDefault();event.stopPropagation();stop();},observer=new view.MutationObserver(()=>{if(!current()||!dialog.isConnected)stop();});
 if(!document.querySelector('link[data-qm-assistant-manager-style]')){const style=el('link');style.rel='stylesheet';style.setAttribute('data-qm-assistant-manager-style','');style.href=new URL('./qianmu-assistant-history-view.css',import.meta.url).href;document.head.append(style);style.addEventListener('error',()=>style.remove(),{once:true});}
 dialog.addEventListener('cancel',cancel);dialog.addEventListener('close',stop);view.addEventListener('pagehide',stop);parent.append(dialog);observer.observe(document.documentElement,{childList:true,subtree:true});
 try{guard();options.applyIcons?.(dialog);dialog.showModal();void load();}catch(cause){stop();throw cause;}
 return {element:dialog,finished,dispose:stop};
}
