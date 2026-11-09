const fail=message=>Object.assign(new Error(message),{code:'vibe_preservation',submissionState:'not_submitted'});
const account=value=>typeof value==='string'&&/^st-user:.+/.test(value)&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
export const VIBE_PRESERVATION_TABLES=Object.freeze([
  ['heads','文件目录','assets'],['documents','原文件内容','assets'],['previews','缩略图','assets'],['usage','文件计值','assets',true],
  ['receipts','当前编码记录','encodings'],['archive','历史编码记录','encodings'],['archiveUsage','历史记录计值','encodings',true],
  ['reviewSegments','较早核查明细','encodings'],['reviewUsage','核查明细计值','encodings',true],
].map(([id,label,database,single=false])=>Object.freeze({id,label,database,single})));
const descriptor=id=>{const value=VIBE_PRESERVATION_TABLES.find(row=>row.id===id);if(!value)throw fail('保全分区无效');return value;};
const prefix=namespace=>JSON.stringify([namespace]).slice(0,-1)+',';
function owns(namespace,table,key){
  if(typeof key!=='string'||key.length>2048)return false;if(table.single)return key===namespace;
  try{const parts=JSON.parse(key);return Array.isArray(parts)&&parts.length===(table.id==='reviewSegments'?3:2)&&parts[0]===namespace&&parts.slice(1).every(value=>typeof value==='string')&&JSON.stringify(parts)===key;}catch(_){return false;}
}
const encoder=new TextEncoder(),SOURCE_LIMIT=64*1024*1024,FILE_LIMIT=96*1024*1024;
const digest=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
// Tagged values retain undefined, special numbers and binary data without silently losing fields.
// Unsupported/cyclic corrupt values are rejected intact; this is not a generic IDB restore format.
export async function exportVibePreservation(namespace,section,key,value,{now=Date.now}={}){
  const table=descriptor(section);if(!account(namespace)||!owns(namespace,table,key))throw fail('无法确认此项属于当前账户');
  if(value&&typeof value==='object'&&Object.hasOwn(value,'namespace')&&value.namespace!==namespace)throw fail('原条目的账户字段冲突，禁止跨账户导出');
  let bytes=0,nodes=0;const path=new Set(),charge=n=>{bytes+=n;if(bytes>SOURCE_LIMIT)throw fail('此项超过 64 MiB 保全上限，原内容未改动');};
  async function pack(item,depth=0){
    if(++nodes>50000||depth>32)throw fail('此项结构过大，原内容未改动');
    if(item===null)return ['null'];
    if(item===undefined)return ['undefined'];
    if(typeof item==='string'){charge(encoder.encode(item).byteLength);return ['string',item];}
    if(typeof item==='number')return ['number',Number.isNaN(item)?'NaN':item===Infinity?'Infinity':item===-Infinity?'-Infinity':Object.is(item,-0)?'-0':item];
    if(typeof item==='boolean')return ['boolean',item];
    if(typeof item==='bigint'){const text=String(item);charge(text.length);return ['bigint',text];}
    if(typeof item!=='object'||path.has(item))throw fail('此项含不支持或循环的数据类型，原内容未改动');
    if(item instanceof Date)return ['date',Number.isNaN(item.getTime())?null:item.toISOString()];
    if(item instanceof Blob||item instanceof ArrayBuffer||ArrayBuffer.isView(item)){
      const length=item instanceof Blob?item.size:item.byteLength;charge(Math.ceil(length*4/3));
      const raw=item instanceof Blob?new Uint8Array(await item.arrayBuffer()):item instanceof ArrayBuffer?new Uint8Array(item):new Uint8Array(item.buffer,item.byteOffset,item.byteLength);
      const parts=[];for(let i=0;i<raw.length;i+=0x6000)parts.push(btoa(String.fromCharCode(...raw.subarray(i,i+0x6000))));
      const data=parts.join('');return item instanceof Blob?['blob',{type:item.type,...(typeof File!=='undefined'&&item instanceof File?{name:item.name,lastModified:item.lastModified}:{})},data]:['binary',item.constructor.name,data];
    }
    if(!Array.isArray(item)&&Object.getPrototypeOf(item)!==Object.prototype&&Object.getPrototypeOf(item)!==null)throw fail('此项含不支持的数据类型，原内容未改动');
    path.add(item);const entries=[];for(const name of Object.keys(item)){charge(encoder.encode(name).byteLength);entries.push([name,await pack(item[name],depth+1)]);}path.delete(item);
    return Array.isArray(item)?['array',item.length,entries]:['object',entries];
  }
  const payload={identifier:'qianmu-vibe-preservation',version:1,purpose:'preserve-only',namespace,section,key,exportedAt:now(),value:await pack(value)};
  const text=JSON.stringify(payload);if(encoder.encode(text).byteLength>FILE_LIMIT)throw fail('保全文件超过 96 MiB，原内容未改动');
  return new Blob([JSON.stringify({...payload,fingerprint:await digest(text)})],{type:'application/json'});
}

