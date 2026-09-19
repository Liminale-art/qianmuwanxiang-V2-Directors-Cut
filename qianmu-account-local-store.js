// Shared lazy IndexedDB account-document transactions. Callers own schema, namespace and database.
export function createAccountLocalStore({indexedDB=globalThis.indexedDB,dbName,timeoutMs=8000,validateNamespace,validate,empty,error,label}={}) {
  if(typeof dbName!=='string'||!dbName||typeof label!=='string'||!label||![validateNamespace,validate,empty,error].every(fn=>typeof fn==='function'))throw new TypeError('Account local store configuration is invalid');
  const fail=(code,message)=>error(code,message.replaceAll('账户资料',label));
  let database=null,opening=null,closed=false;const pending=new Set(),timeout=Math.max(100,Math.min(30000,Number(timeoutMs)||8000));
  const check=guard=>{if(closed)throw fail('closed','账户资料会话已关闭');if(guard()===false)throw fail('account','账户资料账户已变化');};
  function open(){
    if(closed)return Promise.reject(fail('closed','账户资料会话已关闭'));
    if(database)return Promise.resolve(database);if(opening)return opening;
    const attempt=new Promise((resolve,reject)=>{
      let request,done=false;const finish=(error,db)=>{if(done){db?.close();return;}done=true;clearTimeout(timer);error?reject(error):resolve(db);};
      const timer=setTimeout(()=>finish(fail('timeout','本机账户资料打开超时')),timeout);
      try{request=indexedDB.open(dbName,1);}catch(_){finish(fail('storage','本机账户资料储存不可用，未降级为易丢失的临时保存'));return;}
      request.onupgradeneeded=()=>{if(done||closed){request.transaction?.abort();return;}request.result.createObjectStore('accounts',{keyPath:'namespace'});};
      request.onblocked=()=>finish(fail('storage','账户资料库被旧页面占用，请关闭后重试'));
      request.onerror=()=>finish(fail('storage','本机账户资料打开失败'));
      request.onsuccess=()=>{const db=request.result;if(done||closed){db.close();finish(fail('closed','账户资料会话已关闭'));return;}
        database=db;db.onversionchange=()=>{db.close();if(database===db){database=null;opening=null;}};db.onclose=()=>{if(database===db){database=null;opening=null;}};finish(null,db);};
    });opening=attempt;void attempt.catch(()=>{if(opening===attempt)opening=null;});return attempt;
  }
  async function access(namespace,mutator,{guard=()=>true}={}){
    validateNamespace(namespace);check(guard);const db=await open();check(guard);
    return new Promise((resolve,reject)=>{
      let tx,done=false,result,failure;const finish=error=>{if(done)return;done=true;clearTimeout(timer);pending.delete(tx);error?reject(error):resolve(result);};
      const abort=error=>{failure=error;try{tx?.abort();}catch(_){finish(error);}};
      const timer=setTimeout(()=>{const error=fail('timeout','账户资料保存结果尚未确认，请保留编辑内容并重读');abort(error);finish(error);},timeout);
      try{tx=db.transaction('accounts',mutator?'readwrite':'readonly');pending.add(tx);}catch(_){finish(fail('storage','账户资料储存暂不可用'));return;}
      tx.oncomplete=()=>{try{check(guard);finish();}catch(error){finish(error);}};
      tx.onabort=()=>finish(failure||fail('storage','账户资料操作未完成，原内容保留'));
      tx.onerror=()=>{failure ||= fail('storage','本机账户资料保存失败，可能空间不足');};
      const store=tx.objectStore('accounts'),request=store.get(namespace);
      request.onsuccess=()=>{try{check(guard);const state=validate(request.result||empty(namespace),namespace);
        if(mutator){const returned=mutator(state);if(returned?.then)throw fail('storage','账户资料事务不能等待网络');validate(state,namespace);check(guard);store.put(state);}
        result=structuredClone(state);
      }catch(error){abort(error);}};
    });
  }
  // Bounded read-only range walk. Namespace partitioning belongs to the caller;
  // each actual key/document still passes the same schema checks as direct reads.
  async function scan({range,limit,visit}={}, {guard=()=>true}={}){
    if(!range||typeof range.lower!=='string'||typeof range.upper!=='string'||range.lower>=range.upper||!Number.isInteger(limit)||limit<1||limit>10000||typeof visit!=='function')throw fail('storage','账户资料盘点范围无效');
    check(guard);const db=await open();check(guard);
    return new Promise((resolve,reject)=>{
      let tx,done=false,count=0,failure;const finish=error=>{if(done)return;done=true;clearTimeout(timer);pending.delete(tx);error?reject(error):resolve(count);};
      const abort=error=>{failure=error;try{tx?.abort();}catch(_){finish(error);}};
      const timer=setTimeout(()=>{const error=fail('timeout','账户资料盘点超时，未返回部分统计');abort(error);finish(error);},timeout);
      try{
        tx=db.transaction('accounts','readonly');pending.add(tx);
        tx.oncomplete=()=>{try{check(guard);finish();}catch(error){finish(error);}};tx.onabort=()=>finish(failure||fail('storage','账户资料盘点未完成'));
        tx.onerror=()=>{failure ||= fail('storage','账户资料盘点失败');};
        const request=tx.objectStore('accounts').openCursor(range);
        request.onsuccess=()=>{try{
          check(guard);const cursor=request.result;if(!cursor)return;if(++count>limit)throw fail('capacity','账户资料超过单次盘点上限，未返回部分统计');
          const key=cursor.primaryKey;validateNamespace(key);const result=visit(validate(cursor.value,key),key);
          if(result?.then)throw fail('storage','账户资料盘点不能等待网络');check(guard);cursor.continue();
        }catch(error){abort(error);}};
      }catch(_){const error=fail('storage','账户资料盘点暂不可用');if(tx)abort(error);else finish(error);}
    });
  }
  return Object.freeze({read:(namespace,options)=>access(namespace,null,options),scan,update:(namespace,mutator,options)=>{
    if(typeof mutator!=='function')return Promise.reject(fail('storage','缺少账户资料事务'));return access(namespace,mutator,options);
  },close(){closed=true;for(const tx of pending)try{tx.abort();}catch(_){}database?.close();database=null;opening=null;}});
}
