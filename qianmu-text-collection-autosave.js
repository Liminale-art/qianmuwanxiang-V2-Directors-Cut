import {createTextCollectionSession} from './qianmu-text-collection-session.js';
import {createTextCollectionOutboxRuntime} from './qianmu-text-collection-outbox-runtime.js';

// Only explicit saves already committed to the local recovery queue are resumed.
// Never queue deletions, select new prose, rebase edits, or call a model here.
export function createCollectionAutosave({resolveNamespace,isCurrent,headers,window=globalThis.window,document=globalThis.document,onError=()=>{},notify=()=>{},sessionFactory=createTextCollectionSession,outboxFactory=createTextCollectionOutboxRuntime}={}) {
  let closed=false,started=false,running=null,timer=null,session=null,outbox=null,failures=0,queuedDuringRun=false;
  const current=()=>!closed&&isCurrent()===true;
  const schedule=delay=>{window.clearTimeout(timer);if(!closed)timer=window.setTimeout(()=>{timer=null;void wake();},delay);};
  function wake(){
    if(!current()||document.hidden||window.navigator?.onLine===false||running)return running;
    window.clearTimeout(timer);timer=null;queuedDuringRun=false;
    running=(async()=>{
      let failed=false,remaining=false,accountLost=false,confirmed=false;
      const report=cause=>{failed=true;try{onError(cause);}catch{}};
      const invalidAccount=cause=>/^(?:text_collection_sync|st_account_storage)_(?:account|scope|cancelled)$/.test(cause?.code||'');
      try{
        session=await sessionFactory({resolveNamespace,isCurrent:current,headers});if(!current())return;
        outbox=outboxFactory({session,isCurrent:current});
        const rows=await outbox.list();
        for(const row of rows.slice(0,24)){
          if(!current()||window.navigator?.onLine===false)break;
          try{
            const result=row.state==='conflict'?await outbox.keepCopy(row,{confirmed:true}):await outbox.submit(row.request.mutationId);
            // The real runtime confirms or throws; retained/nonfinal states must
            // also receive a later wake, never be mistaken for an emptied queue.
            if(result?.status!=='confirmed')throw Object.assign(new Error('收藏保存尚未确认'),{code:'text_collection_sync_unconfirmed'});
            confirmed=true;
            if(row.state==='conflict'&&current())try{notify('收藏存在两处修改，已另存副本。','info');}catch{}
          }catch(cause){
            report(cause);if(invalidAccount(cause)||!current()){accountLost=true;break;}
            // A rejected item must not prevent independent queued saves from
            // being attempted. Never rebase its revision or change its identity.
          }
        }
        remaining=rows.length>24;
      }catch(cause){if(current()){report(cause);accountLost=invalidAccount(cause);}}
      finally{
        outbox?.close();outbox=null;session?.close();session=null;running=null;
        if(confirmed&&current()&&!accountLost)try{document.dispatchEvent(new (window.Event||globalThis.Event)('qianmu-text-collections-changed'));}catch{}
        if(!current()||accountLost){window.clearTimeout(timer);timer=null;queuedDuringRun=false;}
        else{
          if(queuedDuringRun){failures=0;schedule(3000);}
          else if(failed){if(++failures<3)schedule(30000);}
          else{failures=0;if(remaining)schedule(1000);}
        }
      }
    })();return running;
  }
  const queued=()=>{failures=0;if(running)queuedDuringRun=true;schedule(3000);};
  const resumed=()=>{failures=0;void wake();};
  return Object.freeze({wake,start(){if(closed||started)return;started=true;window.addEventListener('qianmu-collection-save-queued',queued);window.addEventListener('online',resumed);window.addEventListener('focus',resumed);document.addEventListener('visibilitychange',resumed);void wake();},
    close(){closed=true;window.clearTimeout(timer);window.removeEventListener('qianmu-collection-save-queued',queued);window.removeEventListener('online',resumed);window.removeEventListener('focus',resumed);document.removeEventListener('visibilitychange',resumed);outbox?.close();session?.close();}});
}
