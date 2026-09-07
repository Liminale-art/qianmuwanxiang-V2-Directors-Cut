import {vibeFileError} from './qianmu-vibe-file.js';
export {createVibeLibraryAssets,mountVibeWorkbenchPreviews} from './qianmu-vibe-library-assets.js';
let worker=null,ticket=0,idle=0;const waiting=new Map();
function stop(error){clearTimeout(idle);worker?.terminate();worker=null;for(const row of waiting.values()){clearTimeout(row.timer);row.reject(error);}waiting.clear();}
function rest(){if(!waiting.size){clearTimeout(idle);idle=setTimeout(()=>stop(vibeFileError('closed','Vibe 空闲会话结束')),30000);}}
function start(){
  if(worker)return worker;
  try{worker=new Worker(new URL('./qianmu-vibe-assets-worker.js',import.meta.url),{type:'module',name:'qianmu-vibe-assets'});}
  catch(_){throw vibeFileError('worker','浏览器无法启动 Vibe 文件处理，请检查站点权限');}
  const current=worker;
  worker.addEventListener('error',()=>{if(worker===current)stop(vibeFileError('worker','Vibe 文件处理暂不可用，原数据保留'));});
  worker.addEventListener('message',event=>{const row=waiting.get(event.data?.ticket);if(!row)return;waiting.delete(event.data.ticket);clearTimeout(row.timer);
    if(event.data.error)row.reject(Object.assign(new Error(event.data.error.message),{code:event.data.error.code,submissionState:'not_submitted'}));else row.resolve(event.data.value);
    rest();
  });return worker;
}
export function callVibeAsset(type,options={}){
  if(waiting.size>=48)return Promise.reject(vibeFileError('busy','Vibe 文件处理繁忙，请稍后重试'));
  return new Promise((resolve,reject)=>{
    let current;try{current=start();}catch(error){reject(error);return;}clearTimeout(idle);const id=++ticket;
    const timer=setTimeout(()=>stop(vibeFileError('timeout','Vibe 处理结果未确认，请重新核对后操作')),60000);
    waiting.set(id,{resolve,reject,timer});
    try{current.postMessage({...options,type,ticket:id});}catch(_){waiting.delete(id);clearTimeout(timer);reject(vibeFileError('file','无法读取此 Vibe 文件'));rest();}
  });
}
export function closeVibeAssetRuntime(){stop(vibeFileError('closed','Vibe 资产会话已结束'));}
