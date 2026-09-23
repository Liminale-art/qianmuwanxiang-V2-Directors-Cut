import {stAccountImmutableReference} from './qianmu-st-account-storage.js';
import {inspectBundleCarrierOriginal} from './qianmu-bundle-carrier.js';
import {validateBundleCarrierOriginalHead} from './qianmu-bundle-carrier-storage-contract.js';
import {CARRIER_ORIGINAL_SLOT,CARRIER_PART_SLOT,CARRIER_RAW_SCHEMA,CARRIER_PART_SCHEMA,CARRIER_PART_BYTES,carrierExact,carrierNativeFail as fail} from './qianmu-bundle-carrier-native-contract.js';

const encode=bytes=>{const parts=[];for(let at=0;at<bytes.length;at+=16384)parts.push(String.fromCharCode(...bytes.subarray(at,at+16384)));return btoa(parts.join(''));};
function decode(text,size){
  if(typeof text!=='string'||text.length!==4*Math.ceil(size/3)||!/^[A-Za-z0-9+/]*={0,2}$/.test(text))fail('来源分块编码或大小无效');
  let raw;try{raw=atob(text);}catch{fail('来源分块编码无效');}
  if(raw.length!==size)fail('来源分块大小不符');const bytes=Uint8Array.from(raw,ch=>ch.charCodeAt(0));
  if(encode(bytes)!==text)fail('来源分块编码不规范');return bytes;
}
function manifest(value,head,client){
  validateBundleCarrierOriginalHead(head,client.namespace);
  if(!carrierExact(value,['schema','namespace','sha256','bytes','parts'])||value.schema!==CARRIER_RAW_SCHEMA||value.namespace!==client.namespace
    ||value.sha256!==head.sha256||value.bytes!==head.bytes||!Array.isArray(value.parts)||value.parts.length!==Math.ceil(head.bytes/CARRIER_PART_BYTES))fail('来源原件分块目录不符');
  for(const [at,row] of value.parts.entries()){
    if(!carrierExact(row,['bytes','reference'])||row.bytes!==Math.min(CARRIER_PART_BYTES,head.bytes-at*CARRIER_PART_BYTES))fail('来源原件分块不完整');
    // The valid account name may be 512 UTF-16 code units, not 512 UTF-8 bytes.
    stAccountImmutableReference(row.reference,{scope:client.scope,slot:CARRIER_PART_SLOT,maxBytes:Math.ceil(CARRIER_PART_BYTES/3)*4+4096});
  }return value;
}
function part(value,size,namespace){
  if(!carrierExact(value,['schema','namespace','data'])||value.schema!==CARRIER_PART_SCHEMA||value.namespace!==namespace)fail('来源分块归属不符');return decode(value.data,size);
}
// One raw original at a time. JSON is never parsed/reserialized for transport:
// even whitespace, exponent notation and encoding bytes retain their raw SHA.
export async function preserveCarrierNativeRaw(client,file,head,transport){
  await transport.guard();const member=await inspectBundleCarrierOriginal(file,head,{namespace:client.namespace,guard:transport.guard}),parts=[];
  for(let offset=0;offset<file.size;offset+=CARRIER_PART_BYTES){
    await transport.guard();const bytes=new Uint8Array(await file.slice(offset,offset+CARRIER_PART_BYTES).arrayBuffer());await transport.guard();
    const value={schema:CARRIER_PART_SCHEMA,namespace:client.namespace,data:encode(bytes)},saved=await client.preserveImmutable(CARRIER_PART_SLOT,value,transport);
    part(saved.value,bytes.length,client.namespace);if(saved.value.data!==value.data)fail('来源分块读回不符');parts.push({bytes:bytes.length,reference:saved.reference});await transport.progress?.();
  }
  const value={schema:CARRIER_RAW_SCHEMA,namespace:client.namespace,sha256:head.sha256,bytes:head.bytes,parts};
  const saved=await client.preserveImmutable(CARRIER_ORIGINAL_SLOT,value,transport);manifest(saved.value,head,client);
  if(JSON.stringify(saved.value)!==JSON.stringify(value))fail('来源原件目录读回不符');await transport.guard();await transport.progress?.();return {descriptor:{head,reference:saved.reference},member};
}
export async function readCarrierNativeRaw(client,descriptor,transport){
  stAccountImmutableReference(descriptor.reference,{scope:client.scope,slot:CARRIER_ORIGINAL_SLOT,maxBytes:16384});
  const saved=await client.readImmutable(descriptor.reference,transport),value=manifest(saved.value,descriptor.head,client),parts=[];
  for(const row of value.parts){await transport.guard();const saved=await client.readImmutable(row.reference,transport);parts.push(part(saved.value,row.bytes,client.namespace));await transport.progress?.();}
  const file=new Blob(parts,{type:'application/json'});await transport.guard();
  const member=await inspectBundleCarrierOriginal(file,descriptor.head,{namespace:client.namespace,guard:transport.guard});return {file,member};
}
