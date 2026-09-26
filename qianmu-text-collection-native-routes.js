import path from 'node:path';
import {imageServiceAccount} from './qianmu-image-service-access.js';
import {createTextCollectionNativeService} from './qianmu-text-collection-native-service.js';
import {NATIVE_COLLECTION_PROTOCOL} from './qianmu-text-collection-native-contract.js';
import {textCollectionSyncError,textCollectionSyncErrorPayload} from './qianmu-text-collection-sync-contract.js';

export function installTextCollectionNativeRoutes(router,{dataRoot,register,serviceOptions={}}){
  let service;
  // SillyTavern initializes DATA_ROOT before normal requests, but a plugin can
  // receive the first UI request during that startup boundary. In that narrow
  // window the host callback may still return undefined even though the
  // authenticated request already carries ST's own account directories. Use
  // only that host-provided account root as a same-root fallback; never accept
  // a path from req.body and keep the file store's containment checks as the
  // final authority.
  const resolveDataRoot=(req)=>{
    const configured=typeof dataRoot==='function'?dataRoot():dataRoot;
    if(configured!==undefined)return configured;
    const accountRoot=req?.user?.directories?.root;
    if(typeof accountRoot!=='string'||!path.isAbsolute(accountRoot)||accountRoot.includes('\0'))return configured;
    const inferred=path.dirname(path.resolve(accountRoot));
    return path.resolve(inferred)===path.parse(inferred).root?configured:inferred;
  };
  for(const [method,route] of [['get','/text-collections/native-capabilities'],['post','/text-collections/native-write']])router[method](route,async(req,res)=>{
    res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');res.set('Cross-Origin-Resource-Policy','same-origin');
    const controller=new AbortController(),abort=()=>controller.abort(),onClose=()=>{if(!res.writableEnded)abort();};
    req.once?.('aborted',abort);res.once?.('close',onClose);
    try{
      let account;try{account=imageServiceAccount(req);}catch{throw textCollectionSyncError('account','请先登录 ST 账户使用收藏',401);}
      if(req.aborted||res.destroyed||res.writableEnded||controller.signal.aborted)return;
      // Capabilities are a read-only account handshake. Do not create and
      // cache the filesystem service here: during ST startup DATA_ROOT may
      // still be unset, and caching that first probe would poison every later
      // write even after the host has finished initializing its directories.
      let result;
      if(method==='get')result={ok:true,version:1,expectedAccount:account.namespace,nativeProtocol:NATIVE_COLLECTION_PROTOCOL,indexVersion:2};
      else{
        if(!service){service=createTextCollectionNativeService({...serviceOptions,dataRoot:resolveDataRoot(req)});register(service);}
        result=await service.write(req,req.body,{signal:controller.signal});
      }
      if(!res.destroyed&&!res.writableEnded&&!controller.signal.aborted)return res.json(result);
    }catch(cause){const result=textCollectionSyncErrorPayload(cause);if(!res.destroyed&&!res.writableEnded&&!controller.signal.aborted)return res.status(result.status).json(result.body);}
    finally{req.off?.('aborted',abort);res.off?.('close',onClose);}
  });
}
