// Components only: not an HTTP endpoint or automatic runtime archive hook.
// Preserve accepts selectors, never user-provided bytes, URL or disk paths.
import {createGalleryOriginalSource} from './qianmu-gallery-original-source.js';
import {createGalleryOriginalStore,galleryOriginalReference,GALLERY_ORIGINAL_STORE_LIMITS} from './qianmu-gallery-original-store.js';
import {chatGalleryRecordRequest} from './qianmu-chat-gallery-record.js';
import {imageServiceAccountStillMatches} from './qianmu-image-service-access.js';

const fail=(code,message,status=409)=>{throw Object.assign(Error(message),{code:'gallery_original_service_'+code,status});};
export function createGalleryOriginalService(options){
    const source=createGalleryOriginalSource(options),store=createGalleryOriginalStore(options),pending=new Set(),controllers=new Set();let closed=false;
    function run(req,raw,{signal}={},write){
        let input;
        try{
            if(closed||signal?.aborted)fail('changed','原图保全已取消');
            if(pending.size>=GALLERY_ORIGINAL_STORE_LIMITS.pending)fail('busy','原图保全正忙，请稍后重试',429);
            if(write)input=chatGalleryRecordRequest(raw);
            else{
                if(!raw||Object.keys(raw).length!==3||raw.version!==1||typeof raw.expectedAccount!=='string')fail('request','原图读回只接受账户和准确副本引用',400);
                input={version:1,expectedAccount:raw.expectedAccount,reference:galleryOriginalReference(raw.reference)};
            }
        }catch(error){return Promise.reject(error);}
        const controller=new AbortController(),abort=()=>controller.abort();controllers.add(controller);signal?.addEventListener('abort',abort,{once:true});
        const keys=write?['root','userImages',input.target.kind==='group'?'groupChats':'chats']:['root'];
        const dirs=keys.map(key=>req.user?.directories?.[key]);
        const guard=()=>{
            if(closed||controller.signal.aborted||!imageServiceAccountStillMatches(req,{namespace:input.expectedAccount})
                ||keys.some((key,index)=>req.user?.directories?.[key]!==dirs[index]))fail('changed','原图保全账户、来源目录或操作状态已变化，未确认保全');
        };
        const task=(async()=>{
            guard();const operation={signal:controller.signal};
            if(!write){
                const bytes=await store.get(req,input.expectedAccount,input.reference,operation);guard();
                return Object.freeze({...input,bytes,proof:'original-copy-readback',persistence:'st-account-file',originalVerified:true,canPrune:false});
            }
            let captured=await source.read(req,input,operation);guard();const receipt=captured.receipt;
            const reference=await store.put(req,input.expectedAccount,{bytes:captured.bytes,sha256:receipt.sha256,mime:receipt.mime},operation);guard();
            captured=null; // Do not retain two full originals during final source verification.
            let again=await source.read(req,input,operation);guard();
            if(JSON.stringify(again.receipt)!==JSON.stringify(receipt))fail('source','保存期间原图已变化，副本保留但未发布匹配凭据');
            again=null;await store.get(req,input.expectedAccount,reference,operation);guard();
            // Point-in-time source verification, not a lock on the live chat.
            // originalVerified covers this copy's bytes only, not recipes,
            // attachments, anchors or the authority to prune any source.
            return Object.freeze({...input,reference,original:receipt,proof:'original-copy-readback',persistence:'st-account-file',originalVerified:true,canPrune:false});
        })();
        pending.add(task);void task.finally(()=>{pending.delete(task);controllers.delete(controller);signal?.removeEventListener('abort',abort);}).catch(()=>{});return task;
    }
    return Object.freeze({preserve:(req,input,options)=>run(req,input,options,true),read:(req,input,options)=>run(req,input,options,false),
        async close(){closed=true;for(const controller of controllers)controller.abort();await Promise.allSettled([source.close(),store.close(),...pending]);}});
}
