// Local-first note sessions. The transport is injected; this module performs no network request itself.
import {createNotesSyncStore,notesLocalNamespace,notesLocalError,notesLocalContent,notesLocalGeometry,summarizeNotesLocalState} from './qianmu-notes-sync-store.js';
import {notesSyncListResponse,notesSyncWriteResponse,notesSyncConflictResponse,notesSyncMutationId,notesSyncOperationId} from './qianmu-notes-sync-contract.js';

const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const content=note=>({title:note.title,body:note.body,pinned:note.pinned,createdAt:note.createdAt});
const changed=(left,right)=>!same(content(left),content(right));
export function createNotesSyncRuntime({namespace,store=null,client=null,onChange=()=>{},guard=()=>true,uid=notesSyncOperationId,now=Date.now,cryptoImpl=globalThis.crypto}={}) {
  notesLocalNamespace(namespace);const ownsStore=!store;store ||= createNotesSyncStore();
  const session=notesSyncMutationId(uid()),observed=new Map(),accepted=new Map(),forks=new Map();
  let closed=false,tail=Promise.resolve(),syncing=null,lastState='local-only',lastError='',pendingCount=0,conflicts=0,hasSynced=false;
  const status=()=>Object.freeze({namespace,state:closed?'closed':syncing?'syncing':lastState,pending:pendingCount,error:lastError,conflicts});
  const check=async()=>{if(closed)throw notesLocalError('closed','便笺会话已关闭');if(await guard()===false)throw notesLocalError('account','便笺账户已变化');if(closed)throw notesLocalError('closed','便笺会话已关闭');};
  const serial=work=>{const job=tail.then(async()=>{await check();return work();});tail=job.catch(()=>{});return job;};
  const notify=(reason,ids=[])=>{if(!closed)try{onChange({reason,ids:[...new Set(ids)],status:status()});}catch(_){};};
  const remember=row=>{observed.set(row.id,structuredClone(row));return expose(row);};
  const expose=row=>({...structuredClone(row.note),...row.geometry,schemaVersion:1,revision:row.remoteRevision,localRevision:row.generation,...(row.conflictOf?{syncConflictOf:row.conflictOf}:{})});
  const count=state=>{pendingCount=state.rows.filter(row=>row.pending).length;if(lastState!=='error')lastState=pendingCount?'pending':hasSynced?'synced':'local-only';};
  const read=async()=>{const state=await store.read(namespace,{guard:()=>!closed});await check();count(state);return state;};
  const update=async work=>{const state=await store.update(namespace,work,{guard:()=>!closed});await check();count(state);return state;};
  const mutation=row=>({mutationId:notesSyncMutationId(uid()),baseRevision:row.remoteRevision,generation:row.generation,deleted:row.deleted,note:structuredClone(row.note),started:false});
  const newId=state=>{for(let tries=0;tries<10;tries++){const id=`note-${notesSyncMutationId(uid())}`;if(Array.from(id).length<=120&&!state.rows.some(row=>row.id===id))return id;}throw notesLocalError('identity','未能创建独立便笺编号，原内容保留');};
  const create=(note,geometry,conflictOf=null)=>{const row={namespace,id:note.id,note:structuredClone(note),geometry:notesLocalGeometry(geometry),generation:1,remoteRevision:0,deleted:false,pending:null,writer:session,conflictOf};row.pending=mutation(row);return row;};
  const allowOwn=(row,base)=>row.writer===session&&accepted.get(row.id)?.has(base);
  const markOwn=(row,base)=>{const values=accepted.get(row.id)||new Set();if(Number.isSafeInteger(base))values.add(base);values.add(row.generation);accepted.set(row.id,values);};
  const fork=(state,row,note=row.note)=>{const copy=create({...note,id:newId(state),updatedAt:now()}, {...row.geometry,floating:false},row.id);state.rows.push(copy);markOwn(copy,copy.generation);return copy;};
  function installRemote(state,record,prior=null){
    const row={namespace,id:record.id,note:notesLocalContent(record),geometry:prior?.geometry||notesLocalGeometry(),generation:(prior?.generation||0)+1,remoteRevision:record.revision,deleted:record.deleted,pending:null,writer:'remote',conflictOf:prior?.conflictOf||null};
    if(prior)state.rows[state.rows.indexOf(prior)]=row;else state.rows.push(row);return row;
  }
  function resolveConflict(state,row,record){
    // Both sides chose deletion. Respect the shared intent rather than recreating a visible copy.
    if(row.deleted&&record?.deleted){installRemote(state,record,row);return null;}
    const copy=fork(state,row);forks.set(`${row.id}/${row.generation}`,copy.id);
    for(const base of accepted.get(row.id)||[])forks.set(`${row.id}/${base}`,copy.id);
    if(record)installRemote(state,record,row);
    else{row.deleted=true;row.pending=null;row.generation++;row.writer='remote';}
    return copy;
  }
  async function save(input){
    const captured=structuredClone(input),provided=notesLocalContent(captured),geometry=notesLocalGeometry(captured);
    return serial(async()=>{
      let saved,conflict=false;const base=Number.isSafeInteger(captured.localRevision)?captured.localRevision:observed.get(provided.id)?.generation;
      await update(state=>{
        const forkId=forks.get(`${provided.id}/${base}`),id=forkId||provided.id;
        const row=state.rows.find(row=>row.id===id),note={...provided,id,updatedAt:now()};
        if(!row){saved=create(note,geometry);state.rows.push(saved);markOwn(saved,base);return;}
        if(row.deleted||(!forkId&&base!==row.generation&&!allowOwn(row,base))){
          saved=fork(state,row,note);saved.geometry=geometry;forks.set(`${provided.id}/${base}`,saved.id);conflict=true;return;
        }
        if(note.createdAt!==row.note.createdAt)throw notesLocalError('identity','便笺创建时间不可改写，原内容保留');
        row.geometry=geometry;
        if(changed(row.note,note)){row.note=note;row.generation++;row.writer=session;row.pending ||= mutation(row);}
        saved=row;markOwn(row,base);
      });
      if(conflict)conflicts++;lastError='';lastState=pendingCount?'pending':hasSynced?'synced':'local-only';const result=remember(saved);notify(conflict?'conflict':'save',[provided.id,saved.id]);return result;
    });
  }
  async function remove(id,{localRevision}={}){
    return serial(async()=>{
      let removed=false;const base=Number.isSafeInteger(localRevision)?localRevision:observed.get(id)?.generation;
      await update(state=>{const row=state.rows.find(row=>row.id===id);if(!row||row.deleted)return;
        if(base!==row.generation&&!allowOwn(row,base))throw notesLocalError('local_conflict','另一页面已修改此便笺，未删除新内容，请重新查看');
        row.deleted=true;row.generation++;row.writer=session;row.note.updatedAt=now();
        if(row.pending?.baseRevision===0&&!row.pending.started)row.pending=null;
        else row.pending ||= mutation(row);
        markOwn(row,base);removed=true;
      });notify('remove',[id]);return removed;
    });
  }
  async function list(){return serial(async()=>{const state=await read();return state.rows.filter(row=>!row.deleted).map(remember).sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id));});}
  async function importLegacy(notes,{confirmed=false,receipt}={}){
    if(!confirmed||typeof receipt!=='string'||!receipt||receipt.length>180)throw notesLocalError('consent','请先确认旧便笺归属并提供迁移回执');
    if(!Array.isArray(notes))throw notesLocalError('content','旧便笺目录无效');
    const incoming=Array.from(notes,note=>({note:notesLocalContent(note),geometry:notesLocalGeometry(note)}));
    return serial(async()=>{let imported=0,repeated=false;const ids=[];
      await update(state=>{if(state.receipts.includes(receipt)){repeated=true;return;}
        for(const {note:original,geometry} of incoming){const note={...original};if(state.rows.some(row=>row.id===note.id))note.id=newId(state);const row=create(note,geometry);state.rows.push(row);ids.push(row.id);markOwn(row,row.generation);imported++;}
        state.receipts.push(receipt);
      });notify('import',ids);return {imported,repeated,ids};
    });
  }
  async function verifyAccount(response){
    const hash=await cryptoImpl.subtle.digest('SHA-256',new TextEncoder().encode(namespace.slice(8)));
    const expected='st-user:'+Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
    if(response.expectedAccount!==expected)throw notesLocalError('account','便笺返回属于另一账户，未采用');await check();
  }
  async function synchronize(){
    await check();if(!client){await serial(read);lastState='local-only';lastError='当前没有便笺同步服务，本机内容已保留';return status();}
    try{
      const initial=await serial(read),queue=initial.rows.filter(row=>row.pending).map(row=>row.id);let processed=0;
      for(let at=0;at<queue.length;at++){
        if(processed++>=20000)break;const id=queue[at];let sent=null;
        await serial(()=>update(state=>{const row=state.rows.find(row=>row.id===id);if(row?.pending){row.pending.started=true;sent=structuredClone(row.pending);}}));
        if(!sent)continue;
        const raw=await client.write({id,baseRevision:sent.baseRevision,note:content(sent.note),deleted:sent.deleted,mutationId:sent.mutationId});
        const response=raw?.ok===false?notesSyncConflictResponse(raw):notesSyncWriteResponse(raw);await verifyAccount(response);
        if(response.note&&response.note.id!==id)throw notesLocalError('response','便笺确认编号不一致');
        if(response.ok&&(response.note.revision<=sent.baseRevision||response.note.deleted!==sent.deleted||response.note.createdAt!==sent.note.createdAt
          ||(!sent.deleted&&changed(response.note,sent.note))))throw notesLocalError('response','便笺保存确认与本机待同步内容不符，未清除待同步记录');
        let copied=null,needsMore=false;const affected=[id];
        await serial(()=>update(state=>{
          const row=state.rows.find(row=>row.id===id);if(!row||row.pending?.mutationId!==sent.mutationId)return;
          state.serverRevision=Math.max(state.serverRevision,response.revision);
          if(response.ok===false){copied=resolveConflict(state,row,response.note);if(copied){affected.push(copied.id);needsMore=true;}return;}
          if(response.note.revision<row.remoteRevision)return;
          row.remoteRevision=response.note.revision;
          if(row.generation===sent.generation){row.note=notesLocalContent(response.note);row.deleted=response.note.deleted;row.pending=null;}
          else if(response.note.deleted&&!row.deleted){copied=resolveConflict(state,row,response.note);affected.push(copied.id);needsMore=true;}
          else{row.pending=mutation(row);needsMore=true;}
        }));
        if(copied){conflicts++;queue.push(copied.id);}else if(needsMore)queue.push(id);
        notify(copied?'conflict':'ack',affected);
      }
      const response=notesSyncListResponse(await client.list());await verifyAccount(response);const affected=[],copied=[];
      await serial(()=>update(state=>{
        if(response.revision<state.serverRevision)throw notesLocalError('stale','服务器便笺版本回退，未覆盖本机内容，请核对备份');
        state.serverRevision=response.revision;
        for(const record of response.notes){const row=state.rows.find(row=>row.id===record.id);
          if(row&&record.revision<=row.remoteRevision)continue;
          if(row?.pending){const copy=resolveConflict(state,row,record);if(copy){copied.push(copy.id);affected.push(copy.id);}affected.push(record.id);}
          else{installRemote(state,record,row);affected.push(record.id);}
        }
      }));
      conflicts+=copied.length;hasSynced=true;lastError='';lastState=pendingCount?'pending':'synced';notify(copied.length?'conflict':'pull',affected);return status();
    }catch(error){if(!closed){lastState=error?.code==='notes_sync_unavailable'?'local-only':'error';lastError=error?.message||'便笺同步失败，本机内容已保留';notify('error');}throw error;}
  }
  function sync(){if(syncing)return syncing;const work=synchronize();syncing=work.then(()=>{syncing=null;notify('status');return status();},error=>{syncing=null;notify('status');throw error;});return syncing;}
  return Object.freeze({namespace,list,save,remove,importLegacy,sync,summary:()=>serial(async()=>summarizeNotesLocalState(await read())),get status(){return status();},close(){closed=true;client?.close?.();if(ownsStore)store.close();observed.clear();accepted.clear();forks.clear();}});
}
