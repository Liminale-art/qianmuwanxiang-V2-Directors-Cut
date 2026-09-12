import {createFocusLibraryStore} from './qianmu-focus-library-store.js';
import {createFocusLibraryPicker} from './qianmu-focus-library.js';
import {loadLocalChunk} from './qianmu-feature-runtime.js?v=1.59.141';
// Lazy media storage and UI: no generation outside an explicit editor action.
export function createFocusLibraryRuntime({resolveNamespace,owner,context,choices,generate,ui,notify,save,available=()=>true,watchView=()=>null}) {
  let portal=null,openEpoch=0,management=null;const previous=new Map();
  let dialoguePromise=null;
  function dialogue(){return dialoguePromise||=loadLocalChunk('./qianmu-focus-dialogue.js?v=1.59.141').then(({createFocusDialogueLibrary})=>createFocusDialogueLibrary({owner,save,
    legacy:async()=>{const start=owner(),namespace=await resolveNamespace();const rows=await withStore(store=>store.list(namespace));
      if(start!==owner()||namespace!==await resolveNamespace())throw Error('账户已变化');return rows;}})).catch(error=>{dialoguePromise=null;throw error;});}
  function warm(){return Promise.all([loadLocalChunk('./qianmu-focus-dialogue-ui.js?v=1.59.141'),loadLocalChunk('./qianmu-focus-dialogue.js?v=1.59.141')]);}
  async function lines(options){
    const values=await (await dialogue()).lines({...options,characterKey:context().characterKey});
    if(options.isCurrent()&&values.some(value=>!value))notify('部分阶段没有适用台词，已跳过。','info');return values;
  }
  async function withStore(work){const store=createFocusLibraryStore();try{return await work(store);}finally{store.close();}}
  async function summary(){try{const start=owner(),namespace=await resolveNamespace();const value=await withStore(store=>store.summary(namespace));
    if(start!==owner()||namespace!==await resolveNamespace())throw new Error('账户已变化');return {...value,namespace,status:'ready'};
  }catch(_){return {status:'unavailable',bytes:null,count:null,error:'专注语音暂不可读取，总计未包含此部分'};}}
  async function read(cue){
    if(!cue?.library)return null;const start=owner(),namespace=await resolveNamespace(),ref=cue.library;
    if(start!==owner()||ref.namespace!==namespace)return null;
    const result=await withStore(store=>store.readAudio(ref,ref.id,ref.revision,{isCurrent:()=>start===owner()}));
    if(start!==owner()||namespace!==await resolveNamespace()||result.status!=='ready')return null;return {blob:result.blob};
  }
  async function prepare({state,sessionToken,bindingKey,isCurrent,specs,uid,save}){
    const namespace=await resolveNamespace();if(!isCurrent())return;const characterKey=context().characterKey;
    await withStore(async store=>{
      const pick=createFocusLibraryPicker({list:store.list,readAudio:store.readAudio}),cues=[];
      let empty=0;
      for(const spec of specs){
        const moment=`${state.phase}:${spec.type}`,key=JSON.stringify([namespace,characterKey,moment]);
        const result=await pick({namespace,characterKey},moment,{previousId:previous.get(key),isCurrent});
        if(!isCurrent())return;if(result.status==='failed')throw new Error('专注语音库读取失败');
        if(result.status!=='ready'){empty++;continue;}const clip=result.clip;previous.set(key,clip.id);if(previous.size>128)previous.delete(previous.keys().next().value);
        cues.push({id:uid('focusvoice'),...spec,text:clip.text,speaker:clip.speaker,cacheKey:`focus-library:${clip.id}:${clip.revision}`,played:false,
          characterKey,voiceBindingKey:bindingKey,sourceTime:state.sessionStartedAt,task:state.task,format:({'audio/wav':'wav','audio/x-wav':'wav','audio/ogg':'ogg','audio/webm':'webm','audio/mp4':'m4a','audio/flac':'flac'})[clip.mimeType]||'mp3',
          library:{namespace,characterKey,id:clip.id,revision:clip.revision}});
      }
      if(!isCurrent()||namespace!==await resolveNamespace()||!isCurrent())return;
      state.sessionVoiceCues=[...state.sessionVoiceCues.filter(cue=>cue.played),...cues].slice(-4);save();
      if(empty)notify('部分时机没有可用的自定义语音，已跳过；可在语音库补充。','info');
    });
  }
  function releaseManagement(ticket){if(management?.ticket===ticket){management.watcher?.release();management=null;}}
  function close(){openEpoch++;portal?.close();portal=null;if(management)releaseManagement(management.ticket);}
  async function open(options){
    if(management||options?.management&&!available()){notify('请先结束当前任务或关闭其他数据管理窗口。','info');return;}
    close();const ticket=openEpoch,start=owner(),store=createFocusLibraryStore();
    const live=()=>{try{if(options?.management){management?.watcher?.check();if(!available())return false;}return ticket===openEpoch&&start===owner()&&ui.host()?.isConnected;}catch{return false;}};
    try{
      if(options?.management){management={ticket,watcher:watchView(ui.host())};}
      const namespace=await resolveNamespace();if(!live()){store.close();releaseManagement(ticket);return;}
      const guard=async()=>{if(!live()||namespace!==await resolveNamespace()||!live())throw new Error('语音库页面或账户已变化，请重开');};
      if(!options?.management){
        const [{openFocusDialogue},library]=await Promise.all([loadLocalChunk('./qianmu-focus-dialogue-ui.js?v=1.59.141'),dialogue()]);await guard();
        const result=await openFocusDialogue({...ui,host:ui.host(),library,guard,choices,binding:context,onClose:()=>{if(ticket===openEpoch){portal=null;ui.changed();}}});
        store.close();if(!live())result.close();else portal=result;return;
      }
      const {openFocusLibrary}=await loadLocalChunk('./qianmu-focus-library-ui.js?v=1.59.141');await guard();
      const result=await openFocusLibrary({...ui,host:ui.host(),store,namespace,guard,isActive:live,choices,
        binding:key=>context(key),generate:async(key,clip,options)=>{await guard();const binding=context(key),stamp=JSON.stringify([binding.providerId,binding.profile?.revision]);
          if(clip.providerId&&clip.providerId!==binding.providerId)throw new Error('配音渠道已变化，请在编辑页重新选择当前渠道音色');
          const isCurrent=()=>live()&&options.isCurrent()&&JSON.stringify([context(key).providerId,context(key).profile?.revision])===stamp;
          const blob=await generate({...binding,voice:clip.voice},clip.text,{isCurrent});await guard();if(!isCurrent())throw new Error('生成音色或页面已变化');return blob;},
        onClose:()=>{store.close();releaseManagement(ticket);if(ticket===openEpoch){portal=null;ui.changed();}}
      },options);
      if(!live()){result.close();store.close();}else portal=result;
    }catch(error){store.close();if(live())notify(error.message||'语音库未能打开','warning');releaseManagement(ticket);}
  }
  return {summary,read,prepare,lines,open,close,warm,get busy(){return management!==null;}};
}
