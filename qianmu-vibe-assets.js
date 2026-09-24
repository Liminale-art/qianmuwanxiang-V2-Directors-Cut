import {vibeFileError} from './qianmu-vibe-file.js';
import {isStAccountStorageConfigured,captureStAccountStorageWorkerContext,verifyStAccountStorageWorkerContext,getStAccountStorageReadScope} from './qianmu-st-account-storage.js';
import {createVerifiedProgressWatch} from './qianmu-verified-progress-watch.js';
import {createVibeEncodingRetention} from './qianmu-vibe-encoding-retention.js';
export {createVibeLibraryAssets,mountVibeWorkbenchPreviews} from './qianmu-vibe-library-assets.js';
let worker=null,ticket=0,idle=0,preparing=Promise.resolve();const waiting=new Map();
function stop(error){clearTimeout(idle);worker?.terminate();worker=null;preparing=Promise.resolve();for(const row of waiting.values()){clearTimeout(row.timer);row.watch?.stop();row.reject(error);}waiting.clear();}
function rest(){if(!waiting.size){clearTimeout(idle);idle=setTimeout(()=>stop(vibeFileError('closed','Vibe 空闲会话结束')),30000);}}
function finish(id,error,value){const row=waiting.get(id);if(!row)return;waiting.delete(id);clearTimeout(row.timer);row.watch?.stop();error?row.reject(error):row.resolve(value);rest();}
function start(){
  if(worker)return worker;
  try{worker=new Worker(new URL('./qianmu-vibe-assets-worker.js',import.meta.url),{type:'module',name:'qianmu-vibe-assets'});}
  catch(_){throw vibeFileError('worker','浏览器无法启动 Vibe 文件处理，请检查站点权限');}
  const current=worker;
  worker.addEventListener('error',()=>{if(worker===current)stop(vibeFileError('worker','Vibe 文件处理暂不可用，原数据保留'));});
  worker.addEventListener('message',event=>{if(worker!==current)return;const message=event.data,row=waiting.get(message?.ticket);if(!row)return;
    const guardFailed=error=>{if(worker===current&&waiting.get(message.ticket)===row)stop(error);};
    if(message.started===true){if(!row.native)return;if(row.started){stop(vibeFileError('worker','Vibe后台重复启动了操作'));return;}row.started=true;
      row.watch=createVerifiedProgressWatch({idleMs:120000,totalMs:Math.max(100,1800000-(Date.now()-row.createdAt)),onTimeout:()=>stop(vibeFileError('timeout','Vibe处理未确认，原件已保留，请重新核对'))});return;}
    if(Object.hasOwn(message,'guard')){if(!row.native||!row.started||!Number.isSafeInteger(message.guard)||message.guard<1){stop(vibeFileError('worker','Vibe后台账户核对无效'));return;}
      void row.guard().then(()=>{if(worker===current&&waiting.get(message.ticket)===row)current.postMessage({ticket:message.ticket,guard:message.guard,result:true});},guardFailed);return;}
    if(Object.hasOwn(message,'progress')){if(!row.native||!row.started||!Number.isSafeInteger(message.progress)||message.progress!==row.progress+1){stop(vibeFileError('worker','Vibe后台进度无效'));return;}
      row.progress=message.progress;void row.guard().then(()=>{if(worker===current&&waiting.get(message.ticket)===row)row.watch.progress();},guardFailed);return;}
    if(message.error){finish(message.ticket,Object.assign(new Error(message.error.message),{code:message.error.code,submissionState:'not_submitted'}));return;}
    if(row.native){if(!row.started){stop(vibeFileError('worker','Vibe后台结果缺少操作核对'));return;}
      void row.guard().then(()=>{if(worker===current)finish(message.ticket,null,message.value);},guardFailed);
    }else finish(message.ticket,null,message.value);
  });return worker;
}
function callNative(type,options){
  let captured;try{captured=structuredClone(options);}catch{return Promise.reject(vibeFileError('file','无法读取此Vibe操作'));}
  if(!captured||typeof captured!=='object'||Array.isArray(captured)||['ticket','type','nativeStorage','guard','started','progress'].some(key=>Object.hasOwn(captured,key)))return Promise.reject(vibeFileError('file','Vibe操作含后台保留字段'));
  return new Promise((resolve,reject)=>{
    let current;try{current=start();}catch(error){reject(error);return;}clearTimeout(idle);
    const id=++ticket,scope=getStAccountStorageReadScope(),row={resolve,reject,native:true,started:false,progress:0,createdAt:Date.now()};
    row.timer=setTimeout(()=>stop(vibeFileError('timeout','Vibe排队或处理超过总时限，结果请重新核对')),1800000);waiting.set(id,row);
    const live=()=>{if(worker!==current||waiting.get(id)!==row||scope!==getStAccountStorageReadScope())throw vibeFileError('account','Vibe账户或会话已变化');};
    const ready=preparing.catch(()=>{}).then(async()=>{
      live();const context=await captureStAccountStorageWorkerContext();live();if(context.namespace!==captured.namespace)throw vibeFileError('account','Vibe操作不属于当前ST账户');
      row.guard=async()=>{live();await verifyStAccountStorageWorkerContext(context);live();};
      current.postMessage({...captured,type,ticket:id,nativeStorage:context});
    });preparing=ready;void ready.catch(error=>finish(id,error));
  });
}
export function callVibeAsset(type,options={}){
  if(waiting.size>=48)return Promise.reject(vibeFileError('busy','Vibe 文件处理繁忙，请稍后重试'));
  if(isStAccountStorageConfigured())return callNative(type,options);
  return new Promise((resolve,reject)=>{
    let current;try{current=start();}catch(error){reject(error);return;}clearTimeout(idle);const id=++ticket;
    const timer=setTimeout(()=>stop(vibeFileError('timeout','Vibe 处理结果未确认，请重新核对后操作')),60000);
    waiting.set(id,{resolve,reject,timer});
    try{current.postMessage({...options,type,ticket:id});}catch(_){waiting.delete(id);clearTimeout(timer);reject(vibeFileError('file','无法读取此 Vibe 文件'));rest();}
  });
}
export function closeVibeAssetRuntime(){stop(vibeFileError('closed','Vibe 资产会话已结束'));}
export function prepareVibeEncodingRetention(options){
  return createVibeEncodingRetention({...options,readSource:selection=>callVibeAsset('encoding-original',selection)});
}
