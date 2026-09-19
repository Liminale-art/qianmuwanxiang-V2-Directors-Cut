import {imageServiceAccount} from './qianmu-image-service-access.js';
import {createTextCollectionSyncService} from './qianmu-text-collection-sync-service.js';
import {textCollectionSyncError,textCollectionSyncErrorPayload} from './qianmu-text-collection-sync-contract.js';

// Paths and storage root are fixed by the host; request bodies cannot select a service or file.
export function installTextCollectionRoutes(router,{dataRoot,register,serviceOptions={}}){
  let service;
  for(const action of ['list','get','snapshot','write'])router.post(`/text-collections/${action}`,async(req,res)=>{
    res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');
    const controller=new AbortController(),onClose=()=>{if(!res.writableEnded)controller.abort();};res.once?.('close',onClose);
    try{
      try{imageServiceAccount(req);}catch{throw textCollectionSyncError('account','请先登录 ST 账户使用收藏',401);}
      if(!service){service=createTextCollectionSyncService({...serviceOptions,dataRoot:dataRoot()});register(service);}
      const result=await service[action](req,req.body,{signal:controller.signal});
      if(!res.destroyed&&!res.writableEnded)return res.json(result);
    }catch(cause){const result=textCollectionSyncErrorPayload(cause);if(!res.destroyed&&!res.writableEnded)return res.status(result.status).json(result.body);}
    finally{res.off?.('close',onClose);}
  });
}
