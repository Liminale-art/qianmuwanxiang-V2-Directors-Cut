import {nativeCollectionSummary,nativeCollectionLogicalBytes} from './qianmu-text-collection-document.js';
import {validateTextCollectionBackup} from './qianmu-text-collection-backup.js';
import {textCollectionSyncError as error} from './qianmu-text-collection-sync-contract.js';

// Only get/search/backup may read complete originals. List, inventory and cleanup
// use the verified index. A failed search/backup never returns a partial result.
export async function queryIndexedCollection(state,method,input,{common,expectedAccount,now,readEntry,check,memo,yieldWork=()=>new Promise(resolve=>setTimeout(resolve,0))}={}){
  await check();const live=state.entries.filter(row=>!row.deleted);
  if(method==='get'){
    const row=live.find(row=>row.id===input.id),record=row?(await readEntry(row)).record:null;await check();return {...common,record};
  }
  if(method==='inventory')return {...common,state:'present',count:live.length,deletedCount:state.entries.length-live.length,
    bytes:nativeCollectionLogicalBytes(state),textBytes:live.reduce((sum,row)=>sum+row.textBytes,0)};
  if(method==='snapshot'){
    const records=[];for(const row of live){await yieldWork();await check();records.push((await readEntry(row)).record);await check();}
    return {...common,backup:validateTextCollectionBackup({type:'qianmu-text-collections',version:1,sourceAccount:expectedAccount,exportedAt:now(),libraryRevision:state.revision,records})};
  }
  if(method!=='list')throw error('contract','收藏目录读取方式无效',400);
  if(input.cursor&&input.cursor.revision!==state.revision)throw error('changed','收藏目录已更新，请重新载入');
  const term=(input.search||'').trim().toLowerCase(),filtered=Object.hasOwn(input,'search')?{search:input.search.trim()}:{},rows=[],indices=[];
  const matched=term?memo?.getSearch(state,term):null;
  const candidates=term&&!matched?memo?.getCandidates(state,term):null;
  if(matched){for(const index of matched)rows.push(live[index]);}
  else for(const index of candidates||live.keys()){
    const row=live[index];
    if(term){await yieldWork();await check();
      // Names can prove a match without a body read. A preview cannot prove a
      // negative: full-text matches after its last character must still work.
      if(![row.summary.charName,row.summary.userName].some(value=>value.toLowerCase().includes(term))){
        const entry=await readEntry(row);await check();if(!entry.record.text.toLowerCase().includes(term))continue;
      }
    }rows.push(row);if(term)indices.push(index);
  }
  await check();if(term&&!matched)memo?.rememberSearch(state,term,indices);
  rows.sort((a,b)=>b.summary.createdAt-a.summary.createdAt||a.id.localeCompare(b.id));
  const offset=input.cursor?.offset||0,items=rows.slice(offset,offset+input.limit).map(nativeCollectionSummary),next=offset+items.length;await check();
  return {...common,...filtered,items,total:rows.length,nextCursor:next<rows.length?{revision:state.revision,offset:next,...filtered}:null};
}
