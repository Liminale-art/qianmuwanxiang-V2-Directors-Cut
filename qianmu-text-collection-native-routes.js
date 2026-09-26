import {imageServiceAccount} from './qianmu-image-service-access.js';
import {createTextCollectionNativeService} from './qianmu-text-collection-native-service.js';
import {textCollectionSyncError,textCollectionSyncErrorPayload} from './qianmu-text-collection-sync-contract.js';

export function installTextCollectionNativeRoutes(router,{dataRoot,register,serviceOptions={}}){
  let service;
  for(const [method,route] of [['get','/text-collections/native-capabilities'],['post','/text-collections/native-write']])router[method](route,async(req,res)=>{
    res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');res.set('Cross-Origin-Resource-Policy','same-origin');
    const controller=new AbortController(),abort=()=>controller.abort(),onClose=()=>{if(!res.writableEnded)abort();};
    req.once?.('aborted',abort);res.once?.('close',onClose);
    try{
      try{imageServiceAccount(req);}catch{throw textCollectionSyncError('account','请先登录 ST 账户使用收藏',401);}
      if(req.aborted||res.destroyed||res.writableEnded||controller.signal.aborted)return;
      if(!service){service=createTextCollectionNativeService({...serviceOptions,dataRoot:dataRoot()});register(service);}
      const result=method==='get'?service.capabilities(req):await service.write(req,req.body,{signal:controller.signal});
      if(!res.destroyed&&!res.writableEnded&&!controller.signal.aborted)return res.json(result);
    }catch(cause){const result=textCollectionSyncErrorPayload(cause);if(!res.destroyed&&!res.writableEnded&&!controller.signal.aborted)return res.status(result.status).json(result.body);}
    finally{req.off?.('aborted',abort);res.off?.('close',onClose);}
  });
}
