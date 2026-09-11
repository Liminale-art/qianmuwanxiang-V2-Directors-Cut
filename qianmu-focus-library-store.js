// Lazy, separate IndexedDB namespace. Never upgrades the shared reader/TTS database.
import {FOCUS_LIBRARY_LIMITS,focusLibraryNamespace,focusLibraryScope,focusLibraryClipKey,normalizeFocusLibraryClip,focusLibraryError} from './qianmu-focus-library.js';

export function createFocusLibraryStore({indexedDB=globalThis.indexedDB,keyRange=globalThis.IDBKeyRange,dbName='qianmu-focus-library',now=Date.now,timeoutMs=8000,limits=FOCUS_LIBRARY_LIMITS}={}) {
  const quota={...FOCUS_LIBRARY_LIMITS,...limits};
  for(const key of Object.keys(FOCUS_LIBRARY_LIMITS))if(!Number.isSafeInteger(quota[key])||quota[key]<1||quota[key]>FOCUS_LIBRARY_LIMITS[key])throw focusLibraryError('limit','语音库限额无效');
  const problem=()=>focusLibraryError('storage','语音库暂不可用，请检查储存空间');
  const ended=()=>focusLibraryError('stale','操作页面或角色已变化');
  const timeout=Math.max(100,Math.min(15000,Number(timeoutMs)||8000));
  let database=null,opening=null,cancelOpening=null,closed=false;
  const active=new Map();
  function open() {
    if(closed)return Promise.reject(ended());if(database)return Promise.resolve(database);if(opening)return opening;
    opening=new Promise((resolve,reject)=>{
      let request,done=false;
      const finish=(error,db)=>{if(done){db?.close();return;}done=true;clearTimeout(timer);cancelOpening=null;error?reject(error):resolve(db);};
      const timer=setTimeout(()=>finish(focusLibraryError('timeout','语音库读取超时')),timeout);
      cancelOpening=()=>finish(ended());
      try{request=indexedDB.open(dbName,1);}catch(_){finish(problem());return;}
      request.onupgradeneeded=()=>{
        if(done||closed){request.transaction.abort();return;}
        const db=request.result;
        const heads=db.createObjectStore('clips');heads.createIndex('namespace','namespace');
        db.createObjectStore('audio');db.createObjectStore('usage');
      };
      request.onerror=()=>finish(problem());request.onblocked=()=>finish(focusLibraryError('blocked','语音库被其他页面占用'));
      request.onsuccess=()=>{
        const db=request.result;if(done||closed){db.close();finish(ended());return;}
        database=db;const release=()=>{if(database===db){database=null;opening=null;}};
        db.onversionchange=()=>{db.close();release();};db.onclose=release;finish(null,db);
      };
    });const attempt=opening;void attempt.catch(()=>{if(opening===attempt)opening=null;});return attempt;
  }
  async function transaction(stores,mode,work,isCurrent=()=>true) {
    if(!isCurrent())throw ended();const db=await open();if(closed||!isCurrent())throw ended();
    return new Promise((resolve,reject)=>{
      let tx,result,failure,done=false;
      const finish=error=>{if(done)return;done=true;clearTimeout(timer);active.delete(tx);error?reject(error):resolve(result);};
      const abort=error=>{failure=error;try{tx.abort();}catch(_){finish(error);}};
      const timer=setTimeout(()=>{abort(focusLibraryError('timeout','语音库操作超时，未确认保存'));},timeout);
      const guard=()=>{if(closed||!isCurrent())throw ended();};
      const on=request=>callback=>{request.onsuccess=()=>{try{guard();callback(request.result);}catch(error){abort(error);}};return request;};
      try {
        tx=db.transaction(stores,mode);active.set(tx,abort);
        tx.oncomplete=()=>finish();tx.onerror=()=>{failure||=problem();};tx.onabort=()=>finish(failure||problem());
        work(tx,value=>{result=value;},on);
      }catch(error){if(tx)abort(error);else finish(error);}
    });
  }
  const usage=value=>{
    const row=value??{count:0,bytes:0,revision:0};
    if(!Number.isSafeInteger(row.count)||row.count<0||!Number.isSafeInteger(row.bytes)||row.bytes<0
      ||!Number.isSafeInteger(row.revision)||row.revision<0||row.revision>=Number.MAX_SAFE_INTEGER)throw problem();
    return row;
  };
  const revision=value=>{if(!Number.isSafeInteger(value)||value<0||value>=Number.MAX_SAFE_INTEGER)throw focusLibraryError('revision','请重新打开语音条');return value;};
  const storedHead=(head,owner,id)=>{
    if(head===undefined)return null;
    normalizeFocusLibraryClip(head,owner);
    if(head.id!==id||!Number.isSafeInteger(head.revision)||head.revision<1||!Number.isSafeInteger(head.audioBytes)||head.audioBytes<1
      ||!Number.isSafeInteger(head.storedBytes)||head.storedBytes<head.audioBytes||!/^audio\//i.test(head.mimeType))throw problem();
    return head;
  };
  async function save(scope,input,blob,{expectedRevision=0,isCurrent=()=>true}={}) {
    // Capture the click before awaiting storage, so regeneration cannot switch its payload.
    const owner=focusLibraryScope(scope),clip=normalizeFocusLibraryClip(input,owner),key=focusLibraryClipKey(owner,clip.id),expected=revision(expectedRevision);
    if(!(blob instanceof Blob)||!blob.size||blob.size>quota.audioBytes||!/^audio\//i.test(blob.type))throw focusLibraryError('audio','请选择有效且不超过限额的音频');
    return transaction(['clips','audio','usage'],'readwrite',(tx,output,on)=>{
      const heads=tx.objectStore('clips'),assets=tx.objectStore('audio'),totals=tx.objectStore('usage');
      on(heads.get(key))(previous=>{
        previous=storedHead(previous,owner,clip.id);
        if((previous?.revision||0)!==expected){output({status:'conflict'});return;}
        on(totals.get(owner.namespace))(stored=>{
          const total=usage(stored),stamp=now();
          if(total.revision>=Number.MAX_SAFE_INTEGER-1)throw focusLibraryError('revision','语音库版本计数已到上限');
          if(previous&&(total.count<1||total.bytes<previous.storedBytes||total.revision<previous.revision))throw problem();
          // An account-wide monotonic revision survives removal; reusing an id cannot revive an old edit/play ticket.
          const head={...clip,revision:total.revision+1,createdAt:previous?.createdAt??stamp,updatedAt:stamp,audioBytes:blob.size,mimeType:blob.type};
          const bytes=blob.size+new TextEncoder().encode(JSON.stringify(head)).byteLength;
          const next={count:total.count+(previous?0:1),bytes:total.bytes-(previous?.storedBytes||0)+bytes,revision:head.revision};
          if(next.count>quota.clips||next.bytes>quota.bytes)throw focusLibraryError('quota','语音库空间不足，请先整理已有语音');
          on(heads.put({...head,storedBytes:bytes},key))(()=>{});on(assets.put(blob,key))(()=>{});on(totals.put(next,owner.namespace))(()=>{});
          output({status:'saved',clip:head});
        });
      });
    },isCurrent);
  }
  async function list(namespace,{isCurrent=()=>true}={}) {
    namespace=focusLibraryNamespace(namespace);
    return transaction(['clips'],'readonly',(tx,output,on)=>on(tx.objectStore('clips').index('namespace').getAll(keyRange.only(namespace)))(output),isCurrent);
  }
  async function readAudio(scope,id,expectedRevision,{isCurrent=()=>true}={}) {
    const owner=focusLibraryScope(scope),key=focusLibraryClipKey(owner,id),expected=revision(expectedRevision);
    return transaction(['clips','audio'],'readonly',(tx,output,on)=>on(tx.objectStore('clips').get(key))(head=>{
      head=storedHead(head,owner,id);
      if(!head){output({status:'missing'});return;}if(head.revision!==expected){output({status:'conflict'});return;}
      on(tx.objectStore('audio').get(key))(blob=>output(blob instanceof Blob&&blob.size===head.audioBytes&&blob.type===head.mimeType?{status:'ready',blob}:{status:'missing'}));
    }),isCurrent);
  }
  async function remove(scope,id,expectedRevision,{isCurrent=()=>true}={}) {
    const owner=focusLibraryScope(scope),key=focusLibraryClipKey(owner,id),expected=revision(expectedRevision);
    return transaction(['clips','audio','usage'],'readwrite',(tx,output,on)=>{
      const heads=tx.objectStore('clips'),totals=tx.objectStore('usage');
      on(heads.get(key))(head=>{
        head=storedHead(head,owner,id);
        if(!head){output({status:'missing'});return;}if(head.revision!==expected){output({status:'conflict'});return;}
        on(totals.get(owner.namespace))(stored=>{
          const total=usage(stored);if(total.count<1||total.bytes<head.storedBytes||total.revision<head.revision)throw problem();
          on(heads.delete(key))(()=>{});on(tx.objectStore('audio').delete(key))(()=>{});
          on(totals.put({count:total.count-1,bytes:total.bytes-head.storedBytes,revision:total.revision},owner.namespace))(()=>{});output({status:'removed'});
        });
      });
    },isCurrent);
  }
  async function summary(namespace) {
    namespace=focusLibraryNamespace(namespace);
    return transaction(['usage'],'readonly',(tx,output,on)=>on(tx.objectStore('usage').get(namespace))(value=>output(usage(value))));
  }
  // Import is append-only; selected deletion is all-or-nothing. Never overwrite a newer edit.
  async function batch(namespace,{add=[],remove:deletions=[]}={}, {isCurrent=()=>true}={}) {
    namespace=focusLibraryNamespace(namespace);
    if(!Array.isArray(add)||!Array.isArray(deletions)||add.length+deletions.length<1||add.length+deletions.length>quota.clips)throw problem();
    const keys=new Set(),additions=add.map(({clip,blob})=>{
      const owner=focusLibraryScope({namespace,characterKey:clip?.characterKey}),value=normalizeFocusLibraryClip({...clip,namespace},owner),key=focusLibraryClipKey(owner,value.id);
      if(!(blob instanceof Blob)||!blob.size||blob.size>quota.audioBytes||!/^audio\//i.test(blob.type))throw focusLibraryError('audio','备份音频无效');
      if(keys.has(key))throw problem();keys.add(key);return {owner,clip:value,blob,key};
    }),removals=deletions.map(row=>{
      const owner=focusLibraryScope({namespace,characterKey:row?.characterKey}),key=focusLibraryClipKey(owner,row.id),expected=revision(row.revision);
      if(keys.has(key)||!expected)throw problem();keys.add(key);return {owner,id:row.id,key,expected};
    });
    return transaction(['clips','audio','usage'],'readwrite',(tx,output,on)=>{
      const heads=tx.objectStore('clips'),audio=tx.objectStore('audio'),totals=tx.objectStore('usage');
      on(totals.get(namespace))(value=>{
        const total={...usage(value)},saved=[],old=[];let index=0;
        const checks=[...additions.map(row=>({row,adding:true})),...removals.map(row=>({row,adding:false}))];
        function next(){
          if(index<checks.length){const {row,adding}=checks[index++];on(heads.get(row.key))(head=>{
            if(adding){if(head!==undefined)throw focusLibraryError('conflict','导入编号冲突，原库未改动');}
            else{head=storedHead(head,row.owner,row.id);if(!head||head.revision!==row.expected)throw focusLibraryError('conflict','所选语音已变化，请重新选择');old.push({...row,head});}next();});return;}
          for(const row of old){if(total.count<1||total.bytes<row.head.storedBytes||total.revision<row.head.revision)throw problem();total.count--;total.bytes-=row.head.storedBytes;}
          for(const row of additions){
            if(total.revision>=Number.MAX_SAFE_INTEGER-1)throw problem();const stamp=now();
            const head={...row.clip,revision:++total.revision,createdAt:stamp,updatedAt:stamp,audioBytes:row.blob.size,mimeType:row.blob.type};
            head.storedBytes=row.blob.size+new TextEncoder().encode(JSON.stringify(head)).byteLength;
            total.count++;total.bytes+=head.storedBytes;saved.push({...row,head});
          }
          if(total.count>quota.clips||total.bytes>quota.bytes)throw focusLibraryError('quota','空间不足，整批未导入');
          for(const row of old){on(heads.delete(row.key))(()=>{});on(audio.delete(row.key))(()=>{});}
          for(const row of saved){on(heads.put(row.head,row.key))(()=>{});on(audio.put(row.blob,row.key))(()=>{});}
          on(totals.put(total,namespace))(()=>{});output({status:'committed',added:saved.map(row=>row.head),removed:old.length});
        }next();
      });
    },isCurrent);
  }
  function close(){closed=true;cancelOpening?.();for(const abort of [...active.values()])abort(ended());database?.close();database=null;}
  return Object.freeze({save,list,readAudio,remove,summary,batch,close});
}
