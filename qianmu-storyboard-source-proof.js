// Shared source primitives. Kept separate so ordinary and streaming source
// verifiers can compose without a circular dependency or host state.
const fail=()=>{throw Object.assign(new Error('正文来源摘要无法核对，未继续提交'),{code:'storyboard_stream_source'});};
const scalar=value=>value instanceof Date?value.toISOString():String(value??'');
export function storyboardStreamGeneration(message){
  const active=message.swipe_info?.[message.swipe_id||0]||{};
  return {sentAt:scalar(message.send_date),startedAt:scalar(message.gen_started),id:scalar(message.extra?.gen_id),
    activeSentAt:scalar(active.send_date),activeId:scalar(active.extra?.gen_id)};
}
export function storyboardStreamFingerprint(text){let h=2166136261;for(const ch of text){h^=ch.charCodeAt(0);h=Math.imul(h,16777619);}return(h>>>0).toString(16).padStart(8,'0');}
export async function storyboardStreamDigest(text){
  if(!globalThis.crypto?.subtle)fail();
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
