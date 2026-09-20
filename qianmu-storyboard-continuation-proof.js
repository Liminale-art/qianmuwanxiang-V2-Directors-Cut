const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const stop=()=>{throw Object.assign(new Error('续写来源未能完整核对，未沿用旧任务身份'),{code:'storyboard_continuation'});};
const fields=['sentAt','startedAt','id','activeSentAt','activeId'];
const provisional=new WeakMap();
export function readStoryboardContinuationLinks(store){
  return store&&provisional.has(store)?provisional.get(store).before:store?.storyboardContinuations;
}
export function stageStoryboardContinuationLinks(store,next){
  if(!object(store)||provisional.has(store))stop();
  const entry={had:Object.hasOwn(store,'storyboardContinuations'),before:store.storyboardContinuations};
  provisional.set(store,entry);store.storyboardContinuations=next;
  return saved=>{
    if(provisional.get(store)!==entry)return;
    provisional.delete(store);
    if(!saved&&store.storyboardContinuations===next){if(entry.had)store.storyboardContinuations=entry.before;else delete store.storyboardContinuations;}
  };
}
export const storyboardContinuationSignature=value=>JSON.stringify([value.messageKey,value.swipeId,value.generation]);
export function storyboardContinuationEndpoint(value){
  const g=value?.generation;
  if(!object(value)||!text(value.messageKey,80)||!Number.isSafeInteger(value.swipeId)||value.swipeId<0||value.swipeId>10000
    ||!object(g)||Object.keys(g).length!==fields.length||fields.some(key=>typeof g[key]!=='string'||g[key].length>160||/[\u0000-\u001f\u007f]/.test(g[key]))
    ||!(g.startedAt||g.id||g.activeId))stop();
  return {messageKey:value.messageKey,swipeId:value.swipeId,generation:Object.fromEntries(fields.map(key=>[key,g[key]]))};
}
export function normalizeStoryboardContinuationLinks(value){
  if(!Array.isArray(value)||value.length>400)stop();
  const ids=new Set(),outgoing=new Set();
  const rows=value.map(raw=>{
    if(!object(raw)||raw.version!==1||!hex(raw.id)||!text(raw.chatKey,512)||!text(raw.namespace,512)||!raw.namespace.startsWith('st-user:')||!raw.namespace.slice(8).trim()
      ||typeof raw.name!=='string'||raw.name.length>120||!Number.isSafeInteger(raw.createdAt)||raw.createdAt<1
      ||!Number.isSafeInteger(raw.length)||raw.length<1||raw.length>200000||!hex(raw.digest)||!/^[a-f0-9]{8}$/.test(raw.hash||''))stop();
    const from=storyboardContinuationEndpoint(raw.from),to=storyboardContinuationEndpoint(raw.to),key=JSON.stringify([raw.namespace,raw.chatKey,storyboardContinuationSignature(from)]);
    if(from.swipeId!==to.swipeId||storyboardContinuationSignature(from)===storyboardContinuationSignature(to)||ids.has(raw.id)||outgoing.has(key))stop();
    ids.add(raw.id);outgoing.add(key);
    return {version:1,id:raw.id,namespace:raw.namespace,chatKey:raw.chatKey,name:raw.name,from,to,length:raw.length,hash:raw.hash,digest:raw.digest,createdAt:raw.createdAt};
  });
  if(new TextEncoder().encode(JSON.stringify(rows)).length>524288)stop();
  return rows;
}

// Resolve the recorded append lineage; callers still validate the original
// image prefix, and paid dispatch checks every returned bridge's SHA again.
export function storyboardContinuationPath(reference,links,{namespace}={}){
  const rows=normalizeStoryboardContinuationLinks(links),proof=reference?.stream;
  if(!proof?.generation)return [];
  let from=storyboardContinuationEndpoint({messageKey:reference.messageKey,swipeId:reference.swipeId,generation:proof.generation});
  const path=[],seen=new Set([storyboardContinuationSignature(from)]);
  for(let i=0;i<=32;i++){
    const matches=rows.filter(row=>row.chatKey===reference.chatKey&&row.name===reference.name&&storyboardContinuationSignature(row.from)===storyboardContinuationSignature(from)
      &&(!namespace||namespace===row.namespace));
    if(!matches.length)return path;if(matches.length!==1||path.length===32)stop();
    const row=matches[0];namespace||=row.namespace;
    if(row.length<proof.prefixLength||path.length&&row.length<path.at(-1).length||seen.has(storyboardContinuationSignature(row.to)))stop();
    path.push(row);from=row.to;seen.add(storyboardContinuationSignature(from));
  }
  stop();
}
