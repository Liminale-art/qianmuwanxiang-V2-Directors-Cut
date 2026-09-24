import {createConfiguredStAccountStorage,getStAccountStorageReadScope} from './qianmu-st-account-storage.js';
import {createCollectionMigration} from './qianmu-text-collection-migration.js';
import {TEXT_COLLECTION_SYNC_LIMITS} from './qianmu-text-collection-sync-contract.js';
import {scheduleCollectionMigrationSteps} from './qianmu-idle-migration-scheduler.js';
export {scheduleCollectionMigrationSteps} from './qianmu-idle-migration-scheduler.js';

// Panel-independent, one job per native configuration/account. No startup file
// scan: only a verified v1 read requests work. No raw text in the job registry.
const jobs=new WeakMap();
export function requestCollectionMigration({readScope,expectedAccount,slot,window=globalThis.window,document=globalThis.document,now=Date.now}={}){
  if(!readScope||readScope!==getStAccountStorageReadScope()||!window?.addEventListener||!document?.addEventListener)return;
  let pool=jobs.get(readScope);if(!pool){pool=new Map();jobs.set(readScope,pool);}
  for(const [account,prior]of pool)if(account!==expectedAccount){prior.stop?.();pool.delete(account);}
  const prior=pool.get(expectedAccount);if(prior&&(prior.running||now()<prior.retryAt))return;
  let store=null,migration=null,epoch=null,committed=false;
  const job={running:true,retryAt:0,stop:null};pool.set(expectedAccount,job);
  const sameScope=()=>readScope===getStAccountStorageReadScope()&&!slot.revoked;
  const current=()=>job.running&&sameScope();
  const unchanged=()=>current()&&slot.writes===0&&(epoch===null||epoch===slot.epoch);
  const busy=()=>{const stream=window.SillyTavern?.getContext?.()?.streamingProcessor;
    return slot.writes>0||Boolean(stream&&!stream.isStopped&&!stream.isFinished);};
  job.stop=scheduleCollectionMigrationSteps({window,document,now,isCurrent:current,isBusy:busy,
    async step(){
      try{
      if(!migration){
        epoch=slot.epoch;store=await createConfiguredStAccountStorage({maxBytes:TEXT_COLLECTION_SYNC_LIMITS.bytes,isCurrent:unchanged});
        const owner='st-user:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(store.namespace.slice(8)))),b=>b.toString(16).padStart(2,'0')).join('');
        if(owner!==expectedAccount||!unchanged())throw Error('collection owner changed');
        migration=createCollectionMigration({store,expectedAccount,check:unchanged});
      }
      const result=await migration.step();if(result.changed){committed=true;slot.cache=null;slot.memo?.clear();slot.epoch++;}return result;
      }finally{if(!job.running){migration?.close();store?.close();migration=null;store=null;}}
    },
    onFinish(cause){migration?.close();store?.close();migration=null;store=null;job.running=false;job.stop=null;
      // Failures are retried only after a later normal read and a quiet minute;
      // no network retry loop or user-facing interruption for optional upkeep.
      job.retryAt=now()+(cause?60000:30*60*1000);
      if(cause&&epoch!==null){slot.cache=null;slot.memo?.clear();slot.epoch++;}
      if(committed&&sameScope())try{document.dispatchEvent(new (window.Event||globalThis.Event)('qianmu-text-collections-changed'));}catch{}
    }});
}
