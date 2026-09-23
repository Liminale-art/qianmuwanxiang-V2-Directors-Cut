import {COMFY_SCENE_STORE_LIMITS} from './qianmu-comfy-lock-store.js';
import {comfySceneScopeKey,normalizeComfySceneRecord,comfySceneLockError} from './qianmu-comfy-scene-lock.js';
import {assertComfyRouteNamespace} from './qianmu-comfy-route-contract.js';

// Full stored records, never inspectComfySceneRecord's time-dependent display.
// Unknown/lossy data stops preservation; the original local tables stay intact.
export const COMFY_SCENE_SNAPSHOT_SCHEMA='qianmu.comfy.scene-snapshot.v1';
export const COMFY_SCENE_SNAPSHOT_BYTES=8*1024*1024-2048;
const fail=message=>{throw comfySceneLockError('snapshot',message);};
export const comfySceneSnapshotBytes=value=>new TextEncoder().encode(JSON.stringify(value)).byteLength;
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
function completeJson(value){
  const ancestors=new Set();let nodes=0;
  const visit=(v,depth=0)=>{
    if(++nodes>500000||depth>24)fail('续场原件结构超过保存范围');
    if(v===null||typeof v==='boolean'||typeof v==='string')return;
    if(typeof v==='number'){if(!Number.isFinite(v)||Object.is(v,-0))fail('续场原始数值不能无损保存');return;}
    if(!v||typeof v!=='object'||ancestors.has(v)||!Array.isArray(v)&&![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail('续场原件含不可无损保存的值');
    const keys=Object.keys(v),own=Reflect.ownKeys(v);if(own.length!==keys.length+(Array.isArray(v)?1:0)||Array.isArray(v)&&(keys.length!==v.length||keys.some((key,i)=>key!==String(i))))fail('续场原始字段不完整');
    ancestors.add(v);for(const key of keys){const d=Object.getOwnPropertyDescriptor(v,key);if(!d?.enumerable||!Object.hasOwn(d,'value'))fail('续场原件含不可读取字段');visit(d.value,depth+1);}ancestors.delete(v);
  };visit(value);
}
export const sameComfySceneSnapshot=(a,b)=>canonical(a)===canonical(b);
export async function comfySceneSnapshotDigest(value){
  if(!globalThis.crypto?.subtle)fail('当前环境不能核对完整续场原件');
  const input=new TextEncoder().encode(canonical(value));if(input.byteLength>COMFY_SCENE_SNAPSHOT_BYTES)fail('完整续场原件超过保存上限，未裁剪');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',input))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
export function validateComfySceneSnapshot(value,{limits=COMFY_SCENE_STORE_LIMITS}={}){
  completeJson(value);
  const quota={};for(const key of Object.keys(COMFY_SCENE_STORE_LIMITS)){const n=limits[key];if(!Number.isSafeInteger(n)||n<1||n>COMFY_SCENE_STORE_LIMITS[key])fail('续场原件容量设置无效');quota[key]=n;}
  if(!exact(value,['schema','namespace','usage','rows'])||value.schema!==COMFY_SCENE_SNAPSHOT_SCHEMA)fail('完整续场原件格式无效');
  const namespace=assertComfyRouteNamespace(value.namespace);
  if(!Array.isArray(value.rows)||value.rows.length>quota.scopes||comfySceneSnapshotBytes(value)>COMFY_SCENE_SNAPSHOT_BYTES)fail('完整续场原件超出原有容量');
  if(value.usage!==null&&(!exact(value.usage,['count','bytes','generation'])||!Object.values(value.usage).every(n=>Number.isSafeInteger(n)&&n>=0)))fail('续场原始计值无效');
  let total=0,previous='';
  for(const entry of value.rows){
    if(!exact(entry,['key','value'])||typeof entry.key!=='string'||entry.key<=previous||!exact(entry.value,['namespace','chatKey','bytes','record']))fail('续场原始记录或键重复/无效');
    previous=entry.key;const row=entry.value,record=normalizeComfySceneRecord(row.record,row.record?.scope);
    if(!sameComfySceneSnapshot(record,row.record)||record.revision<1)fail('续场原件含无法无损保留的字段，未改写');
    if(row.namespace!==namespace||record.scope.namespace!==namespace||record.scope.chatKey!==row.chatKey||comfySceneScopeKey(record.scope)!==entry.key)fail('续场原始记录的账户、聊天或键不符');
    const size=comfySceneSnapshotBytes(row.record);if(row.bytes!==size||size>quota.rowBytes)fail('续场原始正文计值不符');total+=size;
  }
  if(total>quota.bytes||value.usage===null&&value.rows.length||value.usage&&(value.usage.count!==value.rows.length||value.usage.bytes!==total))fail('续场两表原件不一致，未按空库保存');
  return {count:value.rows.length,documentBytes:total,generation:value.usage?.generation??0,bytes:comfySceneSnapshotBytes(value)};
}

// Both stores are read in one IDB transaction. Keep tombstones, raw labels,
// expired reservations, tokens and original generation; no timer cleanup here.
export function readComfySceneSnapshot(tx,namespace,keyRange,{limits,isCurrent=()=>true}={},output,abort){
  const valid=()=>{if(isCurrent()!==true)fail('续场原件读取页面已变化');};
  valid();const request=tx.objectStore('usage').get(namespace);
  request.onsuccess=()=>{try{
    valid();const result={schema:COMFY_SCENE_SNAPSHOT_SCHEMA,namespace,usage:request.result===undefined?null:structuredClone(request.result),rows:[]};
    const scan=tx.objectStore('scopes').index('chat').openCursor(keyRange.bound([namespace],[namespace,[]]));
    scan.onsuccess=()=>{try{
      valid();const cursor=scan.result;
      if(!cursor){
        result.rows.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);validateComfySceneSnapshot(result,{limits});
        // A damaged chat index must not hide a primary-key record and turn it
        // into a successful empty snapshot. All reads share this transaction.
        const prefix=JSON.stringify([namespace]).slice(0,-1)+',';
        const keys=tx.objectStore('scopes').getAllKeys(keyRange.bound(prefix,prefix+'\uffff'),(limits?.scopes??COMFY_SCENE_STORE_LIMITS.scopes)+1);
        keys.onsuccess=()=>{try{valid();if(!sameComfySceneSnapshot(keys.result,result.rows.map(row=>row.key)))fail('续场主键与聊天索引不一致，未保存空来源');output(result);}catch(error){abort(error);}};return;
      }
      if(result.rows.length>=(limits?.scopes??COMFY_SCENE_STORE_LIMITS.scopes))fail('续场原件数量超过原有上限');
      result.rows.push({key:cursor.primaryKey,value:structuredClone(cursor.value)});cursor.continue();
    }catch(error){abort(error);}};
  }catch(error){abort(error);}};
}
