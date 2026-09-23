import {characterBackupBindingKey,characterLibraryBackupDigest} from './qianmu-character-library-backup.js';
import {CHARACTER_IMPORT_SCHEMA,readCharacterImport,preserveCharacterImport,attachCharacterImport} from './qianmu-character-import.js';
import {characterNativeEqual as equal,characterNativeFail as fail} from './qianmu-character-native-contract.js';
import {emptyCharacterSources,characterSourceLibrary,inspectCharacterSources,validateCharacterSources,CHARACTER_SOURCES_BYTES} from './qianmu-character-source-backup.js';

async function readSource(ctx,receipt){
  const source=await readCharacterImport(ctx.client,receipt,ctx.transport),archives=[];ctx.check();
  for(const row of source.archives){archives.push(await ctx.originals.read(row,ctx.transport));ctx.check();}
  const library=characterSourceLibrary(ctx.client.namespace,archives,source.bindings);
  if(await characterLibraryBackupDigest(library)!==source.digest)fail('original','旧来源清单与完整档案原文不符');ctx.check();
  return {digest:source.digest,library};
}
export async function backupNativeCharacterSources(ctx){
  const {index,fingerprint}=await ctx.read(),result=emptyCharacterSources(ctx.client.namespace);let size=0;
  for(const receipt of index.imports||[]){
    const row=await readSource(ctx,receipt);size+=new TextEncoder().encode(JSON.stringify(row)).byteLength;
    if(size>CHARACTER_SOURCES_BYTES)fail('capacity','角色旧源超过64MiB，请保留原环境；未裁剪来源');result.sources.push(row);
  }
  validateCharacterSources(result);if((await ctx.read()).fingerprint!==fingerprint)fail('changed','读取旧源期间角色库已变化，请重新备份');return result;
}
export async function previewNativeCharacterSources(ctx,input){
  const summary=await inspectCharacterSources(input,ctx.client.namespace,{guard:ctx.check}),{index}=await ctx.read(),known=new Set((index.imports||[]).map(row=>row.digest));
  const added=input.sources.filter(row=>!known.has(row.digest)).length;
  if(known.size+added>256)fail('capacity','角色旧源保全目录已达上限，未自动清理');
  return {...summary,added,existing:summary.count-added};
}
export async function verifyNativeCharacterSources(ctx,input){
  await inspectCharacterSources(input,ctx.client.namespace,{guard:ctx.check});const {index}=await ctx.read();
  for(const row of input.sources){const receipt=index.imports?.find(item=>item.digest===row.digest);if(!receipt)fail('original','角色旧源尚未完整保全');
    if(!equal(await readSource(ctx,receipt),row))fail('original','角色旧源读回不符');}
  const latest=(await ctx.read()).index;
  for(const row of input.sources){const before=index.imports.find(item=>item.digest===row.digest),after=latest.imports?.find(item=>item.digest===row.digest);
    if(!after||!equal(before.source,after.source))fail('changed','角色旧来源目录在核验期间已变化');}
  ctx.check();return {count:input.sources.length};
}
export async function restoreNativeCharacterSources(ctx,input){
  const summary=await previewNativeCharacterSources(ctx,input);
  for(const row of input.sources){
    ctx.check();const {index}=await ctx.read(),known=index.imports?.find(item=>item.digest===row.digest);
    if(known){if(!equal(await readSource(ctx,known),row))fail('original','已有旧源与备份原件不符');continue;}
    const archives=[];for(const record of row.library.archives){archives.push(await ctx.originals.preserve(record,ctx.transport));ctx.check();}
    const source={schema:CHARACTER_IMPORT_SCHEMA,namespace:ctx.client.namespace,digest:row.digest,archives,bindings:row.library.bindings,usage:row.library.usage};
    const receipt=await preserveCharacterImport(ctx.client,source,ctx.transport);ctx.check();
    await ctx.update(next=>{
      const previous=next.imports?.find(item=>item.digest===row.digest);
      if(previous){if(!equal(previous.source,receipt.source))fail('original','同编号旧源已有不同原件');return;}
      // Source-only publication never copies an archive, clears tombstones or
      // replays a binding. Even absent records require the normal review UI.
      const pending=source.archives.filter(item=>!equal(next.archives.find(local=>local.head.id===item.head.id),item)).map(item=>`archive:${item.head.id}`);
      for(const binding of source.bindings){const key=characterBackupBindingKey(binding),local=next.bindings.find(item=>characterBackupBindingKey(item)===key);
        if(!local||local.archiveId!==binding.archiveId)pending.push(`binding:${key}`);}
      attachCharacterImport(next,receipt,pending);
    });
  }
  await verifyNativeCharacterSources(ctx,input);return summary;
}
