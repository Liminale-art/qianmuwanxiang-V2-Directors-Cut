import {vibeFileError} from './qianmu-vibe-file.js';

const fail=(code,message)=>{throw vibeFileError(code,message);};
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export const VIBE_ASSET_LIMITS=Object.freeze({count:1024,bytes:512*1024*1024});
export function vibeAssetNamespace(value){
  if(typeof value!=='string'||!/^st-user:.+/.test(value)||value.length>512||/[\u0000-\u001f\u007f]/.test(value))fail('account','无法确认当前 ST 账户');return value;
}
export function vibeAssetKey(account,id){vibeAssetNamespace(account);if(!hash(id))fail('asset','Vibe 资产编号无效');return JSON.stringify([account,id]);}

// Shared by the existing IDB reader and native preservation. Keep the legacy
// contract (including fractional createdAt and absent previewBytes) unchanged.
export function validateVibeAssetHead(head,account){
  if(!head||head.namespace!==account||head.key!==vibeAssetKey(account,head.assetId)||!Number.isSafeInteger(head.bytes)||head.bytes<1||head.bytes>64*1024*1024
    ||!Number.isSafeInteger(head.previewBytes??0)||(head.previewBytes??0)<0||(head.previewBytes??0)>2*1024*1024
    ||!head.summary||head.summary.assetId!==head.assetId||!Number.isFinite(head.createdAt))fail('index','Vibe 资产索引损坏，请先保全数据');
  const info=head.summary;
  if(!hash(info.sourceId)||!['image','encoding'].includes(info.type)||typeof info.name!=='string'||info.name.length>100
    ||typeof info.hasThumbnail!=='boolean'||info.hasImage!==(info.type==='image')||!Array.isArray(info.variants)||info.variants.length>256
    ||info.variants.some(row=>!row||typeof row.model!=='string'||row.model.length>160||typeof row.variant!=='string'||row.variant.length>160
      ||typeof row.customParams!=='boolean'||!(row.information===null||typeof row.information==='number'&&Number.isFinite(row.information)&&row.information>=0&&row.information<=1)))fail('index','Vibe 资产目录损坏，请先保全数据');return head;
}
