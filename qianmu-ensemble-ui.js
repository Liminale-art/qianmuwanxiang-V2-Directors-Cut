import {createEnsembleStorage} from './qianmu-ensemble-storage.js?v=1.59.376';
import {createEnsembleLibraryEditor} from './qianmu-ensemble-editor.js?v=1.59.376';
import {mountEnsembleLibrary} from './qianmu-ensemble-view.js?v=1.59.376';
export {openEnsembleTargetPicker} from './qianmu-ensemble-target-picker.js';

// One account/chat controller survives modal re-renders. Detach removes only
// DOM listeners; dispose retires data on an account/chat/runtime change.
export function createStoryboardEnsembleController({state,chatKey,isCurrent,resolveNamespace,readTargets,readArtists,configureTarget,changed,publish,uid,
  createStore=createEnsembleStorage,mount=mountEnsembleLibrary}={}){
  let closed=false,store,model,view,pending,root=null,ticket=0,stagedRoute=null,attaching=null;
  const current=()=>!closed&&isCurrent()===true;
  const check=()=>{if(!current())throw Object.assign(Error('镜组页面或聊天已变化'),{code:'ensemble_editor'});return true;};
  const adopt=async()=>{check();if(state.routing.styleLibrary===true)return;changed();state.routing.styleLibrary=true;await publish();check();};
  const configure=typeof configureTarget==='function'?async({routeId,schemeId,configuredTarget})=>{
    check();const existing=state.routing.rules.find(row=>row.id===routeId),initial=configuredTarget?.target||existing?.target;
    const picked=await configureTarget({target:initial?JSON.parse(JSON.stringify(initial)):null,schemeId});check();if(!picked)return null;
    const shared=model?.snapshot().library?.schemes.some(row=>row.id!==schemeId&&row.binding.routeId===routeId);
    const id=configuredTarget?.id||(!shared&&existing?existing.id:uid('style-route')),providerId=picked.target?.providerId;
    if(!providerId)throw Error('生成设置未完成');
    return {id,name:picked.target.comfyWorkflowBinding?.name||picked.target.modelId||providerId,providerLabel:providerId,label:picked.label||'',available:true,artistCapable:picked.artistCapable===true,target:picked.target,
      previousTarget:(configuredTarget?.previousTarget||existing?.target)?JSON.parse(JSON.stringify(configuredTarget?.previousTarget||existing.target)):null};
  }:undefined;
  const beforeCommit=async(kind,details)=>{
    check();changed();stagedRoute=null;
    const configured=details?.draft?.configuredTarget;if(kind!=='library'||!configured)return;
    const existing=state.routing.rules.find(row=>row.id===configured.id);
    if(existing&&JSON.stringify(existing.target)===JSON.stringify(configured.target))return;
    if(existing&&JSON.stringify(existing.target)!==JSON.stringify(configured.previousTarget))throw Error('生成设置已变化，请重新选择');
    if(existing&&details.library.schemes.some(row=>row.id!==details.draft.id&&row.binding.routeId===configured.id))throw Error('生成设置已变化，请重新选择');
    if(!existing&&state.routing.rules.length>=50)throw Error('生成设置已满，请先整理风格方案');
    const row={id:configured.id,name:details.draft.name,target:JSON.parse(JSON.stringify(configured.target)),enabled:true};
    if(existing)state.routing.rules=state.routing.rules.map(item=>item===existing?row:item);else state.routing.rules.push(row);
    stagedRoute={row,previous:existing};await publish();check();
  };
  const afterCommit=async({confirmed,error}={})=>{
    const own=stagedRoute;stagedRoute=null;
    if(current()){
      if(own&&!confirmed&&error&&error.writeState!=='unconfirmed'&&state.routing.rules.includes(own.row)){state.routing.rules=own.previous?state.routing.rules.map(row=>row===own.row?own.previous:row):state.routing.rules.filter(row=>row!==own.row);await publish();}
      changed();
    }
  };
  async function load(){
    check();if(pending)return pending;
    if(model){try{model.snapshot();return model;}catch(_){model.close();model=null;store?.close();store=null;}}
    pending=(async()=>{
      const namespace=await resolveNamespace();check();
      store=await createStore({namespace,chatKey,isCurrent:current,resolveNamespace});check();
      model=createEnsembleLibraryEditor({store,chatKey,isCurrent:current,readTargets,readArtists,uid,configureTarget:configure,beforeCommit,afterCommit,
        onCommitted:async({kind,change})=>{check();if(kind==='selection'&&Object.hasOwn(change,'enabled'))await adopt();}});
      await model.load();check();
      // A confirmed choice made on another device is an existing explicit
      // adoption, not a migration of the user's old shot-type routes.
      if(model.snapshot().selection?.enabled)await adopt();
      return model;
    })();
    try{return await pending;}catch(error){model?.close();model=null;store?.close();store=null;throw error;}finally{pending=null;}
  }
  function detach(){ticket++;view?.close();view=null;root=null;attaching=null;}
  function attach(target){
    if(root===target&&current()&&target.isConnected){if(attaching)return attaching;if(view)return Promise.resolve(true);}
    detach();root=target;const own=++ticket;const visible=()=>current()&&root===target&&ticket===own&&target.isConnected;
    if(!model)target.textContent='正在读取风格方案…';
    const loading=(async()=>{
    try{
      const editor=await load();if(!visible())return false;
      view=mount(target,{model:editor});await view.ready;return visible();
    }catch(error){
      if(visible()){view?.close();view=null;target.textContent='方案库暂未载入，已有内容未清空。';const button=target.ownerDocument.createElement('button');button.type='button';button.className='sd-btn';button.textContent='重试';button.addEventListener('click',()=>void attach(target));target.append(button);}
      return false;
    }
    })();attaching=loading;void loading.finally(()=>{if(attaching===loading)attaching=null;});return loading;
  }
  return {mount:attach,detach,load,get model(){return model;},dispose(){if(closed)return;detach();closed=true;model?.close();model=null;store?.close();store=null;}};
}
