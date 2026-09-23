import {preserveCapturedSnapshotArchives} from './qianmu-plan-archive-write.js';
import {recipeArchiveSnapshot} from './qianmu-recipe-archive-contract.js';
import {prepareGalleryRecipeFieldRelease} from './qianmu-gallery-recipe-fields.js';
import {hasExternalGalleryRecipeFields,releaseExternalGalleryRecipeFields} from './qianmu-gallery-external-recipe-migration.js';

export const GALLERY_SNAPSHOT_BATCH=Object.freeze({records:8,bytes:2*1024*1024,durationMs:15000});
const lanes=new WeakMap(),utf8=new TextEncoder();
const yieldThread=()=>new Promise(resolve=>setTimeout(resolve,0));
const changed=()=>Error('聊天或配方在整理期间已变化，未继续迁移');

// Bound live recipe copies, not the saved library. Each batch retains the old
// server proof -> immutable local copy -> guarded host save/rollback sequence.
// A failed/expired pass leaves every unprocessed original inline for a later event.
export async function migrateGallerySnapshots(records,{readRecords,readChatKey,readEpoch,available,admit,connect,recordChatKey,recordKey,
  normalize,put,save,projectRecipeRecord,onError=()=>{},yieldWork=yieldThread,now=Date.now}={}){
  const epoch=readEpoch(),chatKey=String(readChatKey()||''),gallery=readRecords();
  if(!Array.isArray(records)||!Array.isArray(gallery)||!available())return 0;
  // Only retain references while waiting; never serialize/normalize the whole gallery.
  const targets=[...new Set(records.filter(record=>record?.id&&record.snapshot&&typeof record.snapshot==='object'&&recordChatKey(record,chatKey)===chatKey))];
  const external=[...new Set(records.filter(record=>hasExternalGalleryRecipeFields(record)&&recordChatKey(record,chatKey)===chatKey))];
  if(!targets.length&&!external.length)return 0;
  const check=()=>{if(epoch!==readEpoch()||chatKey!==String(readChatKey()||'')||gallery!==readRecords())throw changed();};
  const previous=lanes.get(gallery)||Promise.resolve();
  const work=previous.catch(()=>{}).then(async()=>{
    let completed=0,cursor=0,stop=false;
    const deadline=now()+GALLERY_SNAPSHOT_BATCH.durationMs;
    try{
      check();if(!await admit())return 0;check();
      while(cursor<targets.length&&!stop&&now()<deadline){
        await yieldWork();check();
        while(cursor<targets.length&&!targets[cursor].snapshot)cursor++;
        if(cursor===targets.length||now()>=deadline)break;
        if(!await admit())break;check();
        let server;
        try{
          server=await connect();check();
          const batch=typeof server.supportsBatch==='function'?await server.supportsBatch():false;check();
          if(typeof batch!=='boolean'||batch&&typeof server.preserveBatch!=='function')throw Error('配方批次客户端能力不完整，未降级继续写入');
          const confirmed=[],prepared=[];let bytes=0;
          while(cursor<targets.length&&confirmed.length+prepared.length<GALLERY_SNAPSHOT_BATCH.records&&now()<deadline){
            await yieldWork();check();
            if(now()>=deadline)break;
            const record=targets[cursor],source=record.snapshot;
            if(!record.id||!source||typeof source!=='object'||recordChatKey(record,chatKey)!==chatKey||!gallery.includes(record)){cursor++;continue;}
            const key=recordKey(record,chatKey);if(!key){cursor++;continue;}
            const sourceText=JSON.stringify(source),size=utf8.encode(batch?JSON.stringify({id:record.id,createdAt:record.createdAt,
              unavailable:record.recipeUnavailable===true,snapshot:source,reference:record.snapshotServerRef??null}):sourceText).byteLength;
            if(size>GALLERY_SNAPSHOT_BATCH.bytes){stop=true;onError(Error('单份配方超过分批整理范围，原内容保持原样'));break;}
            if((confirmed.length+prepared.length)&&bytes+size>GALLERY_SNAPSHOT_BATCH.bytes)break;
            cursor++;
            const item={record,source,sourceText,key,chatKey,recordId:String(record.id)};
            try{
              if(batch){
                if(record.recipeUnavailable===true)throw Error('此画面已明确未保留配方，原记录保持原样');
                recipeArchiveSnapshot(source);prepared.push(item);bytes+=size;continue;
              }
              const result=await server.preserve(record);check();
              if(record.snapshot!==source||JSON.stringify(source)!==sourceText||String(record.id)!==item.recordId)continue;
              item.installedServerRef=result.reference;
              item.snapshot=normalize(source,record);confirmed.push(item);bytes+=size;
            }catch(error){stop=true;onError(error);break;}
          }
          if(batch&&prepared.length&&now()<deadline){
            // A malformed later item leaves a validated prefix eligible. A
            // failed batch receipt never falls back to unverified single writes.
            const result=await server.preserveBatch(prepared.map(item=>item.record));check();
            if(result.records?.length!==prepared.length)throw Error('配方批次凭据不完整，原内容保持原样');
            for(let index=0;index<prepared.length;index++){
              const item=prepared[index];
              if(item.record.snapshot!==item.source||JSON.stringify(item.source)!==item.sourceText||String(item.record.id)!==item.recordId)continue;
              item.installedServerRef=result.records[index].reference;item.snapshot=normalize(item.source,item.record);confirmed.push(item);
            }
          }
          if(!confirmed.length)continue;
          await server.guard();check();
          const stored=await preserveCapturedSnapshotArchives(confirmed,put);check();
          await server.guard();check();
          const currentById=new Map(gallery.map(record=>[String(record?.id||''),record])),stripped=[],ready=[];
          for(const item of stored){
            if(currentById.get(item.recordId)!==item.record||String(item.record.id)!==item.recordId||item.record.snapshot!==item.source||JSON.stringify(item.record.snapshot)!==item.sourceText)continue;
            try{item.recipeFields=prepareGalleryRecipeFieldRelease(item.record,item.source,projectRecipeRecord);ready.push(item);}catch(error){onError(error);}
          }
          try{
            for(const item of ready){
              item.previousMetadata=['chatKey','snapshotRef','snapshotVersion','snapshotServerRef'].map(key=>({key,present:Object.hasOwn(item.record,key),value:item.record[key]}));
              item.recipeFields.apply();
              Object.assign(item.record,{chatKey,snapshotRef:item.key,snapshotVersion:1,snapshotServerRef:item.installedServerRef});
              delete item.record.snapshot;stripped.push(item);
            }
            if(!stripped.length)continue;
            await save();check();await server.guardIdentity();check();
          }
          catch(error){
            for(const item of stripped)if(!item.record.snapshot&&item.record.snapshotRef===item.key&&item.record.snapshotServerRef===item.installedServerRef){
              item.record.snapshot=item.source;
              item.recipeFields.rollback();
              for(const field of item.previousMetadata){if(field.present)item.record[field.key]=field.value;else delete item.record[field.key];}
            }
            throw error;
          }
          completed+=stripped.length;
        }finally{server?.close();}
      }
      if(!stop&&now()<deadline)completed+=await releaseExternalGalleryRecipeFields(external,{gallery,chatKey,check,available,admit,connect,recordChatKey,recordKey,
        put,save,projectRecipeRecord,onError,yieldWork,now,deadline,limits:GALLERY_SNAPSHOT_BATCH});
    }catch(error){onError(error);}
    return completed;
  });
  lanes.set(gallery,work);
  try{return await work;}finally{if(lanes.get(gallery)===work)lanes.delete(gallery);}
}
