// Metadata-only upload plans and replies. Neither function grants file access,
// proves byte integrity or sends a request. The host must authorize selected
// source bytes and the exact cloud account before using this contract.
import { bindComfyCloudProtocol, comfyCloudAssetId } from './qianmu-comfy-cloud-protocol.js';
import { normalizeStaticReferenceReceipt } from './qianmu-comfy-reference-contract.js';

const fail = () => { throw Object.assign(new Error('参考图上传信息不匹配，请重新核对；未提交生图'), {code:'comfy_cloud_upload_contract',submissionState:'not_submitted',retryable:false}); };
function plain(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail();
  if(Reflect.ownKeys(value).some(key=>typeof key!=='string'||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value')))fail();
  return value;
}
const extension = mime => ({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'})[mime];

export function planComfyCloudUpload(rawConnection, rawSource) {
  const connection=plain(rawConnection),source=Object.freeze(normalizeStaticReferenceReceipt(plain(rawSource)));
  const binding=bindComfyCloudProtocol(connection.origin,connection.protocol);
  if(connection.version!==binding.version||connection.provider!==binding.provider||connection.origin!==binding.origin)fail();
  const filename=`qianmu-${source.sha256}.${extension(source.mime)}`;
  const cloud=binding.provider==='comfy-cloud';
  return Object.freeze({version:1,connection:binding,source,method:'POST',effect:'upload',createsJob:false,redirect:'error',
    url:`${binding.origin}${cloud?'/api/v2/assets':'/openapi/v2/media/upload/binary'}`,fileField:'file',filename,
    fields:Object.freeze(cloud?{content_type:source.mime,file_path:filename}:{})});
}

export function readComfyCloudUpload(rawPlan, rawBody) {
  const plan=planComfyCloudUpload(plain(rawPlan).connection,rawPlan.source),body=plain(rawBody);
  // Recompute the requested target rather than accepting a mutated upload plan.
  if(rawPlan.url!==plan.url||rawPlan.filename!==plan.filename||rawPlan.method!==plan.method)fail();
  let reference;
  if(plan.connection.provider==='comfy-cloud') {
    const id=comfyCloudAssetId(body.id);
    if(!id||body.content_type!==plan.source.mime||body.size_bytes!==plan.source.bytes||body.file_path!==plan.filename
      ||!(body.hash===null||typeof body.hash==='string'&&/^blake3:[a-f0-9]{64}$/.test(body.hash)))fail();
    // The UUID is authoritative. A platform blake3 hash is NOT the source SHA256;
    // optional hints and expiring download URLs are not required in the graph.
    reference=Object.freeze({__type:'core/ASSET',info:Object.freeze({id})});
  } else {
    const data=plain(body.data),name=data.fileName;
    const size=typeof data.size==='string'&&/^[1-9]\d{0,8}$/.test(data.size)?Number(data.size):data.size;
    if(body.code!==0||data.type!=='image'||size!==plan.source.bytes||typeof name!=='string'
      ||!/^(?:api|openapi)\/[A-Za-z0-9_-]{1,192}\.(png|jpe?g|webp)$/i.test(name)
      ||(plan.source.mime==='image/jpeg'?!/\.jpe?g$/i.test(name):!name.toLowerCase().endsWith(`.${extension(plan.source.mime)}`)))fail();
    reference=name;
  }
  return Object.freeze({version:1,connection:plan.connection,source:plan.source,reference});
}