// Independent read-only path: do not create/upgrade a database or use damaged secondary indexes.
export function createVibePreservationStore({indexedDB=globalThis.indexedDB,keyRange=globalThis.IDBKeyRange,dbNames={assets:'qianmu-vibe-assets',encodings:'qianmu-vibe-encodings'},timeoutMs=8000}={}){
  const timeout=Math.max(100,Math.min(15000,Number(timeoutMs)||8000));
  async function read(namespace,section,work){
    if(!account(namespace))throw fail('无法确认当前 ST 账户');const table=descriptor(section);
    return new Promise((resolve,reject)=>{
      let request,db,tx,done=false,missing=false,result;
      const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);db?.close();error?reject(error):resolve(value);};
      const stop=error=>{try{tx?.abort();}catch(_){}finish(error);};
      const timer=setTimeout(()=>stop(fail('原始数据读取超时，未修改任何内容')),timeout);
      try{request=indexedDB.open(dbNames[table.database]);}catch(_){finish(fail('浏览器原始储存不可用'));return;}
      request.onupgradeneeded=()=>{missing=true;request.transaction.abort();};
      request.onerror=()=>finish(missing?null:fail('无法打开原始储存；没有删库或升级'),missing?{missing:true}:undefined);
      request.onblocked=()=>finish(fail('原始储存被旧页面占用，请关闭旧页面后再试'));
      request.onsuccess=()=>{
        db=request.result;if(done){db.close();return;}db.onversionchange=()=>stop(fail('储存版本正在变化，请重新读取'));
        if(!db.objectStoreNames.contains(table.id)){finish(null,{missing:true,version:db.version});return;}
        try{
          tx=db.transaction(table.id,'readonly');tx.onabort=()=>finish(fail('原始数据读取中断，原内容未改动'));tx.onerror=()=>finish(fail('原始数据读取失败，原内容未改动'));
          tx.oncomplete=()=>finish(null,{...result,version:db.version});
          work(tx.objectStore(table.id),table,value=>{result=value;},stop);
        }catch(_){stop(fail('原始分区不可读取，未修改任何内容'));}
      };
    });
  }
  return Object.freeze({
    async page(namespace,section,{after=''}={}){
      const table=descriptor(section),start=prefix(namespace);
      if(typeof after!=='string'||after.length>2048||after&&(table.single||!after.startsWith(start)))throw fail('保全分页位置不属于当前账户');
      const result=await read(namespace,section,(store,table,set,stop)=>{
        const range=table.single?keyRange.only(namespace):keyRange.bound(after||start,start+'\uffff',Boolean(after),false),rows=[];
        const request=store.openKeyCursor(range);request.onsuccess=()=>{
          const cursor=request.result;if(!cursor){set({rows,next:''});return;}
          if(rows.length===40){set({rows,next:rows.at(-1).key});return;}
          if(typeof cursor.primaryKey!=='string'||cursor.primaryKey.length>2048){stop(fail('发现无法分页的损坏编号，原内容保留'));return;}
          rows.push({key:cursor.primaryKey,readable:owns(namespace,table,cursor.primaryKey)});cursor.continue();
        };
      });return {section,namespace,rows:[],next:'',...result};
    },
    async export(namespace,section,key){
      const table=descriptor(section);if(!account(namespace)||!owns(namespace,table,key))throw fail('无法确认此项属于当前账户');
      const result=await read(namespace,section,(store,_table,set)=>{const request=store.openCursor(keyRange.only(key));request.onsuccess=()=>set(request.result?{value:request.result.value}:{missing:true});});
      if(result.missing)throw fail('原条目已不存在，未生成空白保全文件');return exportVibePreservation(namespace,section,key,result.value);
    },
  });
}
