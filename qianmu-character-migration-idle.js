import {createConfiguredStAccountStorage,getStAccountStorageReadScope} from './qianmu-st-account-storage.js';
import {scheduleCollectionMigrationSteps} from './qianmu-text-collection-migration-idle.js';
import {createCharacterMigration} from './qianmu-character-migration.js';

const jobs=new WeakMap();
// Only a verified nonempty local read requests work, not ST startup. The job owns
// separate clients so closing a panel neither interrupts preservation nor keeps
// its DOM alive. Same account/config coalesces; another account closes the job.
export function requestCharacterMigration({namespace,createLocal,readScope=getStAccountStorageReadScope(),
  createStorage=createConfiguredStAccountStorage,window=globalThis.window,document=globalThis.document,now=Date.now}={}) {
  if(!readScope||readScope!==getStAccountStorageReadScope()||!window?.addEventListener||!document?.addEventListener)return;
  let pool=jobs.get(readScope);if(!pool){pool=new Map();jobs.set(readScope,pool);}
  for(const [account,old]of pool)if(account!==namespace){old.stop?.();pool.delete(account);}
  const prior=pool.get(namespace);if(prior&&(prior.running||now()<prior.retryAt))return;
  let storage=null,local=null,migration=null;
  const job={running:true,retryAt:0,stop:null};pool.set(namespace,job);
  const current=()=>job.running&&readScope===getStAccountStorageReadScope();
  const clean=()=>{migration?.close();local?.close();storage?.close();migration=null;local=null;storage=null;};
  job.stop=scheduleCollectionMigrationSteps({window,document,now,isCurrent:current,
    isBusy:()=>{const stream=window.SillyTavern?.getContext?.()?.streamingProcessor;return Boolean(stream&&!stream.isStopped&&!stream.isFinished);},
    async step(){try {
      if(!migration){
        storage=await createStorage({maxBytes:8*1024*1024,isCurrent:current});
        if(!current()||storage.namespace!==namespace)throw Error('character migration account changed');
        local=createLocal();migration=createCharacterMigration({storage,local,isCurrent:current});
      }
      return await migration.step();
    } finally {if(!job.running)clean();}},
    onFinish(cause){job.running=false;job.stop=null;job.retryAt=now()+(cause?60000:30*60*1000);clean();},
  });
}
