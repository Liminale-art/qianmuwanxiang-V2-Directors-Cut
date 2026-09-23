import {createVibeAssetStore} from './qianmu-vibe-asset-store.js';
import {buildStoryboardVibePackage} from './qianmu-storyboard-package-assets.js';
import {validateStoryboardPackageMedia} from './qianmu-storyboard-package-input.js';
import {characterWorkerStorageOptions} from './qianmu-character-worker-storage.js';
// Separate worker/connection: long package reads must not queue in front of live encoding receipt writes.
let started=false,rpc=0,progress=0;const guards=new Map();
const guard=()=>new Promise(resolve=>{const id=++rpc;guards.set(id,resolve);self.postMessage({guard:id});});
self.addEventListener('message',async event=>{
  if(Number.isSafeInteger(event.data?.guard)){const resolve=guards.get(event.data.guard);if(resolve){guards.delete(event.data.guard);resolve();}return;}
  if(started)return;started=true;let store;
  try{const {namespace,payload,nativeStorage}=event.data||{};validateStoryboardPackageMedia(payload,{legacy:true});
    const native=characterWorkerStorageOptions(nativeStorage,{namespace,origin:self.location?.origin,guard});
    store=createVibeAssetStore({native:native?{...native,onProgress:()=>self.postMessage({progress:++progress})}:false});
    const value=await buildStoryboardVibePackage(payload,{namespace,load:(account,id)=>store.load(account,id)});if(nativeStorage)await guard();self.postMessage({value});}
  catch(error){self.postMessage({error:{message:error?.message||'分镜包未完成',code:error?.code||'vibe_file_package'}});}
  finally{store?.close();guards.clear();self.close();}
});
