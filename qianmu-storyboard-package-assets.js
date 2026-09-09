import {retainVibeAssetRef} from './qianmu-vibe-asset-ref.js';
import {retainStoryboardVibeRecipe} from './qianmu-vibe-recipe.js';
import {parseNovelVibeFile,vibeFileError} from './qianmu-vibe-file.js';
import {inspectStoryboardPortableSelections} from './qianmu-storyboard-package-fields.js';
import {assertPortableStoryboardData} from './qianmu-storyboard-package-security.js';
export {assertPortableStoryboardData};
export {assertStoryboardPresetDataRetained} from './qianmu-storyboard-package-presets.js';
export {assertStoryboardRelationsRetained} from './qianmu-storyboard-package-relations.js';
export {captureStoryboardPackageSettings,assertStoryboardAdditionalSettingsRetained} from './qianmu-storyboard-package-fields.js';

export const STORYBOARD_PACKAGE_LIMITS=Object.freeze({metadata:32*1048576,mediaItem:34*1048576,total:128*1048576,assets:1024,nodes:500000,depth:40,uses:30000});
const fail=message=>{throw vibeFileError('package',message);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const size=value=>new TextEncoder().encode(value).byteLength;
const account=value=>typeof value==='string'&&/^st-user:.+/.test(value)&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
const identity=ref=>JSON.stringify([ref.namespace,ref.id]);
const pointer=path=>'$'+path.map(key=>`[${JSON.stringify(key)}]`).join('');

// Visit typed Vibe sources, not arbitrary assetRef fields belonging to Comfy or another module.
// The complete settings/chat tree includes archived pipelines, plans, task snapshots and old gallery records.
export function collectStoryboardVibeDependencies(payload,{namespace=null,onReference=()=>{}}={}){
  if(!object(payload)||payload.type!=='qianmu-storyboard'||!object(payload.settings)||!object(payload.chat))fail('分镜包元数据结构无效');
  const refs=new Map(),legacy=new Map(),seen=new WeakSet();let nodes=0,uses=0;
  function reference(row,path){
    if(!object(row))fail(`Vibe 来源无效：${pointer(path)}`);
    if(++uses>STORYBOARD_PACKAGE_LIMITS.uses)fail('Vibe 引用位置过多，请分批打包');
    if(Object.hasOwn(row,'assetRef')){
      const ref=retainVibeAssetRef(row.assetRef);if(ref.invalid)fail(`Vibe 原文件编号无效：${pointer(path)}`);
      if(namespace!==null&&ref.namespace!==namespace)fail(`Vibe 原文件属于其他账户：${pointer(path)}；请先在原账户导出`);
      const key=identity(ref);if(!refs.has(key)){if(refs.size>=STORYBOARD_PACKAGE_LIMITS.assets)fail('Vibe 原文件超过 1024 份');refs.set(key,{...ref,uses:[]});}
      refs.get(key).uses.push(pointer([...path,'assetRef']));onReference(row,ref);return;
    }
    if(typeof row.previewUrl==='string'&&row.previewUrl){const key=row.previewUrl;if(!legacy.has(key))legacy.set(key,{url:key,uses:[]});legacy.get(key).uses.push(pointer(path));}
  }
  function visit(value,path,depth){
    if(++nodes>STORYBOARD_PACKAGE_LIMITS.nodes||depth>STORYBOARD_PACKAGE_LIMITS.depth)fail('分镜元数据层级或条目过多');
    if(value===null||typeof value!=='object')return;
    if(seen.has(value))fail('分镜元数据含循环，请先保存为独立快照');seen.add(value);
    if(Array.isArray(value)){value.forEach((item,index)=>visit(item,[...path,index],depth+1));seen.delete(value);return;}
    if(!object(value))fail('分镜元数据含不可打包对象');
    for(const [key,item] of Object.entries(value)){
      if(['__proto__','prototype','constructor'].includes(key))fail('分镜元数据含不安全字段');
      const next=[...path,key];
      if(key==='vibeLibrary'){
        if(!Array.isArray(item))fail('Vibe 库不是有效列表');item.forEach((row,index)=>reference(row,[...next,index]));
      }
      if(key==='vibeRecipe'){
        const recipe=retainStoryboardVibeRecipe(item);if(recipe.invalid)fail(`Vibe 冻结配方不完整：${pointer(next)}`);
        if(Object.hasOwn(value,'selectedVibeIds')&&JSON.stringify(value.selectedVibeIds)!==JSON.stringify(recipe.items.map(row=>row.id)))fail(`Vibe 选择与冻结配方不符：${pointer(next)}`);
        item.items.forEach((row,index)=>reference(row,[...next,'items',index]));
      }
      visit(item,next,depth+1);
    }
    seen.delete(value);
  }
  visit(payload.settings,['settings'],0);visit(payload.chat,['chat'],0);
  return {refs:[...refs.values()],legacyUrls:[...legacy.values()]};
}

// Blob parts avoid assembling a second giant JSON string. Assets are verified/serialized one at a time in the Worker.
// Only the packet's referenced assets are included; this is not an account-wide DB or fee-queue backup.
export async function buildStoryboardVibePackage(payload,{namespace,load}){
  if(!account(namespace)||typeof load!=='function')fail('无法确认分镜打包账户');
  const {media=[],vibeAssets:ignoredAssets,vibeAccount:ignoredAccount,...metadata}=payload;
  inspectStoryboardPortableSelections(metadata.settings,namespace);
  if(!Array.isArray(media)||media.length>400)fail('分镜媒体列表超过 400 项或结构无效');
  const header=JSON.stringify({...metadata,version:7,vibeAccount:namespace});
  if(size(header)>STORYBOARD_PACKAGE_LIMITS.metadata)fail('分镜元数据超过 32 MiB，请分批导出');
  await assertPortableStoryboardData(metadata);
  const census=collectStoryboardVibeDependencies(metadata,{namespace});
  const parts=[header.slice(0,-1),',"media":['];let bytes=size(header)+64,first=true;
  const add=text=>{bytes+=size(text);if(bytes>STORYBOARD_PACKAGE_LIMITS.total)fail('分镜包超过 128 MiB，请分批备份，未生成缺件包');parts.push(text);};
  for(const item of media){const text=JSON.stringify(item);if(typeof text!=='string'||size(text)>STORYBOARD_PACKAGE_LIMITS.mediaItem)fail('单份分镜媒体无效或超过支持上限');if(!first)add(',');add(text);first=false;}
  add('],"vibeAssets":[');first=true;
  for(const ref of census.refs){
    const asset=await load(ref.namespace,ref.id);if(!asset||asset.assetId!==ref.id)fail(`缺少 Vibe 原文件 ${ref.id}；未导出不完整包`);
    // store.load already validates; also validate injected loaders before trusting a supposedly verified identity.
    const [verified]=await parseNovelVibeFile(asset.serialized);
    if(verified.assetId!==ref.id||verified.serialized!==asset.serialized)fail(`Vibe 原文件内容不符 ${ref.id}`);
    await assertPortableStoryboardData(verified.document);
    if(!first)add(',');add(`{"namespace":${JSON.stringify(ref.namespace)},"id":${JSON.stringify(ref.id)},"bytes":${verified.bytes},"document":`);
    add(verified.serialized);add('}');first=false;
  }
  add(']}');const file=new Blob(parts,{type:'application/json'});
  if(file.size>STORYBOARD_PACKAGE_LIMITS.total)fail('分镜包超过支持上限');
  return {file,manifest:{version:1,vibeFiles:census.refs.length,vibeUses:census.refs.reduce((sum,row)=>sum+row.uses.length,0),legacyVibeUrls:census.legacyUrls.length,bytes:file.size}};
}

// Whole packet validation is a prerequisite, never a restore authority. No DB write, namespace remap or fee replay here.
export async function inspectStoryboardVibePackage(payload){
  if(!object(payload)||payload.version!==7||!account(payload.vibeAccount)||!Array.isArray(payload.vibeAssets)||payload.vibeAssets.length>STORYBOARD_PACKAGE_LIMITS.assets)fail('分镜包版本或 Vibe 原文件清单无效');
  const {vibeAssets,media=[],...metadata}=payload;
  inspectStoryboardPortableSelections(metadata.settings,payload.vibeAccount);
  if(size(JSON.stringify(metadata))>STORYBOARD_PACKAGE_LIMITS.metadata||!Array.isArray(media)||media.length>400)fail('分镜包元数据超限');
  await assertPortableStoryboardData(metadata);
  const census=collectStoryboardVibeDependencies(metadata,{namespace:payload.vibeAccount}),expected=new Map(census.refs.map(row=>[identity(row),row])),assets=[];
  let bytes=size(JSON.stringify(metadata));for(const item of media){const text=JSON.stringify(item);if(typeof text!=='string'||size(text)>STORYBOARD_PACKAGE_LIMITS.mediaItem)fail('分镜媒体超限');bytes+=size(text);if(bytes>STORYBOARD_PACKAGE_LIMITS.total)fail('分镜包总内容超限');}
  for(const row of vibeAssets){
    if(!object(row)||Object.keys(row).some(key=>!['namespace','id','bytes','document'].includes(key))||row.namespace!==payload.vibeAccount)fail('Vibe 文件归属或结构不符');
    const key=identity(row);if(!expected.has(key))fail('分镜包含多余或重复的 Vibe 原文件');
    const text=JSON.stringify(row.document),parsed=await parseNovelVibeFile(text),asset=parsed[0];
    if(parsed.length!==1||asset.serialized!==text||asset.assetId!==row.id||asset.bytes!==row.bytes)fail('Vibe 原文件摘要、单项结构或大小不符');
    await assertPortableStoryboardData(asset.document);
    bytes+=asset.bytes+1024;if(bytes>STORYBOARD_PACKAGE_LIMITS.total)fail('分镜包总内容超限');
    expected.delete(key);assets.push({namespace:row.namespace,...asset});
  }
  if(expected.size)fail(`分镜包缺少 ${expected.size} 份 Vibe 原文件，未导入任何数据`);
  return {assets,census};
}

export function remapStoryboardVibeReferences(payload,targetNamespace){
  if(!account(targetNamespace))fail('无法确认目标账户');
  // Do not duplicate hundreds of MiB of media/documents just to change lightweight references.
  const output={...payload,settings:structuredClone(payload.settings),chat:structuredClone(payload.chat)};
  collectStoryboardVibeDependencies(output,{namespace:payload.vibeAccount});
  collectStoryboardVibeDependencies(output,{onReference:(row,ref)=>{row.assetRef={version:1,namespace:targetNamespace,id:ref.id};}});
  return output;
}

export async function createStoryboardPackageGuard({initial,context,resolveNamespace}){
  const matches=()=>{const now=context();return now.state===initial.state&&now.store===initial.store&&now.chatKey===initial.chatKey&&now.epoch===initial.epoch;};
  if(!initial.state||!initial.store||!initial.chatKey||!matches())fail('分镜打包环境已变化');
  const namespace=await resolveNamespace();if(!account(namespace)||!matches())fail('无法确认分镜打包账户或聊天');
  return Object.freeze({namespace,async guard(){if(!matches())fail('分镜打包账户或聊天已变化');const current=await resolveNamespace();if(current!==namespace||!matches())fail('分镜打包账户或聊天已变化');}});
}
