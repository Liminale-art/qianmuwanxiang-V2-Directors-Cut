// Shared browser/server contract. No filesystem imports or caller-selected paths.
import {chatGalleryRecordRequest} from './qianmu-chat-gallery-record.js';
import {imageRestoreReceipt,imageRestoreAccount,IMAGE_RESTORE_MAX_BYTES} from './qianmu-image-restore-contract.js';

export const GALLERY_ORIGINAL_MAX_BYTES=IMAGE_RESTORE_MAX_BYTES;
export const GALLERY_ORIGINAL_JSON_BYTES=16384;
export const GALLERY_ORIGINAL_BATCH_LIMIT=8;
export const GALLERY_ORIGINAL_BATCH_JSON_BYTES=128*1024;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export const galleryOriginalError=(code,message,status=409)=>Object.assign(Error(message),{code:'gallery_original_'+code,status});
const fail=(code,message,status)=>{throw galleryOriginalError(code,message,status);};
export function galleryOriginalReference(value){
    if(!exact(value,['version','id','sha256','bytes','mime'])||value.version!==1
        ||!(/^[a-f0-9]{64}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/).test(value.id)
        ||!(/^[a-f0-9]{64}$/).test(value.sha256)||!value.id.startsWith(value.sha256+'-')
        ||!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>GALLERY_ORIGINAL_MAX_BYTES
        ||!['image/png','image/jpeg','image/webp'].includes(value.mime))fail('store_reference','原图副本引用无效，未猜测磁盘位置',400);
    return Object.freeze({...value});
}
export function galleryOriginalRequest(value){
    try{return chatGalleryRecordRequest(value);}catch{fail('request','原图保全只接受准确账户、已保存聊天和画面选择',400);}
}
export function galleryOriginalReadRequest(value){
    if(!exact(value,['version','expectedAccount','reference'])||value.version!==1||!imageRestoreAccount(value.expectedAccount))fail('request','原图读回只接受当前账户和准确副本引用',400);
    return {version:1,expectedAccount:value.expectedAccount,reference:galleryOriginalReference(value.reference)};
}
export function galleryOriginalBatchRequest(value){
    if(!exact(value,['version','expectedAccount','target','gallerySha256','selections'])||!Array.isArray(value.selections)
        ||value.selections.length<1||value.selections.length>GALLERY_ORIGINAL_BATCH_LIMIT)fail('request','原图批次须包含1至8个准确镜头选择',400);
    const selections=[],ids=new Set();let target;
    for(const selection of value.selections){
        if(!exact(selection,['recordId','createdAt'])||ids.has(selection.recordId))fail('request','原图批次存在重复或不完整的画面选择',400);
        const single=galleryOriginalRequest({version:value.version,expectedAccount:value.expectedAccount,target:value.target,
            selection:{...selection,gallerySha256:value.gallerySha256}});target=single.target;ids.add(selection.recordId);selections.push({...selection});
    }
    return {version:1,expectedAccount:value.expectedAccount,target,gallerySha256:value.gallerySha256,selections};
}
export function galleryOriginalBatchPreserved(value){
    if(!exact(value,['version','expectedAccount','target','gallerySha256','selections','records','proof','canPrune'])
        ||value.proof!=='original-batch-readback'||value.canPrune!==false||!Array.isArray(value.records))fail('response','原图批次没有完整保存凭据');
    const request=galleryOriginalBatchRequest({version:value.version,expectedAccount:value.expectedAccount,target:value.target,gallerySha256:value.gallerySha256,selections:value.selections});
    if(value.records.length!==request.selections.length)fail('response','原图批次返回不完整，未当作全部成功');
    const records=value.records.map((raw,index)=>{
        const record=galleryOriginalPreserved(raw),selection=request.selections[index];
        if(record.expectedAccount!==request.expectedAccount||JSON.stringify(record.target)!==JSON.stringify(request.target)
            ||record.selection.gallerySha256!==request.gallerySha256||record.selection.recordId!==selection.recordId||record.selection.createdAt!==selection.createdAt)
            fail('response','原图批次返回了不同来源或顺序的画面');return record;
    });
    return {...request,records,proof:value.proof,canPrune:false};
}
export function galleryOriginalCapabilities(value){
    if(!exact(value,['ok','version','expectedAccount','selectorOnly','maxBytes','canPrune'])||value.ok!==true||value.version!==1
        ||!imageRestoreAccount(value.expectedAccount)||value.selectorOnly!==true||value.maxBytes!==GALLERY_ORIGINAL_MAX_BYTES||value.canPrune!==false)
        fail('capabilities','原图保全服务版本或账户不兼容',409);
    return {...value};
}
export function galleryOriginalPreserved(value){
    if(!exact(value,['version','expectedAccount','target','selection','reference','original','proof','persistence','originalVerified','canPrune'])
        ||value.proof!=='original-copy-readback'||value.persistence!=='st-account-file'||value.originalVerified!==true||value.canPrune!==false)
        fail('response','原图副本保存凭据不完整，原资料须保留');
    const request=galleryOriginalRequest({version:value.version,expectedAccount:value.expectedAccount,target:value.target,selection:value.selection});
    let original;try{original=imageRestoreReceipt(value.original);}catch{fail('response','原图副本的来源凭据不兼容');}
    const reference=galleryOriginalReference(value.reference);
    if(reference.sha256!==original.sha256||reference.bytes!==original.bytes||reference.mime!==original.mime)fail('response','原图副本与来源字节凭据不符');
    return {...request,reference,original,proof:value.proof,persistence:value.persistence,originalVerified:true,canPrune:false};
}
export function galleryOriginalErrorPayload(error){
    // Even filesystem errors carrying a misleading code cannot expose paths,
    // credentials or arbitrary exception text across the HTTP boundary.
    const known=/^gallery_original_[a-z_]+$/.test(error?.code||''),status=known&&[400,401,403,404,409,413,422,429,503,507].includes(error.status)?error.status:503;
    const messages={400:'原图请求不兼容，请重新选择画面',401:'ST 账户已变化，请重新打开图库',403:'原图不属于当前账户',
        404:'准确的原图或副本未找到，原记录仍保留',409:'原图来源、副本或操作状态已变化，未确认保全',413:'原图超过保全大小上限，未截断',
        422:'原画面不是可保全的 ST 静帧',429:'原图保全正忙，请稍后重试',503:'原图服务暂未确认，请保留原资料后重试',507:'服务器可用空间或原图分区容量不足，未清理原件'};
    return {status,body:{ok:false,version:1,code:known?error.code:'gallery_original_unavailable',message:messages[status],canPrune:false}};
}
