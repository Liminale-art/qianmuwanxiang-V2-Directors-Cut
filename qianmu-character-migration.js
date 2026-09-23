import {validateCharacterLibraryBackup} from './qianmu-character-library-backup.js';
import {CHARACTER_NATIVE_SLOT, characterNativeFail as fail, characterNativeEqual as equal,
  emptyCharacterNativeIndex, validateCharacterNativeIndex, createCharacterNativeOriginals} from './qianmu-character-native-contract.js';

// First-publication migration only. Existing native directories (including empty
// ones with retirement markers) must go through a separate reconciliation, never
// this initial import. Each step preserves at most one complete original; legacy
// IDB and image/workflow references remain untouched. No paid API or image fetch.
export function createCharacterMigration({storage, local, isCurrent=()=>true}={}) {
  if (!storage?.namespace || typeof local?.backup!=='function' || typeof local?.createMigrationGuard!=='function') fail('setup','旧角色库迁移环境未就绪');
  let closed=false, running=false, complete=false, source=null, guardSource=null, index=null, position=0;
  const check=()=>{if(closed||isCurrent()!==true)fail('changed','角色库迁移会话已变化');return true;};
  const transport={guard:check}, context={namespace:storage.namespace,scope:storage.scope}, originals=createCharacterNativeOriginals(storage);
  async function missing() {
    const result=await storage.read(CHARACTER_NATIVE_SLOT,transport);check();
    if(result.exists){validateCharacterNativeIndex(result.value,context);fail('conflict','ST 已有角色库，未将旧端资料覆盖或合并到现有库');}
  }
  return Object.freeze({
    async step() {
      check();if(running)fail('changed','角色库迁移步骤仍在执行');if(complete)return {done:true,changed:false};running=true;
      try {
        if(!source){
          await missing();
          const value=await local.backup(storage.namespace,{isCurrent:check});check();validateCharacterLibraryBackup(value);
          if(value.namespace!==storage.namespace)fail('account','旧角色库不属于当前 ST 账户');
          source=structuredClone(value);guardSource=await local.createMigrationGuard(storage.namespace,source,{isCurrent:check});check();
          if(!source.archives.length&&!source.bindings.length){complete=true;return {done:true,changed:false};}
          index=emptyCharacterNativeIndex(storage.namespace);index.revision=1;index.bindings=structuredClone(source.bindings);index.usage=structuredClone(source.usage);
          await missing();return {done:false,changed:false};
        }
        if(position<source.archives.length){
          await guardSource();check();
          index.archives.push(await originals.preserve(source.archives[position],transport));check();position++;
          return {done:false,changed:false};
        }
        validateCharacterNativeIndex(index,context);
        // Full raw re-audit before publication catches malformed/body-only changes
        // too; final transport guards then check atomic revisions, bindings, usage
        // and original keys. A lost acknowledgement is never retried as a write.
        const latest=await local.backup(storage.namespace,{isCurrent:check});check();
        if(!equal(latest,source))fail('changed','旧角色库原件在迁移期间已变化，未确认切换');
        const saved=await storage.write(CHARACTER_NATIVE_SLOT,index,{expectedFingerprint:null,
          guard:async()=>{check();await guardSource();return check();}});
        check();if(!saved.exists||!equal(validateCharacterNativeIndex(saved.value,context),index))fail('original','角色库迁移回读不一致');
        complete=true;source=null;index=null;guardSource=null;return {done:true,changed:true};
      } catch(error) { closed=true;source=null;index=null;guardSource=null;throw error; }
      finally {running=false;}
    },
    close(){closed=true;source=null;index=null;guardSource=null;},
  });
}
