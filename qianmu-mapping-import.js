import {MAPPING_IMPORT_LIMIT,validateMappingImportInput,validateMappingImportPreview,validateMappingImportResult} from './qianmu-mapping-import-contract.js';
import {parseStrictStoryboardJson} from './qianmu-storyboard-package-input.js';
import {mappingHead,mappingBytes} from './qianmu-storyboard-mapping-contract.js';
import {validateBundleMappingHeads,sameBundleMappingHead} from './qianmu-bundle-mapping-contract.js';
import {inspectBundleMappingReceipt} from './qianmu-bundle-mappings.js';
import {vibeDigest} from './qianmu-vibe-file.js';
import {comfyLibraryBackupDigest as digest} from './qianmu-comfy-library-backup.js';
const fail=message=>{throw Object.assign(new Error(message),{code:'storyboard_mapping_import'});};
const ordered=heads=>[...heads].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);

// Import only immutable historical records. No role, configuration, resource, credential or generation writer.
export async function runMappingImport(action,{journal,namespace,input,guard=async()=>{},isCurrent=()=>true,locks=globalThis.navigator?.locks}={}){
  validateMappingImportInput(action,input);const request=structuredClone(input);
  const check=async()=>{if(isCurrent()!==true)fail('迁移凭据页面或账户已变化');await guard();if(isCurrent()!==true)fail('迁移凭据页面或账户已变化');};
  const list=async()=>{await check();const rows=structuredClone(await journal.listMappingHeads(namespace,{guard:check,isCurrent}));validateBundleMappingHeads(rows,namespace);await check();return ordered(rows);};
  async function inspect(){
    await check();const bytes=new Uint8Array(await request.file.arrayBuffer());await check();const fileDigest=await vibeDigest(bytes);await check();
    let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch(_){fail('迁移凭据文件不是完整UTF-8');}
    const envelope=parseStrictStoryboardJson(text,{maxBytes:MAPPING_IMPORT_LIMIT});
    if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||Object.keys(envelope).length!==3||!['schema','kind','receipt'].every(key=>Object.hasOwn(envelope,key))||envelope.schema!=='qianmu.storyboard.mapping-receipt.v1'||!['environment','subjects'].includes(envelope.kind))fail('不是完整迁移凭据文件，请选择导出的 .mapping.json');
    const {kind,receipt}=envelope;if(receipt?.namespace!==namespace)fail('此凭据不属于当前账户，跨账户派生尚未确认；未改写原记录');
    let head;try{head=mappingHead(kind,receipt);}catch(_){fail('迁移凭据原文结构不完整');}await inspectBundleMappingReceipt(receipt,head,namespace);await check();
    const before=await list(),local=before.find(row=>row.key===head.key);
    if(local){
      if(!sameBundleMappingHead(local,head))fail('同编号历史凭据与本机首次记录不同，未覆盖');
      const saved=await journal.loadMappingReceipt(namespace,kind,head.digest,{isCurrent});await check();await inspectBundleMappingReceipt(saved,head,namespace);
      if(await digest(saved)!==await digest(receipt))fail('同编号历史凭据原文不同，未覆盖');
    }
    const after=local?before:[...before,head];try{validateBundleMappingHeads(after,namespace);}catch(_){fail('迁移凭据名额或空间不足，不会自动删除历史');}
    if(await digest(before)!==await digest(await list()))fail('核对期间迁移凭据目录已变化，请重新核对');
    const view=validateMappingImportPreview({version:1,namespace,fileDigest,planDigest:await digest({namespace,fileDigest,head,before}),head,state:local?'same':'new',beforeCount:before.length,afterCount:after.length,
      addedBytes:local?0:head.bytes+mappingBytes(head),totalBytes:after.reduce((sum,row)=>sum+row.bytes+mappingBytes(row),0),restoreAuthorized:false},namespace);await check();return {view,receipt};
  }
  if(action==='mapping-import-preview')return (await inspect()).view;
  if(!locks?.request)fail('浏览器不支持跨页恢复锁，未导入迁移凭据');
  return locks.request(`qianmu:package-import:${namespace}`,{mode:'exclusive',ifAvailable:true},async lock=>{
    if(!lock)fail('另一页面正在导入或恢复，请结束后重新核对');
    const {view,receipt}=await inspect();if(view.planDigest!==request.planDigest||view.fileDigest!==request.fileDigest)fail('原文件或本机目录已变化，原确认已过期，请重新核对');
    await check();await journal.importMappingReceipt(receipt,{head:view.head,confirmed:true,isCurrent});await check();
    const saved=await journal.loadMappingReceipt(namespace,view.head.kind,view.head.digest,{isCurrent});await check();await inspectBundleMappingReceipt(saved,view.head,namespace);
    if(await digest(saved)!==await digest(receipt))fail('迁移凭据写后核对不符，请保留原文件');
    const savedHead=(await list()).find(row=>row.key===view.head.key);if(!sameBundleMappingHead(savedHead,view.head))fail('迁移凭据写后目录不符，请重新核对');await check();
    return validateMappingImportResult({version:1,namespace,fileDigest:view.fileDigest,planDigest:view.planDigest,head:view.head,outcome:view.state==='new'?'added':'reused',restoreAuthorized:false},namespace,request);
  });
}
