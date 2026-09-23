import {captureCharacterWorkerStorage} from './qianmu-character-worker-storage.js';
import {createVerifiedProgressWatch} from './qianmu-verified-progress-watch.js';
import {isStAccountStorageConfigured} from './qianmu-st-account-storage.js';
let active=null;
const failure=message=>Object.assign(new Error(message),{code:'storyboard_package_runtime',submissionState:'not_submitted'});
export function closeStoryboardPackageRuntime(){active?.finish(failure('分镜打包已取消，原数据未修改'));}
export async function exportStoryboardPackageAssets(payload,{namespace,guard,signal,WorkerClass=globalThis.Worker,timeoutMs=120000}={}){
  if(typeof guard!=='function')throw failure('分镜打包缺少账户/聊天核对');await guard();
  const nativeStorage=isStAccountStorageConfigured()?await captureCharacterWorkerStorage(namespace,guard):null;
  if(signal?.aborted)throw failure('分镜打包已取消，原数据未修改');if(active)throw failure('已有分镜包正在处理，请等待或取消');
  return new Promise((resolve,reject)=>{
    let worker,done=false,timer,lastProgress=0;const abort=()=>finish(failure('分镜打包已取消，原数据未修改'));
    const finish=(error,value)=>{if(done)return;done=true;timer?.stop();signal?.removeEventListener('abort',abort);worker?.terminate();if(active===entry)active=null;
      if(error){reject(error);return;}Promise.resolve().then(guard).then(()=>resolve(value),reject);};
    const entry={finish};active=entry;
    try{
      worker=new WorkerClass(new URL('./qianmu-storyboard-package-worker.js',import.meta.url),{type:'module',name:'qianmu-storyboard-package'});
      worker.addEventListener('error',()=>finish(failure('分镜包处理失败，原数据未修改')));
      worker.addEventListener('message',event=>{if(done)return;const message=event.data;
        if(Object.hasOwn(message||{},'guard')){if(!nativeStorage||!Number.isSafeInteger(message.guard)||message.guard<1){finish(failure('分镜包后台核对无效'));return;}
          void Promise.resolve().then(guard).then(()=>{if(!done)worker.postMessage({guard:message.guard});},finish);return;}
        if(Object.hasOwn(message||{},'progress')){if(!nativeStorage||!Number.isSafeInteger(message.progress)||message.progress!==lastProgress+1){finish(failure('分镜包后台进度无效'));return;}
          lastProgress=message.progress;void Promise.resolve().then(guard).then(()=>{if(!done)timer.progress();},finish);return;}
        if(message?.error)finish(Object.assign(failure(message.error.message),{causeCode:message.error.code}));else if(message?.value?.file instanceof Blob)finish(null,message.value);else finish(failure('分镜包返回不完整，未下载'));});
      signal?.addEventListener('abort',abort,{once:true});
      timer=createVerifiedProgressWatch({idleMs:timeoutMs,totalMs:1800000,onTimeout:()=>finish(failure('分镜包处理超时，原件仍保留，请重新核对'))});
      if(signal?.aborted){abort();return;}worker.postMessage({namespace,payload,nativeStorage});
    }catch(_){finish(failure('无法启动分镜打包，请检查浏览器权限'));}
  });
}
