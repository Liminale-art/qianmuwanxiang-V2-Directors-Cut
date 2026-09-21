import {galleryOriginalReference,galleryOriginalRequest,galleryOriginalReadRequest,galleryOriginalCapabilities,galleryOriginalPreserved,
    galleryOriginalError,galleryOriginalErrorPayload,galleryOriginalBatchRequest,galleryOriginalBatchPreserved,
    GALLERY_ORIGINAL_JSON_BYTES,GALLERY_ORIGINAL_BATCH_JSON_BYTES,GALLERY_ORIGINAL_BATCH_LIMIT} from './qianmu-gallery-original-contract.js';
import {galleryCatalogAccount} from './qianmu-gallery-catalog-contract.js';
import {captureGalleryArchiveJson} from './qianmu-gallery-page-index.js';
import {comfyReferencePath} from './qianmu-comfy-reference-contract.js';
import {comfyReferenceStillMime} from './qianmu-comfy-results.js';

const base='/api/plugins/qianmu-tts/chat-gallery/original/';
const fail=message=>{throw galleryOriginalError('client',message);};
const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// Selected operations only. This client never lists, scans, auto-retries, copies
// a whole library, falls back to external URLs or sends original bytes upstream.
export function createGalleryOriginalClient({account,headers,guard=async()=>true,fetchImpl=globalThis.fetch,timeoutMs=60000}={}){
    if(typeof account!=='function'||typeof headers!=='function'||typeof guard!=='function'||typeof fetchImpl!=='function'
        ||!Number.isFinite(timeoutMs)||timeoutMs<100||timeoutMs>120000)fail('原图保全缺少当前账户或请求保护');
    let namespace,closed=false,busy=false;const aborters=new Set();
    function run(work,{signal}={}){
        if(closed||signal?.aborted)return Promise.reject(galleryOriginalError('client','原图操作已取消'));
        if(busy)return Promise.reject(galleryOriginalError('client','正在读取原图，请稍后重试',429));busy=true;
        const controller=new AbortController();let reject;
        const cancelled=new Promise((_,no)=>{reject=no;});
        const abort=()=>{controller.abort();reject(galleryOriginalError('client','原图操作已取消或超时，原资料仍保留'));};
        aborters.add(abort);signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,timeoutMs);
        const alive=()=>{if(closed||controller.signal.aborted)fail('原图操作已取消或超时');};
        async function check(){
            alive();if(await guard()!==true)fail('原图来源或页面已变化');alive();const current=galleryCatalogAccount(await account());alive();
            if(namespace!==undefined&&namespace!==current)fail('ST 账户已变化，未使用旧原图');namespace??=current;
            if(await guard()!==true)fail('原图来源或页面已变化');alive();return 'st-user:'+await hash(new TextEncoder().encode(namespace.slice(8)));
        }
        async function bytes(response,limit){
            const reader=response.body?.getReader?.();if(!reader)fail('原图服务没有完整响应');
            const cancel=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',cancel,{once:true});
            const buffer=new Uint8Array(limit);let count=0;
            try{while(true){alive();const part=await reader.read();alive();if(part.done)break;
                if(!(part.value instanceof Uint8Array)||count+part.value.byteLength>limit)fail('原图返回超过约定大小，未截断');buffer.set(part.value,count);count+=part.value.byteLength;
            }return buffer.subarray(0,count);}
            finally{controller.signal.removeEventListener('abort',cancel);cancel();try{reader.releaseLock();}catch{}}
        }
        async function request(action,body,reference){
            const expectedAccount=await check();alive();const provided=new Headers(await headers());alive();
            const requestHeaders={Accept:reference?reference.mime:'application/json'};
            if(body)requestHeaders['Content-Type']='application/json';
            if(provided.has('x-csrf-token'))requestHeaders['X-CSRF-Token']=provided.get('x-csrf-token');
            await check();alive();const response=await fetchImpl(base+action,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'error',
                headers:requestHeaders,signal:controller.signal,...(body?{body:JSON.stringify(body)}:{})});
            const discard=()=>{void response.body?.cancel?.().catch(()=>{});};
            if(closed||controller.signal.aborted){discard();alive();}
            if(response.redirected){discard();fail('原图服务发生了重定向，未读取其他地址');}
            if(response.status===404||response.status===405){discard();fail('原图服务不可用或准确副本未找到；请保留原资料，未回退到其他图片');}
            if(!response.ok){discard();throw galleryOriginalError('client',galleryOriginalErrorPayload({code:'gallery_original_http',status:response.status}).body.message,response.status);}
            const type=response.headers.get('content-type')||'',declared=response.headers.get('content-length');
            if(reference){
                if(type!==reference.mime||declared!==String(reference.bytes)||response.headers.get('x-qianmu-original-sha256')!==reference.sha256
                    ||response.headers.get('x-qianmu-original-account')!==expectedAccount){discard();fail('原图返回的账户、格式、大小或摘要不符');}
                const data=await bytes(response,reference.bytes);alive();
                if(data.length!==reference.bytes||await hash(data)!==reference.sha256||comfyReferenceStillMime(data)!==reference.mime)fail('原图字节校验失败，未显示不完整画面');
                await check();alive();return {blob:new Blob([data],{type:reference.mime}),reference,proof:'original-copy-readback',originalVerified:true,canPrune:false};
            }
            const jsonLimit=action==='preserve-batch'?GALLERY_ORIGINAL_BATCH_JSON_BYTES:GALLERY_ORIGINAL_JSON_BYTES;
            if(!/^application\/json\b/i.test(type)||declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>jsonLimit)){
                discard();fail('原图服务返回不兼容或过大');
            }
            const data=await bytes(response,jsonLimit);let value;
            try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{fail('原图返回不是完整的有效凭据');}
            await check();alive();return value;
        }
        const worker=(async()=>{const expectedAccount=await check();alive();
            const caps=galleryOriginalCapabilities(await request('capabilities'));alive();if(caps.expectedAccount!==expectedAccount)fail('原图服务属于另一账户');
            return work({expectedAccount,request,check,alive});})();
        void worker.finally(()=>{busy=false;}).catch(()=>{});
        return Promise.race([worker,cancelled]).finally(()=>{clearTimeout(timer);aborters.delete(abort);signal?.removeEventListener('abort',abort);controller.abort();});
    }
    return Object.freeze({
        preserveBatch(raw,options){
            let value;try{
                value=captureGalleryArchiveJson(raw,GALLERY_ORIGINAL_JSON_BYTES);
                if(!value||Object.keys(value).length!==3||!Object.hasOwn(value,'target')||!Object.hasOwn(value,'gallerySha256')
                    ||!Array.isArray(value.records)||!value.records.length||value.records.length>GALLERY_ORIGINAL_BATCH_LIMIT
                    ||value.records.some(row=>!row||Object.keys(row).length!==3||!Object.hasOwn(row,'recordId')||!Object.hasOwn(row,'createdAt')||!Object.hasOwn(row,'url')||comfyReferencePath(row.url)!==row.url))fail('原图批次缺少准确画面与来源');
                // Validate selector shape and uniqueness before any network I/O.
                galleryOriginalBatchRequest({version:1,expectedAccount:'st-user:'+'0'.repeat(64),target:value.target,gallerySha256:value.gallerySha256,
                    selections:value.records.map(({recordId,createdAt})=>({recordId,createdAt}))});
            }catch(error){return Promise.reject(error);}
            return run(async({expectedAccount,request,alive})=>{
                const body=galleryOriginalBatchRequest({version:1,expectedAccount,target:value.target,gallerySha256:value.gallerySha256,
                    selections:value.records.map(({recordId,createdAt})=>({recordId,createdAt}))});
                const result=galleryOriginalBatchPreserved(await request('preserve-batch',body));alive();
                if(result.expectedAccount!==body.expectedAccount||!same(result.target,body.target)||result.gallerySha256!==body.gallerySha256||!same(result.selections,body.selections)
                    ||result.records.some((record,index)=>record.original.url!==value.records[index].url))fail('原图批次返回了不同来源，未采纳部分结果');return result;
            },options);
        },
        preserve(raw,options){
            let value;try{value=captureGalleryArchiveJson(raw,8192);
                if(Object.keys(value).length!==3||!Object.hasOwn(value,'target')||!Object.hasOwn(value,'selection')||!Object.hasOwn(value,'url')||comfyReferencePath(value.url)!==value.url)fail('原图保全缺少准确来源');
            }catch(error){return Promise.reject(error);}
            return run(async({expectedAccount,request,alive})=>{
                const body=galleryOriginalRequest({version:1,expectedAccount,target:value.target,selection:value.selection});
                const result=galleryOriginalPreserved(await request('preserve',body));alive();
                if(result.expectedAccount!==expectedAccount||!same(result.target,body.target)||!same(result.selection,body.selection)||result.original.url!==value.url)
                    fail('原图副本不属于所选画面，未采用返回凭据');return result;
            },options);
        },
        read(raw,options){
            let reference;try{reference=galleryOriginalReference(raw);}catch(error){return Promise.reject(error);}
            return run(async({expectedAccount,request})=>request('read',galleryOriginalReadRequest({version:1,expectedAccount,reference}),reference),options);
        },
        close(){closed=true;for(const abort of aborters)abort();},
    });
}
