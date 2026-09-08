let active=null;
const failure=message=>Object.assign(new Error(message),{code:'storyboard_package_runtime',submissionState:'not_submitted'});
export function closeStoryboardPackageRuntime(){active?.finish(failure('分镜打包已取消，原数据未修改'));}
export async function exportStoryboardPackageAssets(payload,{namespace,guard,signal,WorkerClass=globalThis.Worker,timeoutMs=120000}={}){
  if(typeof guard!=='function')throw failure('分镜打包缺少账户/聊天核对');await guard();
  if(signal?.aborted)throw failure('分镜打包已取消，原数据未修改');if(active)throw failure('已有分镜包正在处理，请等待或取消');
  return new Promise((resolve,reject)=>{
    let worker,done=false,timer;const abort=()=>finish(failure('分镜打包已取消，原数据未修改'));
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);worker?.terminate();if(active===entry)active=null;
      if(error){reject(error);return;}Promise.resolve().then(guard).then(()=>resolve(value),reject);};
    const entry={finish};active=entry;
    try{
      worker=new WorkerClass(new URL('./qianmu-storyboard-package-worker.js',import.meta.url),{type:'module',name:'qianmu-storyboard-package'});
      worker.addEventListener('error',()=>finish(failure('分镜包处理失败，原数据未修改')));
      worker.addEventListener('message',event=>{if(event.data?.error)finish(Object.assign(failure(event.data.error.message),{causeCode:event.data.error.code}));else if(event.data?.value?.file instanceof Blob)finish(null,event.data.value);else finish(failure('分镜包返回不完整，未下载'));});
      signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>finish(failure('分镜包处理超时，原数据未修改；请缩小范围后重试')),Math.max(100,Math.min(300000,Number(timeoutMs)||120000)));
      if(signal?.aborted){abort();return;}worker.postMessage({namespace,payload});
    }catch(_){finish(failure('无法启动分镜打包，请检查浏览器权限'));}
  });
}
