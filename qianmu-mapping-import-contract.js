import {validateMappingHead,mappingBytes} from './qianmu-storyboard-mapping-contract.js';
export const MAPPING_IMPORT_LIMIT=9*1048576+1024;
export const isMappingImport=action=>action==='mapping-import-preview'||action==='mapping-import-apply';
const exact=(value,fields)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key));
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fail=()=>{throw Object.assign(new Error('迁移凭据导入内容或确认不完整，请重新选择原文件核对'),{code:'storyboard_mapping_import'});};
export function validateMappingImportInput(action,input){
  if(!isMappingImport(action)||!exact(input,['file',...(action==='mapping-import-apply'?['fileDigest','planDigest','confirmed']:[])])||!(input.file instanceof Blob)||input.file.size<1||input.file.size>MAPPING_IMPORT_LIMIT)fail();
  if(action==='mapping-import-apply'&&(!hash(input.fileDigest)||!hash(input.planDigest)||input.confirmed!==true))fail();return input;
}
export function validateMappingImportPreview(value,namespace){
  if(!exact(value,['version','namespace','fileDigest','planDigest','head','state','beforeCount','afterCount','addedBytes','totalBytes','restoreAuthorized'])||value.version!==1||value.namespace!==namespace||!hash(value.fileDigest)||!hash(value.planDigest)||!['new','same'].includes(value.state)||value.restoreAuthorized!==false)fail();
  validateMappingHead(value.head,namespace);
  if(!['beforeCount','afterCount','addedBytes','totalBytes'].every(key=>Number.isSafeInteger(value[key])&&value[key]>=0)||value.beforeCount>512||value.afterCount>512||value.afterCount!==value.beforeCount+Number(value.state==='new')
    ||value.addedBytes!==(value.state==='new'?value.head.bytes+mappingBytes(value.head):0)||value.totalBytes<value.head.bytes+mappingBytes(value.head)||value.totalBytes>71*1048576)fail();return value;
}
export function validateMappingImportResult(value,namespace,input){
  validateMappingImportInput('mapping-import-apply',input);
  if(!exact(value,['version','namespace','fileDigest','planDigest','head','outcome','restoreAuthorized'])||value.version!==1||value.namespace!==namespace||value.fileDigest!==input.fileDigest||value.planDigest!==input.planDigest||!['added','reused'].includes(value.outcome)||value.restoreAuthorized!==false)fail();validateMappingHead(value.head,namespace);return value;
}
