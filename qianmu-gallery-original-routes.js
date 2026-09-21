import {imageServiceAccount,imageServiceAccountStillMatches} from './qianmu-image-service-access.js';
import {createGalleryOriginalService} from './qianmu-gallery-original-service.js';
import {galleryOriginalError,galleryOriginalErrorPayload,galleryOriginalCapabilities,galleryOriginalPreserved,GALLERY_ORIGINAL_MAX_BYTES} from './qianmu-gallery-original-contract.js';

// Account-private, selector-only operations. No generic upload, external URL,
// static file serving, cross-account admin override or automatic startup copy.
export function installGalleryOriginalRoutes(router,{dataRoot,register,serviceOptions={}}){
    let service;
    for(const action of ['capabilities','preserve','read'])router[action==='capabilities'?'get':'post']('/chat-gallery/original/'+action,async(req,res)=>{
        res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');res.set('Cross-Origin-Resource-Policy','same-origin');
        const controller=new AbortController(),abort=()=>controller.abort(),onClose=()=>{if(!res.writableEnded)abort();};
        res.once?.('close',onClose);req.once?.('aborted',abort);
        try{
            let account;try{account=imageServiceAccount(req);}catch{throw galleryOriginalError('account','请先登录 ST 账户',401);}
            if(controller.signal.aborted||req.aborted||res.destroyed||res.writableEnded)return;
            if(action==='capabilities')return res.json(galleryOriginalCapabilities({ok:true,version:1,expectedAccount:account.namespace,selectorOnly:true,maxBytes:GALLERY_ORIGINAL_MAX_BYTES,canPrune:false}));
            if(!service){service=createGalleryOriginalService({...serviceOptions,dataRoot:dataRoot()});register(service);}
            const result=await service[action](req,req.body,{signal:controller.signal});
            if(controller.signal.aborted||res.destroyed||res.writableEnded)return;
            if(!imageServiceAccountStillMatches(req,account))throw galleryOriginalError('account','ST 账户已变化',401);
            if(action==='preserve')return res.json(galleryOriginalPreserved(result));
            res.set('Content-Type',result.reference.mime);res.set('Content-Length',String(result.reference.bytes));
            res.set('X-Qianmu-Original-SHA256',result.reference.sha256);res.set('X-Qianmu-Original-Account',account.namespace);
            res.set('Content-Disposition','inline; filename="original.'+(result.reference.mime==='image/jpeg'?'jpg':result.reference.mime.slice(6))+'"');
            // Bytes were completely hashed and validated before any media body
            // is sent. No partial stream is mistaken for a verified original.
            return res.end(result.bytes);
        }catch(error){const failure=galleryOriginalErrorPayload(error);if(!res.destroyed&&!res.writableEnded)return res.status(failure.status).json(failure.body);}
        finally{res.off?.('close',onClose);req.off?.('aborted',abort);}
    });
}
