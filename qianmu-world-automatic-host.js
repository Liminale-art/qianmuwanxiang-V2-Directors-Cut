import {worldSourceKey,indexWorldMedia} from './qianmu-world-source.js';

export const WORLD_AUTOMATIC_MAX_IMAGES=4;
export function normalizeWorldAutomaticLimit(value){
  const n=Number(value);return Number.isSafeInteger(n)&&n>=1&&n<=WORLD_AUTOMATIC_MAX_IMAGES?n:1;
}
export function createWorldAutomaticRepairBudget(){
  let remaining=3;
  return Object.freeze({take(){if(!remaining)return false;remaining--;return true;},get remaining(){return remaining;}});
}

// Uses the existing director ranking, not a second narrative planner. Source
// validity and the exact ledger pair are checked again by the generation host.
export function selectWorldAutomaticPackets({packets,ledger,pool,media,chatKey,limit}={}){
  if(!chatKey||pool?.owner?.chatKey!==chatKey)return [];
  const records=indexWorldMedia(media,chatKey),seen=new Set(),result=[];
  const byId=new Map((packets||[]).map(row=>[row.packetId,row]));
  const entries=new Map((ledger?.entries||[]).map(row=>[row.entryId,row]));
  for(const candidate of pool.candidates||[]){
    if(candidate.owner?.chatKey!==chatKey||candidate.sourceKind!=='simulation'||!['automatic','manual_review'].includes(candidate.recommendation)
      ||candidate.gates?.sourceValid!==true||candidate.gates.factConsistency!==true||candidate.gates.shotDistinct!==true)continue;
    const entry=entries.get(candidate.entryId),packet=byId.get(entry?.source?.recordId),source=packet?.sourceRef?.worldSource,key=worldSourceKey(source);
    if(!key||source.chatKey!==chatKey||!packet.packetId||seen.has(key)||records.has(key))continue;
    seen.add(key);result.push(packet.packetId);
    if(result.length>=normalizeWorldAutomaticLimit(limit))break;
  }
  return result;
}

// One current completion plus at most one newer waiting completion. No startup
// scan, polling loop, old-plan replay or successful-image quota refill.
export function createWorldAutomaticHost({busy=()=>false,notify=()=>{},idle=()=>{},setTimer=setTimeout,clearTimer=clearTimeout}={}){
  let closed=false,timer=null,active=null,pending=null;
  const seen=new Set();
  const optional=fn=>{try{Promise.resolve(fn()).catch(()=>{});}catch(_){};};
  const tell=text=>optional(()=>notify(text));
  const dispose=batch=>{if(batch&&!batch.disposed){batch.disposed=true;optional(()=>batch.ticket.dispose?.());}};
  const current=batch=>{
    try{return !closed&&!batch.disposed&&batch.ticket.current()===true;}
    catch(_){return false;}
  };
  function ready(batch){
    if(!current(batch))return false;
    try{return !busy();}catch(_){tell('造物之眼运行状态暂不可用，本批未继续');dispose(batch);return false;}
  }
  function wake(){
    if(closed||active||timer!==null||!pending)return;
    if(!current(pending)){dispose(pending);pending=null;return;}
    if(!ready(pending)){if(pending.disposed)pending=null;return;}
    try{timer=setTimer(()=>{timer=null;void drain();},0);}catch(_){dispose(pending);pending=null;tell('造物之眼排程未就绪，本批未提交');}
  }
  async function drain(){
    if(closed||active||!pending)return;
    const batch=pending;
    if(!ready(batch)){if(!current(batch)){dispose(batch);pending=null;}return;}
    pending=null;active=batch;let deferred=false;
    try{
      if(!batch.ids){
        const ids=await batch.ticket.prepare();
        if(!current(batch))return;
        if(!Array.isArray(ids)||ids.length>batch.limit||ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)throw Error('世界镜头批次无效，未自动提交');
        batch.ids=[...ids];
      }
      while(batch.offset<batch.ids.length&&current(batch)){
        if(!ready(batch)){
          if(current(batch)&&!pending){pending=batch;deferred=true;}
          return;
        }
        // Count an attempt, not only a successful image. A rejected attempt is
        // never replaced with another candidate to silently increase spending.
        const id=batch.ids[batch.offset++];
        if(await batch.ticket.run(id,batch.repairs)===true)batch.accepted++;
      }
      if(current(batch)&&batch.ids.length)tell(`造物之眼：${batch.accepted}/${batch.ids.length} 个画面已入队`);
    }catch(_){if(current(batch))tell('造物之眼本批已停止；已入队画面保留，未继续提交');}
    finally{
      if(!deferred)dispose(batch);
      if(active===batch)active=null;
      optional(idle);wake();
    }
  }
  return Object.freeze({
    offer(ticket){
      if(closed||typeof ticket?.key!=='string'||!ticket.key||seen.has(ticket.key)||typeof ticket.current!=='function'
        ||typeof ticket.prepare!=='function'||typeof ticket.run!=='function'){
        if(active?.original!==ticket&&pending?.original!==ticket)optional(()=>ticket?.dispose?.());return false;
      }
      const batch={original:ticket,ticket:Object.freeze({...ticket}),limit:normalizeWorldAutomaticLimit(ticket.limit),repairs:createWorldAutomaticRepairBudget(),offset:0,accepted:0,ids:null,disposed:false};
      if(!current(batch)){dispose(batch);return false;}
      seen.add(ticket.key);if(seen.size>128)seen.delete(seen.values().next().value);
      dispose(active);dispose(pending);pending=batch;wake();return true;
    },
    wake,
    close(){closed=true;if(timer!==null){try{clearTimer(timer);}catch(_){}timer=null;}dispose(pending);pending=null;dispose(active);},
    snapshot(){return {closed,active:Boolean(active),waiting:Boolean(pending),scheduled:timer!==null};},
  });
}
