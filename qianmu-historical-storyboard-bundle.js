import {buildStoryboardBundle,openStoryboardBundle,HISTORICAL_BUNDLE_SCOPE,STORYBOARD_BUNDLE_LIMITS} from './qianmu-storyboard-bundle.js';
import {parseStrictStoryboardJson} from './qianmu-storyboard-package-input.js';
import {projectChatGalleryState,CHAT_GALLERY_STATE_LIMITS} from './qianmu-chat-gallery-state.js';
import {chatCharacterReceiptTarget} from './qianmu-chat-character-receipt.js';
import {chatGalleryRecordSelection} from './qianmu-chat-gallery-record.js';
import {chatGalleryReceiptText} from './qianmu-chat-gallery-receipt.js';
import {recipeArchiveSnapshot,recipeArchiveReference,recipeArchiveEnvelope} from './qianmu-recipe-archive-contract.js';
import {inspectStoryboardChatEvidence} from './qianmu-storyboard-chat-evidence.js';
import {assertPortableStoryboardData} from './qianmu-storyboard-package-security.js';
import {comfyReferenceStillMime} from './qianmu-comfy-results.js';
import {vibeDigest} from './qianmu-vibe-file.js';

const fail=message=>{throw Object.assign(new Error(message),{code:'historical_storyboard_bundle',submissionState:'not_submitted'});};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const equal=(a,b)=>chatGalleryReceiptText([a]).text===chatGalleryReceiptText([b]).text;
const json=value=>new Blob([JSON.stringify(value)],{type:'application/json'});
const mediaSchema='qianmu.storyboard.historical-media.v1';

// Preserve original JSON fields, including unknown draft/album fields. Validation
// does not normalize originals or invent historical settings. Hashes prove file
// consistency, not authenticity, a generation-time owner, or workflow executability.
export async function inspectHistoricalStoryboardSource(input,{guard=async()=>{}}={}){
  const source=parseStrictStoryboardJson(JSON.stringify(input),{maxBytes:STORYBOARD_BUNDLE_LIMITS['historical-originals']});
  if(!exact(source,['schema','namespace','target','gallerySha256','selection','saved','recipes','chatEvidence','observed'])
    ||source.schema!=='qianmu.storyboard.historical-source.v1'||typeof source.namespace!=='string'||!/^st-user:.+/.test(source.namespace)
    ||source.namespace.length>512||/[\u0000-\u001f\u007f]/.test(source.namespace)||!hash(source.gallerySha256)
    ||!exact(source.selection,['ids','total'])||!Array.isArray(source.selection.ids)||source.selection.ids.length>400
    ||!Number.isSafeInteger(source.selection.total)||source.selection.total<source.selection.ids.length||source.selection.total>0&&!source.selection.ids.length
    ||!Array.isArray(source.recipes)||!exact(source.observed,['stateSha256','header','file'])||!hash(source.observed.stateSha256))fail('历史原件来源、范围或结构无效');
  const target=chatCharacterReceiptTarget(source.target);
  if(!equal(target,source.target))fail('历史来源包含不支持的定位字段');
  const {header,file}=source.observed;
  if(!exact(header,['kind','bytes','sha256'])||header.kind!=='jsonl-header'||!hash(header.sha256)||!Number.isSafeInteger(header.bytes)||header.bytes<1||header.bytes>CHAT_GALLERY_STATE_LIMITS.bytes
    ||!exact(file,['bytes','sha256'])||!hash(file.sha256)||!Number.isSafeInteger(file.bytes)||file.bytes<header.bytes||file.bytes>128*1048576)fail('历史原件缺少有效保存文件观察摘要');
  const saved=await projectChatGalleryState(source.saved,{namespace:source.namespace,chatKey:target.chatId});await guard();
  if(!equal(saved,source.saved))fail('历史原件包含不支持的顶层资料，未静默舍弃');
  const rows=source.saved.storyboardImages,ids=source.selection.ids;
  if(rows.length!==ids.length||new Set(ids).size!==ids.length||source.recipes.length!==ids.length)fail('历史画面、配方与选择范围不完整');
  if(ids.length===source.selection.total&&(await vibeDigest(chatGalleryReceiptText(rows).text)!==source.gallerySha256||await vibeDigest(JSON.stringify(source.saved))!==source.observed.stateSha256))fail('完整历史原件与原保存摘要不符');
  await inspectStoryboardChatEvidence(source.chatEvidence,target.chatId);await guard();
  const expectedAccount='st-user:'+await vibeDigest(source.namespace.slice(8));
  for(let i=0;i<rows.length;i++){
    const row=rows[i],recipe=source.recipes[i];
    chatGalleryRecordSelection({recordId:row.id,createdAt:row.createdAt,gallerySha256:source.gallerySha256});
    if(row.id!==ids[i]||row.recipeUnavailable===true||!exact(recipe,['recordId','createdAt','origin','reference','snapshot'])||recipe.recordId!==row.id||recipe.createdAt!==row.createdAt)fail('历史配方与画面编号、生成时间不匹配');
    const parsed=recipeArchiveSnapshot(recipe.snapshot);await assertPortableStoryboardData(parsed.snapshot);await guard();
    if(row.snapshot!=null){
      if(recipe.origin!=='saved-inline'||recipe.reference!==null||!equal(parsed.snapshot,recipeArchiveSnapshot(row.snapshot).snapshot))fail('历史内联配方不符');
    }else{
      const ref=recipeArchiveReference(row.snapshotServerRef);
      if(recipe.origin!=='server-archive'||!equal(recipeArchiveReference(recipe.reference),ref))fail('历史服务器配方引用不符');
      const envelope=recipeArchiveEnvelope({version:1,expectedAccount,source:{target,recordId:row.id,createdAt:row.createdAt},snapshot:parsed.snapshot});
      if(new TextEncoder().encode(envelope.text).byteLength!==ref.bytes||await vibeDigest(envelope.text)!==ref.sha256)fail('历史配方原文与服务器保存指纹不符');
    }
    await guard();
  }
  return source;
}

