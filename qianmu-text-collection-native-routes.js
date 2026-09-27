import path from 'node:path';
import {imageServiceAccount} from './qianmu-image-service-access.js';
import {createTextCollectionNativeService} from './qianmu-text-collection-native-service.js';
import {NATIVE_COLLECTION_PROTOCOL} from './qianmu-text-collection-native-contract.js';
import {textCollectionSyncError,textCollectionSyncErrorPayload} from './qianmu-text-collection-sync-contract.js';

export function installTextCollectionNativeRoutes(router,{dataRoot,register,serviceOptions={}}){
  let service,lastDiagnosticKey='',lastDiagnosticAt=0;
  const diagnoseFailure=result=>{
    if(!result||result.status<500)return;
    const code=typeof result.body?.code==='string'?result.body.code:'text_collection_sync_storage';
    const writeState=result.body?.writeState==='unconfirmed'?'unconfirmed':'not_started';
    const key=`${code}|${result.status}|${writeState}`,now=Date.now();
    if(key===lastDiagnosticKey&&now-lastDiagnosticAt<5000)return;
    lastDiagnosticKey=key;lastDiagnosticAt=now;
    // Diagnostic metadata only: never include account, paths, request bodies,
    // collection text, credentials or filesystem errors in the server log.
    console.warn(`[千幕] native collection rejected: ${code} status=${result.status} writeState=${writeState}`);
  };
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
  const requireDataRoot=(req)=>{
    const resolved=resolveDataRoot(req);
    if(typeof resolved!=='string'||!path.isAbsolute(resolved)||resolved.includes('\0')||path.resolve(resolved)===path.parse(resolved).root)
      throw textCollectionSyncError('native_setup','收藏保存环境尚未就绪',503);
    return resolved;
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
        // Do not cache a service while ST is still resolving DATA_ROOT. A
        // first request can legitimately arrive in that boundary; caching an
        // undefined/root-level value poisons every later write after startup.
        if(!service){const candidate=createTextCollectionNativeService({...serviceOptions,dataRoot:requireDataRoot(req)});register(candidate);service=candidate;}
        result=await service.write(req,req.body,{signal:controller.signal});
      }
      if(!res.destroyed&&!res.writableEnded&&!controller.signal.aborted)return res.json(result);
    }catch(cause){const result=textCollectionSyncErrorPayload(cause);diagnoseFailure(result);if(!res.destroyed&&!res.writableEnded&&!controller.signal.aborted)return res.status(result.status).json(result.body);}
    finally{req.off?.('aborted',abort);res.off?.('close',onClose);}
  });
}
