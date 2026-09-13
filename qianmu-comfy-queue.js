// Page-local ordering only, never provider authorization or a durable lease.
// Group conservatively by origin, including alternate API roots/credentials.
// Native host and Cloud account ledgers still enforce their own resource gates.
function origin(job) {
  try {
    const url=new URL(job?.connection?.baseUrl);
    return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password ? url.origin : null;
  } catch (_) { return null; }
}
export function canRunStoryboardComfyJob(job, active) {
  if(job?.source!=='comfy')return true;
  const target=origin(job);
  for(const running of active){
    if(running?.source!=='comfy')continue;
    const occupied=origin(running);
    // Invalid connections still go through normal validation, one at a time;
    // their unknown identity must not bypass an active Comfy resource.
    if(!target||!occupied||target===occupied)return false;
  }
  return true;
}