function summary(source,images){
  return {scope:HISTORICAL_BUNDLE_SCOPE,images:images.length,selected:source.selection.ids.length,total:source.selection.total,
    recipes:source.recipes.length,characterDrafts:source.saved.characterDrafts?.items.length??0,
    collections:source.saved.storyboardCollections?.length??0,restoreSupported:false,
    excluded:['chat-body','global-settings','shared-libraries','referenced-assets'],credentialsIncluded:false};
}

// Owns and ALWAYS closes the read-only source session. readImage is supplied by
// the existing guarded original-image reader; never download arbitrary URLs here.
// Source observers and caller guard must remain live until the returned file is handed off.
export async function captureHistoricalStoryboardBundle({session,readImage,guard,signal,timeoutMs=600000,createdAt=Date.now()}={}){
  if(!session?.source||typeof session.verify!=='function'||typeof session.close!=='function'||typeof readImage!=='function'||typeof guard!=='function'
    ||!Number.isFinite(timeoutMs)||timeoutMs<1)fail('缺少历史原件会话、受限原图读取器或账户保护');
  const controller=new AbortController();let reject;
  const cancelled=new Promise((_,no)=>reject=no);
  const abort=()=>{controller.abort();session.close();reject(Object.assign(new Error('历史原件打包已取消或超时，未交付缺件包'),{code:'historical_storyboard_bundle'}));};
  const check=async()=>{if(controller.signal.aborted)fail('历史原件打包已结束');await guard();if(controller.signal.aborted)fail('历史原件打包已结束');};
  signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,Math.min(600000,timeoutMs));
  try{
    if(signal?.aborted)abort();
    return await Promise.race([(async()=>{
      await check();await session.verify({signal:controller.signal});await check();
      const source=await inspectHistoricalStoryboardSource(session.source,{guard:check});await check();
      const entries=[{id:'historical-originals',file:json(source)}],images=[],files=new Map();
      let size=entries[0].file.size+STORYBOARD_BUNDLE_LIMITS.manifest+STORYBOARD_BUNDLE_LIMITS['historical-media'];
      for(const row of source.saved.storyboardImages){
        await check();
        const file=await readImage({namespace:source.namespace,target:structuredClone(source.target),gallerySha256:source.gallerySha256,recordId:row.id,createdAt:row.createdAt,url:row.url},{signal:controller.signal,guard:check});await check();
        if(!(file instanceof Blob)||file.size<1||file.size>STORYBOARD_BUNDLE_LIMITS.image)fail('历史原图缺失或超过分段上限 16 MiB，未截断或重压缩');
        const bytes=new Uint8Array(await file.arrayBuffer());await check();
        const mime=comfyReferenceStillMime(bytes),sha256=await vibeDigest(bytes);await check();
        if(!files.has(sha256)){
          size+=file.size;if(size>STORYBOARD_BUNDLE_LIMITS.total)fail('历史原件联包超过 512 MiB，请减少选择');
          const entry={id:`image:${sha256}`,mime,file};files.set(sha256,entry);entries.push(entry);
        }
        images.push({recordId:row.id,createdAt:row.createdAt,sha256,bytes:file.size,mime});
      }
      entries.push({id:'historical-media',file:json({schema:mediaSchema,images})});
      const result=await buildStoryboardBundle({namespace:source.namespace,chatKey:source.target.chatId,scope:HISTORICAL_BUNDLE_SCOPE,entries,createdAt},{guard:check});
      await session.verify({signal:controller.signal});await check();
      return {...result,summary:summary(source,images)};
    })(),cancelled]);
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();session.close();}
}

