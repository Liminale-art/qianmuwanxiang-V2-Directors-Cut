import {normalizeCharacterArchive,characterBindingTarget,characterArchiveError} from './qianmu-character-archive.js';
const fail = (code,message) => { throw characterArchiveError(code,message); };
const identifier = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(id);
const account = namespace => { if (typeof namespace !== 'string' || !/^st-user:.+/.test(namespace) || namespace.length > 512 || /[\u0000-\u001f\u007f]/.test(namespace)) fail('account','无法确认当前 ST 账户'); return namespace; };
const keyFor = (namespace,id) => { account(namespace); if (!identifier(id)) fail('id','角色档案编号无效'); return JSON.stringify([namespace,id]); };
const bindingKey = (namespace,target) => JSON.stringify([account(namespace),target.category,target.subjectKey,target.scope,target.chatKey]);
const byteSize = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;

// Lazy, account-isolated indexed metadata + per-document reads. No settings, media or legacy-store migration.
export function createCharacterArchiveStore({indexedDB=globalThis.indexedDB,keyRange=globalThis.IDBKeyRange,dbName='qianmu-character-archive',timeoutMs=6000,now=Date.now}={}) {
  const names=['heads','documents','bindings','usage']; let db=null,opening=null,closed=false; const pending=new Set();
  const timeout=Math.max(100,Math.min(15000,Number(timeoutMs)||6000));
  const error=()=>characterArchiveError('storage','角色库暂不可用，请检查浏览器储存空间');
  function open() {
    if(closed)return Promise.reject(characterArchiveError('closed','角色库会话已结束'));
    if(db)return Promise.resolve(db);if(opening)return opening;
    opening=new Promise((resolve,reject)=>{
      let request,done=false;
      const finish=(cause,value)=>{if(done){value?.close();return;}done=true;clearTimeout(timer);cause?reject(cause):resolve(value);};
      const timer=setTimeout(()=>finish(characterArchiveError('timeout','角色库读取超时，请关闭旧页面后重试')),timeout);
      try{request=indexedDB.open(dbName,1);}catch(_){finish(error());return;}
      request.onupgradeneeded=()=>{if(done||closed){request.transaction?.abort();return;}
        for(const name of names){const store=request.result.createObjectStore(name,{keyPath:'key'});if(name==='heads'||name==='bindings')store.createIndex('namespace','namespace');}
      };
      request.onblocked=()=>finish(characterArchiveError('blocked','角色库正在升级，请关闭旧页面后重试'));
      request.onerror=()=>finish(error());
      request.onsuccess=()=>{const value=request.result;if(done||closed){value.close();finish(characterArchiveError('closed','角色库会话已结束'));return;}
        db=value;value.onversionchange=()=>{value.close();db=null;opening=null;};value.onclose=()=>{db=null;opening=null;};finish(null,value);};
    });const current=opening;void current.catch(()=>{if(opening===current)opening=null;});return current;
  }
  async function operation(mode,work,isCurrent=()=>true) {
    const current=()=>{if(isCurrent()!==true)fail('changed','角色库备份页面已变化');};
    current();const database=await open();current();if(closed)fail('closed','角色库会话已结束');
    return new Promise((resolve,reject)=>{
      let tx,result,failure,done=false;
      const finish=cause=>{if(done)return;done=true;clearTimeout(timer);pending.delete(tx);cause?reject(cause):resolve(result);};
      const abort=cause=>{failure=typeof cause?.code==='string'&&cause.code.startsWith('character_archive_')?cause:error();try{tx.abort();}catch(_){finish(failure);}};
      const timer=setTimeout(()=>{failure=characterArchiveError('timeout','保存结果未确认，请刷新核对后再操作');try{tx?.abort();}catch(_){}finish(failure);},timeout);
      try{tx=database.transaction(names,mode);pending.add(tx);}catch(_){finish(error());return;}
      tx.oncomplete=()=>{try{current();finish(closed?characterArchiveError('closed','角色库会话已结束'):null);}catch(cause){finish(cause);}};tx.onabort=()=>finish(failure||error());tx.onerror=()=>{failure||=error();};
      const read=(request,receive)=>{request.onsuccess=()=>{try{current();receive(request.result);}catch(cause){abort(cause);}};};
      try{work(tx,read,value=>{result=value;});}catch(cause){abort(cause);}
    });
  }
  const freshId=()=>{if(!globalThis.crypto?.randomUUID)fail('id','请使用 HTTPS 或本机地址建立角色档案');return globalThis.crypto.randomUUID();};
  const validateHead=(row,namespace)=>{
    if(row.namespace!==namespace||row.key!==keyFor(namespace,row.id)||!identifier(row.revision)||!Number.isSafeInteger(row.version)||row.version<1
      ||!Number.isSafeInteger(row.bytes)||row.bytes<1||!['char','user','other'].includes(row.category)
      ||typeof row.name!=='string'||!row.name||row.name.length>80||typeof row.cover!=='string'||row.cover.length>2048
      ||!Array.isArray(row.aliases)||row.aliases.length>24||row.aliases.some(value=>typeof value!=='string'||value.length>80))fail('index','角色库索引异常，不会覆盖原数据');return row;
  };
  const withUsage=(tx,read,namespace,next)=>read(tx.objectStore('usage').get(namespace),value=>{
    if(value){if(!Number.isSafeInteger(value.count)||value.count<0||value.count>512||!Number.isSafeInteger(value.bytes)||value.bytes<0||value.bytes>16*1024*1024||!Number.isSafeInteger(value.bindings)||value.bindings<0||value.bindings>2048)fail('index','角色库计值异常');next({...value});return;}
    read(tx.objectStore('heads').index('namespace').count(keyRange.only(namespace)),count=>{
      read(tx.objectStore('bindings').index('namespace').count(keyRange.only(namespace)),bindings=>{
        if(count||bindings)fail('index','角色库计值缺失，请先保全数据');next({key:namespace,count:0,bytes:0,bindings:0});
      });
    });
  });
  async function snapshot(namespace,isCurrent) {
    account(namespace);return operation('readonly',(tx,read,set)=>{
      read(tx.objectStore('heads').index('namespace').getAll(keyRange.only(namespace),513),heads=>{
        if(heads.length>512)fail('capacity','角色库超过备份数量上限');
        read(tx.objectStore('bindings').index('namespace').getAll(keyRange.only(namespace),2049),bindings=>{
          if(bindings.length>2048)fail('capacity','角色绑定超过备份数量上限');
          for(const row of bindings)if(row.namespace!==namespace||row.key!==bindingKey(namespace,characterBindingTarget(row)))fail('backup','角色绑定归属不符');
          withUsage(tx,read,namespace,usage=>{
            const records={archives:[],bindings,usage};let pendingDocuments=heads.length;
            const complete=()=>{
              const prefix=JSON.stringify([namespace]).slice(0,-1)+',',range=keyRange.bound(prefix,prefix+'\uffff');let checked=0;
              for(const name of ['heads','documents','bindings'])read(tx.objectStore(name).getAllKeys(range,name==='bindings'?2049:513),keys=>{
                const expected=(name==='bindings'?bindings:heads).map(row=>row.key).sort();
                if(JSON.stringify(keys.sort())!==JSON.stringify(expected))fail('backup','角色库存在未关联或缺失的原件，请先保全核对');
                if(++checked===3)set(records);
              });
            };
            if(!pendingDocuments){complete();return;}
            for(const head of heads){validateHead(head,namespace);read(tx.objectStore('documents').get(head.key),row=>{
              if(!row||row.key!==head.key||row.namespace!==namespace||row.revision!==head.revision||Object.keys(row).some(key=>!['key','namespace','revision','document'].includes(key)))fail('backup','角色档案原文缺失或归属不符');
              records.archives.push({head,document:row.document});if(!--pendingDocuments)complete();
            });}
          });
        });
      });
    },isCurrent);
  }
  return Object.freeze({
    async backup(namespace,{isCurrent=()=>true}={}) {
      const codec=await import('./qianmu-character-library-backup.js'),records=await snapshot(namespace,isCurrent),value=codec.packCharacterLibraryRecords(namespace,records);
      if(isCurrent()!==true)fail('changed','角色库备份页面已变化');return value;
    },
    // Storage primitive only. The restore coordinator must settle image/workflow dependencies before this commit.
    async restoreBackup(namespace,input,{expectedDigest,decisions={},confirmed=false,isCurrent=()=>true}={}) {
      if(confirmed!==true||typeof expectedDigest!=='string'||!/^[a-f0-9]{64}$/.test(expectedDigest))fail('backup','请先核对并确认角色库恢复');
      const incoming=structuredClone(input),choices=structuredClone(decisions),codec=await import('./qianmu-character-library-backup.js');codec.validateCharacterLibraryBackup(incoming);
      if(incoming.namespace!==account(namespace))fail('backup','角色库备份属于另一 ST 账户，请重新绑定');
      const records=await snapshot(namespace,isCurrent),local=codec.packCharacterLibraryRecords(namespace,records);
      if(await codec.characterLibraryBackupDigest(local)!==expectedDigest)fail('conflict','角色库在确认后已变化，请重新核对');
      const plan=codec.planCharacterLibraryRestore(local,incoming,{decisions:choices});if(!plan.ready)fail('backup','请逐项选择角色或绑定冲突的处理方式');
      return operation('readwrite',(tx,read,set)=>{
        read(tx.objectStore('heads').index('namespace').getAll(keyRange.only(namespace),513),heads=>read(tx.objectStore('bindings').index('namespace').getAll(keyRange.only(namespace),2049),bindings=>{
          const sorted=rows=>rows.slice().sort((a,b)=>a.key.localeCompare(b.key));
          if(JSON.stringify(sorted(heads))!==JSON.stringify(sorted(records.archives.map(row=>row.head)))||JSON.stringify(sorted(bindings))!==JSON.stringify(sorted(records.bindings)))fail('conflict','角色库在准备期间已变化，未覆盖');
          withUsage(tx,read,namespace,usage=>{
            if(JSON.stringify(usage)!==JSON.stringify(records.usage))fail('conflict','角色库计值已变化，未覆盖');
            for(const row of plan.archiveWrites){const key=keyFor(namespace,row.head.id);tx.objectStore('heads').put({...structuredClone(row.head),key,namespace});tx.objectStore('documents').put({key,namespace,revision:row.head.revision,document:structuredClone(row.document)});}
            for(const row of plan.bindingWrites)tx.objectStore('bindings').put({...structuredClone(row),key:bindingKey(namespace,row),namespace});
            tx.objectStore('usage').put({key:namespace,...plan.value.usage});set(plan.summary);
          });
        }));
      },isCurrent);
    },
    async list(namespace){account(namespace);return operation('readonly',(tx,read,set)=>{
      read(tx.objectStore('heads').index('namespace').getAll(keyRange.only(namespace),513),rows=>{
        if(rows.length>512)fail('capacity','角色档案超过 512 项');set(rows.map(row=>validateHead(row,namespace)).sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id)));
      });
    });},
    async load(namespace,id){const key=keyFor(namespace,id);return operation('readonly',(tx,read,set)=>{
      read(tx.objectStore('heads').get(key),head=>{if(!head){set(null);return;}validateHead(head,namespace);
        read(tx.objectStore('documents').get(key),row=>{if(!row||row.revision!==head.revision||row.namespace!==namespace)fail('index','角色档案版本不一致');set({head,document:normalizeCharacterArchive(row.document)});});
      });
    });},
    async save(namespace,{id='',expectedRevision='',document}){
      account(namespace);if(id)keyFor(namespace,id);if(expectedRevision&&!identifier(expectedRevision))fail('revision','档案版本无效');
      const value=normalizeCharacterArchive(document),bytes=byteSize(value),archiveId=id||freshId(),key=keyFor(namespace,archiveId),revision=freshId();
      return operation('readwrite',(tx,read,set)=>read(tx.objectStore('heads').get(key),previous=>{
        if(id&&!previous||previous&&previous.revision!==expectedRevision||!id&&expectedRevision)fail('conflict','档案已被另一页修改，请重新载入或另存副本');
        if(previous){validateHead(previous,namespace);if(previous.category!==value.category)fail('category','已有档案不能直接更改分类，请复制为新档案');}
        withUsage(tx,read,namespace,usage=>{
          const count=usage.count+(previous?0:1),total=usage.bytes-(previous?.bytes||0)+bytes;
          if(count<1||total<bytes||(previous&&previous.version>=Number.MAX_SAFE_INTEGER))fail('index','角色库计值或版本异常，不会覆盖原数据');
          if(count>512||total>16*1024*1024)fail('capacity','角色库达到 512 项或 16 MB 上限，请先导出整理');
          const at=now(),head={key,namespace,id:archiveId,revision,version:(previous?.version||0)+1,category:value.category,name:value.name,aliases:value.aliases,
            cover:value.imagegen.preview?.url||'',bytes,createdAt:previous?.createdAt||at,updatedAt:at};
          tx.objectStore('heads').put(head);tx.objectStore('documents').put({key,namespace,revision,document:value});tx.objectStore('usage').put({...usage,count,bytes:total});set(head);
        });
      }));
    },
    async bindings(namespace){account(namespace);return operation('readonly',(tx,read,set)=>read(tx.objectStore('bindings').index('namespace').getAll(keyRange.only(namespace),2049),rows=>{
      if(rows.length>2048)fail('capacity','角色绑定超过上限');for(const row of rows)if(row.namespace!==namespace||row.key!==bindingKey(namespace,characterBindingTarget(row))||!identifier(row.revision)||(row.archiveId!==''&&!identifier(row.archiveId)))fail('index','角色绑定索引异常');set(rows);
    }));},
    async bind(namespace,{target,archiveId='',expectedRevision='',inherit=false}){
      target=characterBindingTarget(target);const key=bindingKey(namespace,target);if(archiveId)keyFor(namespace,archiveId);const revision=freshId();
      return operation('readwrite',(tx,read,set)=>read(tx.objectStore('bindings').get(key),previous=>{
        if((previous?.revision||'')!==expectedRevision)fail('conflict','绑定已被另一页修改，请刷新后重试');
        const write=()=>withUsage(tx,read,namespace,usage=>{
          if(previous&&usage.bindings<1)fail('index','角色绑定计值异常，不会覆盖原数据');
          if(inherit){if(previous){tx.objectStore('bindings').delete(key);tx.objectStore('usage').put({...usage,bindings:usage.bindings-1});}set(null);return;}
          if(!previous&&usage.bindings>=2048)fail('capacity','角色绑定达到上限，请先解除不再使用的绑定');
          const row={key,namespace,...target,archiveId,revision,updatedAt:now()};tx.objectStore('bindings').put(row);tx.objectStore('usage').put({...usage,bindings:usage.bindings+(previous?0:1)});set(row);
        });
        if(archiveId&&!inherit)read(tx.objectStore('heads').get(keyFor(namespace,archiveId)),head=>{if(!head||head.category!==target.category)fail('binding','档案不存在或分类不匹配');write();});else write();
      }));
    },
    async remove(namespace,id,expectedRevision){const key=keyFor(namespace,id);return operation('readwrite',(tx,read,set)=>read(tx.objectStore('heads').get(key),head=>{
      if(!head||head.revision!==expectedRevision)fail('conflict','档案已变化，请刷新后删除');validateHead(head,namespace);
      read(tx.objectStore('bindings').index('namespace').getAll(keyRange.only(namespace),2049),bindings=>{
        if(bindings.length>2048)fail('capacity','绑定数量异常');if(bindings.some(row=>row.archiveId===id))fail('bound','此档案仍有绑定，请在详情中解除后删除');
        withUsage(tx,read,namespace,usage=>{if(usage.count<1||usage.bytes<head.bytes)fail('index','角色库计值异常，不会删除原数据');tx.objectStore('heads').delete(key);tx.objectStore('documents').delete(key);tx.objectStore('usage').put({...usage,count:usage.count-1,bytes:usage.bytes-head.bytes});set({removed:true});});
      });
    }));},
    async usage(namespace){account(namespace);return operation('readonly',(tx,read,set)=>withUsage(tx,read,namespace,value=>set({...value,limit:16*1024*1024})));},
    close(){closed=true;for(const tx of pending)try{tx.abort();}catch(_){}db?.close();db=null;opening=null;},
  });
}
