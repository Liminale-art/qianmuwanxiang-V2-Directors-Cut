import {createTextCollectionOriginalStore} from './qianmu-text-collection-original.js';
import {validateNativeCollectionDocument} from './qianmu-text-collection-document.js';
import {textCollectionSyncError as error} from './qianmu-text-collection-sync-contract.js';

// One full original per step. The caller supplies idle scheduling and account /
// foreground-write fences. The source head is never changed until ALL originals
// have been verified. Native ST is optimistic detection, not cross-device CAS.
export function createCollectionMigration({store,expectedAccount,check=()=>true,options={}}={}){
  let source=null,next=null,originals=null,index=0,done=false,stopped=false,running=false;
  const validate=value=>validateNativeCollectionDocument(value,{expectedAccount,scope:store.scope});
  const guard=async()=>{if(stopped||await check()===false||stopped)throw error('changed','收藏整理已让位于新操作，原件保留');};
  const transport={...options,guard:async()=>{await guard();return !options.guard||await options.guard()!==false;}};
  const release=()=>{source=null;next=null;originals=null;};
  return Object.freeze({
    async step(){
      if(done)return {done:true};
      if(running)throw error('busy','收藏整理正在处理当前原件');
      running=true;
      try{
        await guard();
        if(!source){
          source=await store.read('collections',transport);await guard();
          if(!source.exists||source.value.version===2){if(source.exists)validate(source.value);done=true;release();return {done:true,changed:false};}
          const state=validate(source.value);
          // v1 allowed extra root metadata. Never silently drop it when moving
          // to the strict v2 layout; keep this library intact for later review.
          if(Object.keys(state).some(key=>!['version','expectedAccount','revision','entries','receipts','migration'].includes(key)))throw error('layout','收藏含旧版扩展资料，保留原格式');
          if(!/^[a-f0-9]{64}$/.test(source.fingerprint||''))throw error('corrupt','收藏来源版本不可核对，未整理');
          next={...state,version:2,entries:[]};originals=createTextCollectionOriginalStore({storage:store,expectedAccount});
          return {done:false,processed:0,total:state.entries.length};
        }
        if(index<source.value.entries.length){
          const row=source.value.entries[index];
          next.entries.push(row.deleted?structuredClone(row):await originals.preserve(row,transport));await guard();index++;
          return {done:false,processed:index,total:source.value.entries.length};
        }
        validate(next);await guard();
        const result=await store.write('collections',next,{...transport,expectedFingerprint:source.fingerprint});
        await guard();validate(result.value);done=true;release();return {done:true,changed:true};
      }catch(cause){stopped=true;release();throw cause;}
      finally{running=false;}
    },
    close(){stopped=true;release();},
  });
}