export async function inspectHistoricalStoryboardBundle(file,{guard=async()=>{}}={}){
  const opened=await openStoryboardBundle(file,{guard});
  if(opened.manifest.scope!==HISTORICAL_BUNDLE_SCOPE)fail('此入口只核对历史原件联包，不替代当前配置恢复');
  const source=await inspectHistoricalStoryboardSource(await opened.readJson('historical-originals'),{guard});
  if(source.namespace!==opened.manifest.namespace||source.target.chatId!==opened.manifest.chatKey)fail('历史原件与包目录账户或聊天不符');
  const media=await opened.readJson('historical-media'),rows=source.saved.storyboardImages;
  if(!exact(media,['schema','images'])||media.schema!==mediaSchema||!Array.isArray(media.images)||media.images.length!==rows.length)fail('历史原图清单缺失或多余');
  const files=new Map();
  for(let i=0;i<rows.length;i++){
    const row=media.images[i],record=rows[i];
    if(!exact(row,['recordId','createdAt','sha256','bytes','mime'])||row.recordId!==record.id||row.createdAt!==record.createdAt||!hash(row.sha256)
      ||!Number.isSafeInteger(row.bytes)||row.bytes<1||row.bytes>STORYBOARD_BUNDLE_LIMITS.image||!['image/png','image/jpeg','image/webp'].includes(row.mime))fail('历史原图清单与画面不匹配');
    const known=files.get(row.sha256);
    if(known&&(known.bytes!==row.bytes||known.mime!==row.mime))fail('相同原图指纹对应不同收据');
    files.set(row.sha256,row);
  }
  const parts=opened.manifest.entries.filter(row=>row.id.startsWith('image:'));
  if(parts.length!==files.size)fail('历史原图分段缺失或多余');
  for(const row of parts){
    const expected=files.get(row.sha256);
    if(!expected||expected.bytes!==row.bytes||expected.mime!==row.mime)fail('历史原图分段收据不符');
    const part=await opened.read(row.id);if(comfyReferenceStillMime(part.bytes)!==row.mime)fail('历史原图实际格式不符');await guard();
  }
  return {manifest:opened.manifest,fingerprint:opened.fingerprint,source,media,summary:summary(source,media.images)};
}
