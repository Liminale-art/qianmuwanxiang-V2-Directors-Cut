import {createConfiguredStAccountStorage,getStAccountStorageReadScope} from './qianmu-st-account-storage.js';
import {scheduleCollectionMigrationSteps} from './qianmu-text-collection-migration-idle.js';

const jobs=new WeakMap();
export function getCharacterMigrationStatus(namespace){
  const job=jobs.get(getStAccountStorageReadScope())?.get(namespace);return job?{status:job.status}:null;
}
// Verified role-library use requests work, not ST startup. Existing ST directories
// also trigger a deferred local audit; they never wait for IDB in the foreground.
// The job owns
// separate clients so closing a panel neither interrupts preservation nor keeps
// its DOM alive. Same account/config coalesces; another account closes the job.
export function requestCharacterMigration({namespace,createLocal,readScope=getStAccountStorageReadScope(),
  createStorage=createConfiguredStAccountStorage,window=globalThis.window,document=globalThis.document,now=Date.now}={}) {
  if(!readScope||readScope!==getStAccountStorageReadScope()||!window?.addEventListener||!document?.addEventListener)return;
  let pool=jobs.get(readScope);if(!pool){pool=new Map();jobs.set(readScope,pool);}
  for(const [account,old]of pool)if(account!==namespace){old.stop?.();pool.delete(account);}
  const prior=pool.get(namespace);if(prior&&(prior.running||now()<prior.retryAt))return;
  let storage=null,local=null,migration=null,changed=false;
  const job={running:true,status:'queued',retryAt:0,stop:null};pool.set(namespace,job);
  const current=()=>job.running&&readScope===getStAccountStorageReadScope();
  const clean=()=>{migration?.close();local?.close();storage?.close();migration=null;local=null;storage=null;};
  job.stop=scheduleCollectionMigrationSteps({window,document,now,isCurrent:current,
    isBusy:()=>{const stream=window.SillyTavern?.getContext?.()?.streamingProcessor;return Boolean(stream&&!stream.isStopped&&!stream.isFinished);},
    async step(){try {
      job.status='running';
      if(!migration){
        const {createCharacterReconciliation}=await import('./qianmu-character-reconciliation.js');
        if(!current())return {done:true};
        storage=await createStorage({maxBytes:8*1024*1024,isCurrent:current});
        if(!current()||storage.namespace!==namespace)throw Error('character migration account changed');
        local=createLocal();migration=createCharacterReconciliation({storage,local,isCurrent:current});
      }
      const result=await migration.step();if(result.changed)changed=true;return result;
    } finally {if(!job.running)clean();}},
    onFinish(cause){job.running=false;job.status=cause?'unavailable':'complete';job.stop=null;job.retryAt=now()+(cause?60000:30*60*1000);clean();
      if(changed&&!cause&&readScope===getStAccountStorageReadScope())try{document.dispatchEvent(new (window.Event||globalThis.Event)('qianmu-character-library-changed'));}catch{}
    },
  });
}
