import { createStoryboardPackageJournal } from './qianmu-storyboard-package-journal.js';
import { collectRestoreStorage, clearRestoreStorage } from './qianmu-storyboard-restore-storage.js';

let started=false,request=0,id='',pending=null;
const guard=()=>new Promise(resolve=>{pending={request:++request,resolve};self.postMessage({id,guard:request});});
self.addEventListener('message',async event=>{
  if(started){if(pending&&event.data?.id===id&&Number.isSafeInteger(event.data.guard)&&event.data.guard===pending.request){const current=pending;pending=null;current.resolve();}return;}
  started=true;const input=event.data;id=input?.id;let journal,characters;
  try{
    if(typeof id!=='string'||!['inspect','clear','characters','comfy'].includes(input.action))throw Error('储存操作无效');
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
    const result=input.action==='inspect'?await collectRestoreStorage(options):await clearRestoreStorage({...options,selected:input.selected,confirmed:input.confirmed,recoveryLossAccepted:input.recoveryLossAccepted});
    await guard();self.postMessage({id,result});
  }catch(error){self.postMessage({id,error:{code:error?.code||'storyboard_restore_storage',message:error?.message||'恢复记录处理未确认'}});}
  finally{journal?.close();characters?.close();pending=null;self.close();}
});
