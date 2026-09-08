import {createVibeAssetStore} from './qianmu-vibe-asset-store.js';
import {buildStoryboardVibePackage} from './qianmu-storyboard-package-assets.js';
import {validateStoryboardPackageMedia} from './qianmu-storyboard-package-input.js';
// Separate worker/connection: long package reads must not queue in front of live encoding receipt writes.
let started=false;
self.addEventListener('message',async event=>{
  if(started)return;started=true;const store=createVibeAssetStore();
  try{const {namespace,payload}=event.data||{};validateStoryboardPackageMedia(payload,{legacy:true});const value=await buildStoryboardVibePackage(payload,{namespace,load:(account,id)=>store.load(account,id)});self.postMessage({value});}
  catch(error){self.postMessage({error:{message:error?.message||'分镜包未完成',code:error?.code||'vibe_file_package'}});}
  finally{store.close();self.close();}
});
