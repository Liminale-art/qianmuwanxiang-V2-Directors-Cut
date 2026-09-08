import { createStoryboardPackageJournal } from './qianmu-storyboard-package-journal.js';
import { collectRestoreStorage, clearRestoreStorage } from './qianmu-storyboard-restore-storage.js';

let started=false,request=0,id='',pending=null;
const guard=()=>new Promise(resolve=>{pending={request:++request,resolve};self.postMessage({id,guard:request});});
const resolveAliasTargets=targets=>new Promise(resolve=>{pending={request:++request,resolve,type:'targets'};self.postMessage({id,aliasTargets:{request,targets}});});
self.addEventListener('message',async event=>{
  if(started){if(pending&&event.data?.id===id){
    if(pending.type==='targets'&&event.data.aliasTargets?.request===pending.request){const current=pending;pending=null;current.resolve(event.data.aliasTargets.rows);}
    else if(!pending.type&&Number.isSafeInteger(event.data.guard)&&event.data.guard===pending.request){const current=pending;pending=null;current.resolve();}
  }return;}
  started=true;const input=event.data;id=input?.id;let journal,characters,carriers;
  try{
    if(typeof id!=='string'||!['inspect','clear','characters','comfy','mappings','carriers','mapping-list','mapping-detail','mapping-export','mapping-import-preview','mapping-import-apply','user-alias-preview','user-alias-apply'].includes(input.action))throw Error('储存操作无效');
    if(input.action==='carriers'){
      await guard();const {createBundleCarrierStore}=await import('./qianmu-bundle-carrier-store.js'),{bundleCarrierInventory}=await import('./qianmu-bundle-carrier-storage-contract.js');carriers=createBundleCarrierStore();
      const result=bundleCarrierInventory(await carriers.list(input.namespace,{guard}),input.namespace);await guard();self.postMessage({id,result});return;
    }
    if(input.action==='comfy'){
      await guard();const {inspectComfyStorage}=await import('./qianmu-comfy-storage.js');
      const result=await inspectComfyStorage({namespace:input.namespace,guard});await guard();self.postMessage({id,result});return;
    }
    if(input.action==='characters'){
      await guard();const {createCharacterArchiveStore}=await import('./qianmu-character-archive-store.js');
      characters=createCharacterArchiveStore();await guard();const result=await characters.storageSummary(input.namespace);await guard();self.postMessage({id,result});return;
    }
    journal=createStoryboardPackageJournal();
    const options={journal,namespace:input.namespace,guard,isCurrent:()=>true};
    if(input.action==='mapping-import-preview'||input.action==='mapping-import-apply'){
      const {runMappingImport}=await import('./qianmu-mapping-import.js');const result=await runMappingImport(input.action,{...options,input:input.input});await guard();self.postMessage({id,result});return;
    }
    if(input.action.startsWith('user-alias-')){
      const {runUserAliasOperation}=await import('./qianmu-user-alias-runtime.js'),{createCharacterArchiveStore}=await import('./qianmu-character-archive-store.js');characters=createCharacterArchiveStore();
      const result=await runUserAliasOperation(input.action,{...options,store:characters,chatHash:input.chatHash,input:input.input,resolveTargets:resolveAliasTargets});await guard();self.postMessage({id,result});return;
    }
    if(input.action==='mappings'||input.action.startsWith('mapping-')){
      const {runMappingRegistry}=await import('./qianmu-storyboard-mapping-registry.js');
      const result=await runMappingRegistry(input.action,{...options,input:input.input});await guard();self.postMessage({id,result});return;
    }
    const result=input.action==='inspect'?await collectRestoreStorage(options):await clearRestoreStorage({...options,selected:input.selected,confirmed:input.confirmed,recoveryLossAccepted:input.recoveryLossAccepted});
    await guard();self.postMessage({id,result});
  }catch(error){self.postMessage({id,error:{code:error?.code||'storyboard_restore_storage',message:error?.message||'恢复记录处理未确认'}});}
  finally{journal?.close();characters?.close();carriers?.close();pending=null;self.close();}
});
