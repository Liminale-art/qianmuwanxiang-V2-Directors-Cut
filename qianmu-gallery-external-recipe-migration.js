import {preserveCapturedSnapshotArchives} from './qianmu-plan-archive-write.js';
import {recipeArchiveReference,recipeArchiveResponse} from './qianmu-recipe-archive-contract.js';
import {prepareExternalGalleryRecipeFieldRelease} from './qianmu-gallery-recipe-fields.js';
import {galleryRecordFingerprintText} from './qianmu-gallery-record-fingerprint.js';
import {sha256} from './vendor/noble-hashes-2.4.0/sha2.js';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const utf8=new TextEncoder(),fingerprint=record=>sha256(utf8.encode(galleryRecordFingerprintText(record).text));
const same=(a,b)=>a.length===b.length&&a.every((value,index)=>value===b[index]);
const changed=()=>Error('已外置配方或画面来源变化，未移出常驻内容');
export function hasExternalGalleryRecipeFields(record){
  return Boolean(record?.id&&!Object.hasOwn(record,'snapshot')&&record.snapshotServerRef&&record.recipeUnavailable!==true
    &&['compiledPrompt','compositionDecision'].some(name=>object(Object.getOwnPropertyDescriptor(record,name)?.value)));
}

// Runs inside the inline migrator's existing per-gallery lane and deadline.
// No prewarm, upload, server write, guessed local lookup or original deletion.
export async function releaseExternalGalleryRecipeFields(records,{gallery,chatKey,check,available,admit,connect,recordChatKey,recordKey,
  put,save,projectRecipeRecord,onError,yieldWork,now,deadline,limits}={}){
  let cursor=0,completed=0,stop=false;
  while(cursor<records.length&&!stop&&now()<deadline){
    let server;
    try{
      await yieldWork();check();
      while(cursor<records.length&&!hasExternalGalleryRecipeFields(records[cursor]))cursor++;
      if(cursor===records.length||now()>=deadline||!available()||!await admit())break;check();
      server=await connect();check();
      const prepared=[];let bytes=0,attempts=0;
      while(cursor<records.length&&attempts<limits.records&&now()<deadline){
        await yieldWork();check();if(now()>=deadline)break;
        const record=records[cursor];
        if(!hasExternalGalleryRecipeFields(record)||recordChatKey(record,chatKey)!==chatKey||!gallery.includes(record)){cursor++;continue;}
        const key=recordKey(record,chatKey);if(!key){cursor++;continue;}
        try{
          const reference=recipeArchiveReference(record.snapshotServerRef);
          // The immutable envelope size bounds the complete recipe before reading.
          if(reference.bytes>limits.bytes)throw Error('单份配方超过分批整理范围，原内容保持原样');
          if(attempts&&bytes+reference.bytes>limits.bytes)break;
          cursor++;attempts++;bytes+=reference.bytes;
          const captured=fingerprint(record),recordId=String(record.id),result=recipeArchiveResponse(await server.read(record));check();
          if(result.origin!=='server-archive'||!result.reference||['version','id','sha256','bytes'].some(key=>result.reference[key]!==reference[key])
            ||!same(fingerprint(record),captured)||!gallery.includes(record)
            ||gallery.filter(row=>String(row?.id||'')===recordId).length!==1)throw changed();
          const fields=prepareExternalGalleryRecipeFieldRelease(record,result.snapshot,projectRecipeRecord);
          if(fields.changed)prepared.push({record,recordId,chatKey,key,snapshot:result.snapshot,recipeFields:fields,reference:record.snapshotServerRef});
        }catch(error){stop=true;onError(error);break;}
      }
      if(!prepared.length)continue;
      await server.guard();check();
      const stored=await preserveCapturedSnapshotArchives(prepared,put);check();
      await server.guard();check();
      const applied=[];
      try{
        for(const item of stored){
          if(!gallery.includes(item.record)||String(item.record.id)!==item.recordId)throw changed();
          item.previousMetadata=['chatKey','snapshotRef','snapshotVersion'].map(key=>({key,present:Object.hasOwn(item.record,key),value:item.record[key]}));
          item.recipeFields.apply();
          Object.assign(item.record,{chatKey,snapshotRef:item.key,snapshotVersion:1});applied.push(item);
        }
        await save();check();await server.guardIdentity();check();completed+=applied.length;
      }catch(error){
        for(const item of applied)if(!Object.hasOwn(item.record,'snapshot')&&item.record.snapshotRef===item.key&&item.record.snapshotServerRef===item.reference){
          item.recipeFields.rollback();
          for(const field of item.previousMetadata){if(field.present)item.record[field.key]=field.value;else delete item.record[field.key];}
        }
        throw error;
      }
    }catch(error){onError(error);break;}finally{server?.close();}
  }
  return completed;
}
