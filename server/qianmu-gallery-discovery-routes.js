import {imageServiceAccount} from './qianmu-image-service-access.js';
import {createGalleryDiscoveryService} from './qianmu-gallery-discovery-service.js';
import {galleryDiscoveryError,galleryDiscoveryErrorPayload} from './qianmu-gallery-discovery-contract.js';

// Account-level, read-only: no active chat or caller-selected filesystem root.
export function installGalleryDiscoveryRoutes(router,{dataRoot,register,serviceOptions={}}){
  let service;
  router.post('/gallery-archive/versions',async(req,res)=>{
    res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');
    const controller=new AbortController(),abort=()=>controller.abort(),onClose=()=>{if(!res.writableEnded)abort();};
    res.once?.('close',onClose);req.once?.('aborted',abort);
    try{
      try{imageServiceAccount(req);}catch{throw galleryDiscoveryError('account','请先登录 ST 账户读取图库目录',401);}
      if(!service){service=createGalleryDiscoveryService({...serviceOptions,dataRoot:dataRoot()});register(service);}
      const result=await service.list(req,req.body,{signal:controller.signal});
      if(!res.destroyed&&!res.writableEnded)return res.json(result);
    }catch(error){const result=galleryDiscoveryErrorPayload(error);if(!res.destroyed&&!res.writableEnded)return res.status(result.status).json(result.body);}
    finally{res.off?.('close',onClose);req.off?.('aborted',abort);}
  });
}
