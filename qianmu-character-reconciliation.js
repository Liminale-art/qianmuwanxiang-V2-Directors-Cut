import {createCharacterMigration} from './qianmu-character-migration.js';
import {validateCharacterLibraryBackup,characterLibraryBackupDigest} from './qianmu-character-library-backup.js';
import {validateCharacterStorageSummary} from './qianmu-character-storage.js';
import {CHARACTER_NATIVE_SLOT,characterNativeFail as fail,characterNativeEqual as equal,validateCharacterNativeIndex,createCharacterNativeOriginals} from './qianmu-character-native-contract.js';
import {CHARACTER_IMPORT_SCHEMA,preserveCharacterImport,readCharacterImport,planCharacterImport,attachCharacterImport} from './qianmu-character-import.js';

// Idle native/legacy reconciliation owns no UI. Exact source originals and the
// full manifest precede a single optimistic directory publication. Pure additions
// can be accepted automatically; differences survive as explicit review receipts.
export function createCharacterReconciliation({storage,local,isCurrent=()=>true}={}){
  let closed=false,running=false,done=false,first=null,source=null,digest='',manifest=null,receipt=null,guardSource=null,position=0;
  const check=()=>{if(closed||isCurrent()!==true)fail('changed','旧角色库核对会话已变化');return true;};
  const options={guard:check},context={namespace:storage.namespace,scope:storage.scope},originals=createCharacterNativeOriginals(storage);
  const release=()=>{source=null;manifest=null;receipt=null;guardSource=null;};
  const finish=changed=>{done=true;release();return {done:true,changed};};
  async function read(){const value=await storage.read(CHARACTER_NATIVE_SLOT,options);check();if(value.exists)validateCharacterNativeIndex(value.value,context);return value;}
  async function recorded(index){
    const known=index.imports?.find(row=>row.digest===digest);if(!known)return false;
    const saved=await readCharacterImport(storage,known,options);check();
    if(!equal(saved.archives.map(row=>row.head),source.archives.map(row=>row.head))||!equal(saved.bindings,source.bindings)||!equal(saved.usage,source.usage))fail('original','旧源凭据与完整目录不符，未略过核对');
    return true;
  }
  return Object.freeze({
    async step(){check();if(running)fail('changed','旧角色库核对步骤仍在执行');if(done)return {done:true,changed:false};running=true;
      try{
        if(first){const result=await first.step();if(result.done)return finish(result.changed);return result;}
        if(!source){
          const remote=await read();
          if(!remote.exists){first=createCharacterMigration({storage,local,isCurrent:check});return await first.step();}
          const summary=validateCharacterStorageSummary(await local.storageSummary(storage.namespace,{isCurrent:check}),storage.namespace);check();
          if(!summary.documents.count&&!summary.bindings.count)return finish(false);
          source=await local.backup(storage.namespace,{isCurrent:check});check();validateCharacterLibraryBackup(source);
          if(source.namespace!==storage.namespace)fail('account','旧角色库不属于当前账户');
          source=structuredClone(source);digest=await characterLibraryBackupDigest(source);check();
          if(await recorded(remote.value))return finish(false);
          guardSource=await local.createMigrationGuard(storage.namespace,source,{isCurrent:check});check();
          manifest={schema:CHARACTER_IMPORT_SCHEMA,namespace:storage.namespace,digest,archives:[],bindings:structuredClone(source.bindings),usage:structuredClone(source.usage)};
          return {done:false,changed:false};
        }
        if(position<source.archives.length){await guardSource();check();manifest.archives.push(await originals.preserve(source.archives[position],options));check();position++;return {done:false,changed:false};}
        if(!receipt){await guardSource();check();receipt=await preserveCharacterImport(storage,manifest,options);check();return {done:false,changed:false};}
        const latest=await local.backup(storage.namespace,{isCurrent:check});check();if(!equal(latest,source))fail('changed','旧角色库已变化，原件保留，未合并');
        const remote=await read();if(!remote.exists)fail('index','已确认的ST角色库目录不可读，未以旧库覆盖');
        if(await recorded(remote.value))return finish(false);
        const plan=planCharacterImport(remote.value,manifest);attachCharacterImport(plan.next,receipt,plan.pending);
        if(plan.next.revision>=Number.MAX_SAFE_INTEGER)fail('capacity','角色库目录版本达到上限');plan.next.revision++;
        validateCharacterNativeIndex(plan.next,context);
        const saved=await storage.write(CHARACTER_NATIVE_SLOT,plan.next,{expectedFingerprint:remote.fingerprint,
          guard:async()=>{check();await guardSource();return check();}});check();
        if(!equal(saved.value,plan.next))fail('original','旧资料合并目录回读不一致');return finish(true);
      }catch(error){closed=true;release();throw error;}finally{running=false;}
    },close(){closed=true;first?.close();release();},
  });
}
