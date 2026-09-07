import {parseNovelVibeFile,vibeFileError} from './qianmu-vibe-file.js';

const fail=(code,message)=>{throw vibeFileError(code,message);};
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const namespace=value=>{if(typeof value!=='string'||!/^st-user:.+/.test(value)||value.length>512||/[\u0000-\u001f\u007f]/.test(value))fail('account','无法确认当前 ST 账户');return value;};
const key=(account,id)=>{namespace(account);if(!hash(id))fail('asset','Vibe 资产编号无效');return JSON.stringify([account,id]);};
export const VIBE_ASSET_LIMITS=Object.freeze({count:1024,bytes:512*1024*1024});

// Immutable imported-file assets; settings hold only IDs. Open/list never deserialize image/encoding bodies.
// No automatic eviction: a library deletion must not invalidate an existing shot's frozen source.
export function createVibeAssetStore({indexedDB=globalThis.indexedDB,keyRange=globalThis.IDBKeyRange,dbName='qianmu-vibe-assets',timeoutMs=8000,now=Date.now}={}){
  let database=null,opening=null,closed=false;const pending=new Set(),stores=['heads','documents','usage'];
  const timeout=Math.max(100,Math.min(15000,Number(timeoutMs)||8000));
  const storageError=()=>vibeFileError('storage','Vibe 储存暂不可用，请检查浏览器空间');
  const ended=()=>vibeFileError('closed','Vibe 资产会话已结束');
  function open(){
    if(closed)return Promise.reject(ended());if(database)return Promise.resolve(database);if(opening)return opening;
    opening=new Promise((resolve,reject)=>{
      let request,done=false;
      const finish=(error,value)=>{if(done){value?.close();return;}done=true;clearTimeout(timer);error?reject(error):resolve(value);};
      const timer=setTimeout(()=>finish(vibeFileError('timeout','Vibe 储存读取超时')),timeout);
      try{request=indexedDB.open(dbName,1);}catch(_){finish(storageError());return;}
      request.onupgradeneeded=()=>{if(done||closed){request.transaction?.abort();return;}for(const name of stores){const store=request.result.createObjectStore(name,{keyPath:'key'});if(name==='heads')store.createIndex('namespace','namespace');}};
      request.onerror=()=>finish(storageError());request.onblocked=()=>finish(vibeFileError('blocked','Vibe 储存正在升级，请关闭旧页面后重试'));
      request.onsuccess=()=>{const db=request.result;if(done||closed){db.close();finish(ended());return;}database=db;
        db.onversionchange=()=>{db.close();if(database===db){database=null;opening=null;}};
        db.onclose=()=>{if(database===db){database=null;opening=null;}};finish(null,db);};
    });const attempt=opening;void attempt.catch(()=>{if(opening===attempt)opening=null;});return attempt;
  }
  async function transaction(mode,work,isCurrent=()=>true){
    if(!isCurrent())fail('stale','Vibe 保存环境已变化');
    const db=await open();if(closed)throw ended();if(!isCurrent())fail('stale','Vibe 保存环境已变化');
    return new Promise((resolve,reject)=>{
      let tx,result,failure,done=false;
      const finish=error=>{if(done)return;done=true;clearTimeout(timer);pending.delete(tx);error?reject(error):resolve(result);};
      const abort=error=>{failure=typeof error?.code==='string'&&error.code.startsWith('vibe_file_')?error:storageError();try{tx.abort();}catch(_){finish(failure);}};
      const timer=setTimeout(()=>{failure=vibeFileError('timeout','Vibe 保存结果未确认，请重新读取核对');try{tx?.abort();}catch(_){}finish(failure);},timeout);
      try{tx=db.transaction(stores,mode);pending.add(tx);}catch(_){finish(storageError());return;}
      tx.oncomplete=()=>{try{finish(closed?ended():!isCurrent()?vibeFileError('stale','Vibe 资产已保存但页面已变化，请重新核对'):null);}catch(error){finish(error);}};
      tx.onabort=()=>finish(failure||storageError());tx.onerror=()=>{failure||=storageError();};
      const read=(request,next)=>{request.onsuccess=()=>{if(done)return;try{if(closed)throw ended();if(!isCurrent())fail('stale','Vibe 保存环境已变化');next(request.result);}catch(error){abort(error);}};};
      try{work(tx,read,value=>{result=value;});}catch(error){abort(error);}
    });
  }
  function checkHead(head,account){
    if(!head||head.namespace!==account||head.key!==key(account,head.assetId)||!Number.isSafeInteger(head.bytes)||head.bytes<1||head.bytes>64*1024*1024
      ||!head.summary||head.summary.assetId!==head.assetId||!Number.isFinite(head.createdAt))fail('index','Vibe 资产索引损坏，请先保全数据');
    const info=head.summary;
    if(!hash(info.sourceId)||!['image','encoding'].includes(info.type)||typeof info.name!=='string'||info.name.length>100
      ||typeof info.hasThumbnail!=='boolean'||info.hasImage!==(info.type==='image')||!Array.isArray(info.variants)||info.variants.length>256
      ||info.variants.some(row=>!row||typeof row.model!=='string'||row.model.length>160||typeof row.variant!=='string'||row.variant.length>160
        ||typeof row.customParams!=='boolean'||!(row.information===null||typeof row.information==='number'&&Number.isFinite(row.information)&&row.information>=0&&row.information<=1)))fail('index','Vibe 资产目录损坏，请先保全数据');return head;
  }
  function usage(tx,read,account,next){
    read(tx.objectStore('usage').get(account),row=>{
      if(row){if(row.key!==account||!Number.isSafeInteger(row.count)||row.count<0||row.count>VIBE_ASSET_LIMITS.count||!Number.isSafeInteger(row.bytes)||row.bytes<0||row.bytes>VIBE_ASSET_LIMITS.bytes||(row.count===0)!==(row.bytes===0))fail('index','Vibe 储存计值异常');next(row);return;}
      read(tx.objectStore('heads').index('namespace').count(keyRange.only(account)),count=>{if(count)fail('index','Vibe 储存计值缺失，请先保全数据');next({key:account,count:0,bytes:0});});
    });
  }
  return Object.freeze({
    async putFile(account,text,{isCurrent=()=>true}={}){
      namespace(account);if(closed)throw ended();if(!isCurrent())fail('stale','Vibe 导入环境已变化');
      const parsed=await parseNovelVibeFile(text);if(closed)throw ended();if(!isCurrent())fail('stale','Vibe 导入环境已变化');
      const unique=[...new Map(parsed.map(asset=>[asset.assetId,asset])).values()];
      return transaction('readwrite',(tx,read,set)=>usage(tx,read,account,totals=>{
        let at=0;const heads=new Map();
        const next=()=>{
          if(at===unique.length){tx.objectStore('usage').put(totals);set(parsed.map(asset=>heads.get(asset.assetId)));return;}
          const asset=unique[at++],assetKey=key(account,asset.assetId);
          read(tx.objectStore('heads').get(assetKey),existing=>{
            if(existing){checkHead(existing,account);if(existing.bytes!==asset.bytes)fail('index','Vibe 内容与原索引不一致');
              // Do not acknowledge a missing/corrupt body as a successful duplicate import.
              read(tx.objectStore('documents').get(assetKey),body=>{if(!body||body.namespace!==account||body.serialized!==asset.serialized)fail('index','Vibe 原资产正文损坏，请先导出保全');heads.set(asset.assetId,existing);next();});return;}
            if(totals.count+1>VIBE_ASSET_LIMITS.count||totals.bytes+asset.bytes>VIBE_ASSET_LIMITS.bytes)fail('capacity','Vibe 资产达到 1024 份或 512 MB 上限，请先导出整理');
            const head={key:assetKey,namespace:account,assetId:asset.assetId,bytes:asset.bytes,summary:asset.summary,createdAt:now()};
            tx.objectStore('heads').add(head);tx.objectStore('documents').add({key:assetKey,namespace:account,serialized:asset.serialized});
            totals={...totals,count:totals.count+1,bytes:totals.bytes+asset.bytes};heads.set(asset.assetId,head);next();
          });
        };next();
      }),isCurrent);
    },
    async list(account){namespace(account);return transaction('readonly',(tx,read,set)=>read(tx.objectStore('heads').index('namespace').getAll(keyRange.only(account),VIBE_ASSET_LIMITS.count+1),rows=>{
      if(rows.length>VIBE_ASSET_LIMITS.count)fail('capacity','Vibe 资产条目过多');set(rows.map(row=>checkHead(row,account)));
    }));},
    async load(account,id){
      const assetKey=key(account,id),row=await transaction('readonly',(tx,read,set)=>read(tx.objectStore('heads').get(assetKey),head=>{
        if(!head){set(null);return;}checkHead(head,account);
        read(tx.objectStore('documents').get(assetKey),body=>{if(!body||body.namespace!==account||typeof body.serialized!=='string')fail('index','Vibe 资产正文缺失');set({head,text:body.serialized});});
      }));
      if(!row)return null;const [asset]=await parseNovelVibeFile(row.text);if(closed)throw ended();
      if(asset.assetId!==id||asset.bytes!==row.head.bytes||asset.serialized!==row.text||JSON.stringify(asset.summary)!==JSON.stringify(row.head.summary))fail('digest','Vibe 资产内容已变化，未用于生成');return asset;
    },
    async usage(account){namespace(account);return transaction('readonly',(tx,read,set)=>usage(tx,read,account,row=>set({...row,limit:VIBE_ASSET_LIMITS.bytes})));},
    // Only an explicit storage-manager selection may call this; never a normal library-item deletion.
    async remove(account,ids,{isCurrent=()=>true}={}){
      namespace(account);if(!Array.isArray(ids)||ids.length>VIBE_ASSET_LIMITS.count||new Set(ids).size!==ids.length)fail('asset','Vibe 清理选择无效');
      const keys=ids.map(id=>key(account,id));
      return transaction('readwrite',(tx,read,set)=>usage(tx,read,account,totals=>{
        let at=0,removed=0,bytes=0;
        const next=()=>{if(at===keys.length){tx.objectStore('usage').put(totals);set({removed,bytes});return;}
          const assetKey=keys[at++];read(tx.objectStore('heads').get(assetKey),head=>{
            if(!head){next();return;}checkHead(head,account);if(totals.count<1||totals.bytes<head.bytes)fail('index','Vibe 计值异常，未删除');
            totals={...totals,count:totals.count-1,bytes:totals.bytes-head.bytes};if((totals.count===0)!==(totals.bytes===0))fail('index','Vibe 计值不一致，未删除');
            tx.objectStore('heads').delete(assetKey);tx.objectStore('documents').delete(assetKey);removed++;bytes+=head.bytes;next();
          });
        };next();
      }),isCurrent);
    },
    close(){closed=true;for(const tx of pending)try{tx.abort();}catch(_){}database?.close();database=null;opening=null;},
  });
}
