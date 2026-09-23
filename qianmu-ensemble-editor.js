import {normalizeEnsembleLibrary,normalizeEnsembleChatSelection} from './qianmu-ensemble-selection.js?v=1.59.328';
const copy=value=>JSON.parse(JSON.stringify(value));
const fail=message=>{throw Object.assign(Error(message),{code:'ensemble_editor'});};
const id=prefix=>`${prefix}-${crypto.randomUUID()}`;
const messages=error=>error?.code==='st_account_storage_conflict'?'另一端已修改方案，请刷新后重新打开编辑；当前草稿保留。':error?.writeState==='unconfirmed'?'保存结果未确认，请先刷新核对，不会自动重试。':error?.code==='ensemble_editor'?error.message:'读取或保存未完成，请检查连接后重试；已有方案未被清空。';

// Session model, independent of DOM. It borrows an account-scoped store rather
// than closing/recreating its verified cache each time a panel is rendered.
export function createEnsembleLibraryEditor({store,chatKey,isCurrent,readTargets,readArtists=()=>[],onChange=()=>{},beforeCommit=()=>{},afterCommit=()=>{},onCommitted=()=>{},uid=id}={}){
  if(!store||typeof isCurrent!=='function'||typeof readTargets!=='function')fail('方案库环境未就绪');
  if((store.chatKey||null)!==(chatKey||null))fail('方案库聊天归属不一致');
  let library=null,selection=null,draft=null,busy=false,closed=false,retired=false,search='',archived=false,message='',error='',needsRefresh=false,pending=null,draftExpected=null;
  const current=()=>{try{const value=isCurrent();if(value&&typeof value.then==='function'){void Promise.resolve(value).catch(()=>{});return false;}return !closed&&!retired&&value===true;}catch(_){return false;}};
  const retire=()=>{library=null;selection=null;draft=null;draftExpected=null;error='方案库页面或账户已变化，请重新打开。';};
  const check=()=>{if(!current()){retire();emit('view');fail('方案库页面或账户已变化');}};
  const view=()=>({ready:Boolean(library),busy,chatKey:chatKey||null,library:library?copy(library.value):null,selection:selection?copy(selection.value):null,
    draft:draft?copy(draft):null,search,archived,message,error,needsRefresh,targets:current()?copy(readTargets()):[],artists:current()?copy(readArtists()):[]});
  let notifying=false;const observers=new Set([onChange]);
  const emit=kind=>{if(closed||notifying)return;if(!current())retire();notifying=true;try{const snapshot=view();for(const observer of observers)try{const value=observer(snapshot,kind);value?.catch?.(()=>{});}catch(_){/* Observers do not turn a confirmed save into an error. */}}finally{notifying=false;}};
  const available=()=>{check();if(busy)fail('正在读取或保存，请稍候');if(!library)fail('请先读取方案库');};
  const targets=()=>{const rows=readTargets();if(!Array.isArray(rows)||rows.length>64||new Set(rows.map(r=>r.id)).size!==rows.length)fail('绘制线路列表无效');return rows;};
  async function run(work,committing=false){
    check();if(busy)fail('正在读取或保存，请稍候');busy=true;error='';message='';emit('view');
    try{const result=await work();check();return result;}
    catch(cause){if(!closed){if(['st_account_storage_account','st_account_storage_scope'].includes(cause?.code)){retired=true;retire();}else{error=messages(cause);if(cause?.code==='st_account_storage_conflict'||cause?.writeState==='unconfirmed')needsRefresh=true;}}throw cause;}
    finally{try{if(committing)await afterCommit();}finally{busy=false;emit('view');}}
  }
  async function load({fresh=false}={}){
    check();if(pending)return pending;if(library&&!fresh)return view();
    pending=run(async()=>{
      const values=await Promise.all([store.readLibrary({fresh}),chatKey?store.readSelection({fresh}):null]);check();
      library=values[0];selection=values[1];needsRefresh=Boolean(draft&&draftExpected&&JSON.stringify(draftExpected.value)!==JSON.stringify(library.value));
      message=needsRefresh?'已读到新版本，草稿保留；请关闭编辑再重新打开。':'';return view();
    });
    try{return await pending;}finally{pending=null;}
  }
  function edit(schemeId=''){
    available();const item=schemeId?library.value.schemes.find(row=>row.id===schemeId):null;if(schemeId&&!item)fail('方案不存在，请刷新列表');
    draft=item?{...copy(item),tagText:item.tags.join(', ')}:{id:uid('style'),revision:'draft',name:'',description:'',tags:[],tagText:'',archived:false,binding:{routeId:'',artistPresetId:''}};
    draftExpected=library;needsRefresh=false;error='';message='';emit('view');
  }
  function setField(field,value){
    available();if(!draft)fail('请先打开方案编辑');
    if(['name','description','tagText'].includes(field))draft[field]=String(value);
    else if(field==='routeId'){draft.binding.routeId=String(value);}
    else if(field==='artistPresetId')draft.binding.artistPresetId=String(value);
    else fail('未知方案字段');error='';message='';emit(field==='routeId'?'view':'draft');
  }
  async function save(){
    available();if(!draft||needsRefresh)fail('请先刷新并重新打开方案编辑');
    const target=targets().find(row=>row.id===draft.binding.routeId&&row.available!==false);if(!target)fail('请选择仍可用的绘制线路');
    if(draft.binding.artistPresetId&&(!target.artistCapable||!readArtists().some(row=>row.id===draft.binding.artistPresetId)))fail('画师绑定不适用于此线路，请重新选择');
    const row={...copy(draft),revision:uid('revision'),tags:[...new Set(draft.tagText.split(/[,，\n]/).map(t=>t.trim()).filter(Boolean))]};delete row.tagText;
    const previous=draftExpected,next=normalizeEnsembleLibrary({...copy(previous.value),schemes:previous.value.schemes.some(item=>item.id===row.id)?previous.value.schemes.map(item=>item.id===row.id?row:item):[...previous.value.schemes,row]});
    return run(async()=>{await beforeCommit('library');check();const saved=await store.saveLibrary(next,previous);check();library=saved;draft=null;draftExpected=null;needsRefresh=false;await onCommitted({kind:'library',value:saved.value});check();message='方案已保存';return view();},true);
  }
  async function select(change){
    available();if(!chatKey||!selection)fail('请先进入聊天，再选择本聊天方案');if(needsRefresh)fail('请先刷新方案库');
    const previous=selection,next=normalizeEnsembleChatSelection({...copy(previous.value),...change,revision:uid('selection')},{namespace:store.namespace,chatKey});
    return run(async()=>{await beforeCommit('selection');check();const saved=await store.saveSelection(next,previous);check();selection=saved;await onCommitted({kind:'selection',value:saved.value,change});check();message='本聊天选择已保存';return view();},true);
  }
  async function toggleScheme(schemeId){
    available();const row=library.value.schemes.find(row=>row.id===schemeId);if(!row||row.archived)fail('此方案不存在或已归档');
    const ids=selection?.value.schemeIds||[];return select({schemeIds:ids.includes(schemeId)?ids.filter(value=>value!==schemeId):[...ids,schemeId]});
  }
  async function archive(schemeId){
    available();if(needsRefresh)fail('请先刷新方案库');const previous=library,row=previous.value.schemes.find(item=>item.id===schemeId);if(!row)fail('方案不存在');
    const next=normalizeEnsembleLibrary({...copy(previous.value),schemes:previous.value.schemes.map(item=>item.id===schemeId?{...item,archived:!item.archived,revision:uid('revision')}:item)});
    return run(async()=>{await beforeCommit('library');check();const saved=await store.saveLibrary(next,previous);check();library=saved;if(draft?.id===schemeId){draft=null;draftExpected=null;}await onCommitted({kind:'library',value:saved.value});check();message=row.archived?'方案已恢复':'方案已归档，历史记录与其他聊天选择保留';return view();},true);
  }
  return Object.freeze({load,refresh:()=>load({fresh:true}),edit,setField,save,toggleScheme,archive,
    setEnabled:value=>select({enabled:value}),setStyleLock:value=>select({styleLock:value}),
    setSearch(value){available();search=String(value).slice(0,300);emit('list');},
    showArchived(value){available();archived=Boolean(value);emit('list');},
    cancelEdit(){available();draft=null;draftExpected=null;error='';message='';emit('view');},
    subscribe(observer){check();observers.add(observer);return ()=>observers.delete(observer);},
    snapshot(){check();return view();},close(){closed=true;observers.clear();draft=null;draftExpected=null;library=null;selection=null;},
  });
}
