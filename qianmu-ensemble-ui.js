import {createEnsembleStorage} from './qianmu-ensemble-storage.js?v=1.59.333';
import {createEnsembleLibraryEditor} from './qianmu-ensemble-editor.js?v=1.59.333';
import {mountEnsembleLibrary} from './qianmu-ensemble-view.js?v=1.59.333';

// One account/chat controller survives modal re-renders. Detach removes only
// DOM listeners; dispose retires data on an account/chat/runtime change.
export function createStoryboardEnsembleController({state,chatKey,isCurrent,resolveNamespace,readTargets,readArtists,changed,publish,uid,
  createStore=createEnsembleStorage,mount=mountEnsembleLibrary}={}){
  let closed=false,store,model,view,pending,root=null,ticket=0;
  const current=()=>!closed&&isCurrent()===true;
  const check=()=>{if(!current())throw Object.assign(Error('镜组页面或聊天已变化'),{code:'ensemble_editor'});return true;};
  const adopt=async()=>{check();if(state.routing.styleLibrary===true)return;changed();state.routing.styleLibrary=true;await publish();check();};
  async function load(){
    check();if(pending)return pending;
    if(model){try{model.snapshot();return model;}catch(_){model.close();model=null;store?.close();store=null;}}
    pending=(async()=>{
      const namespace=await resolveNamespace();check();
      store=await createStore({namespace,chatKey,isCurrent:current,resolveNamespace});check();
      model=createEnsembleLibraryEditor({store,chatKey,isCurrent:current,readTargets,readArtists,uid,beforeCommit:()=>{check();changed();},afterCommit:()=>{if(current())changed();},
        onCommitted:async({kind,change})=>{check();if(kind==='selection'&&Object.hasOwn(change,'enabled'))await adopt();}});
      await model.load();check();
      // A confirmed choice made on another device is an existing explicit
      // adoption, not a migration of the user's old shot-type routes.
      if(model.snapshot().selection?.enabled)await adopt();
      return model;
    })();
    try{return await pending;}catch(error){model?.close();model=null;store?.close();store=null;throw error;}finally{pending=null;}
  }
  function detach(){ticket++;view?.close();view=null;root=null;}
  async function attach(target){
    detach();root=target;const own=++ticket;const visible=()=>current()&&root===target&&ticket===own&&target.isConnected;
    if(!model)target.textContent='正在读取风格方案…';
    try{
      const editor=await load();if(!visible())return false;
      view=mount(target,{model:editor});await view.ready;return visible();
    }catch(error){
      if(visible()){target.textContent='方案库暂未载入，已有内容未清空。';const button=target.ownerDocument.createElement('button');button.type='button';button.className='sd-btn';button.textContent='重试';button.addEventListener('click',()=>void attach(target));target.append(button);}
      return false;
    }
  }
  return {mount:attach,detach,load,get model(){return model;},dispose(){if(closed)return;detach();closed=true;model?.close();model=null;store?.close();store=null;}};
}
