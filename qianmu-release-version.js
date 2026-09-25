// Read-only metadata for the exact official branch ST has already checked.
// No account headers, keys, chat data, repository guessing or automatic update.
const REPOSITORY = 'Liminale-art/qianmuwanxiang-V2-Directors-Cut';
const MAX_BYTES = 16 * 1024;
const MAX_AGE = 30 * 60 * 1000;
const FAILURE_MAX_AGE = 60 * 1000;
const VERSION = /^v?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/;

function officialBranch(info) {
  const remote = info?.remoteUrl, branch = info?.currentBranchName;
  const official = [`https://github.com/${REPOSITORY}`, `https://github.com/${REPOSITORY}.git`, `git@github.com:${REPOSITORY}.git`, `ssh://git@github.com/${REPOSITORY}.git`];
  if (!official.includes(remote) || typeof branch !== 'string' || branch.length > 200
    || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) || branch.endsWith('/') || branch.includes('..') || branch.includes('//')
    || branch.split('/').some(part => part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) return '';
  return branch;
}

async function fetchVersion(url, fetchImpl, timeoutMs) {
  const controller = new AbortController(); let timer;
  const reading = (async () => {
    const response = await fetchImpl(url, {method:'GET', credentials:'omit', referrerPolicy:'no-referrer', redirect:'error', signal:controller.signal});
    if (!response.ok || response.redirected || !response.body || Number(response.headers.get('content-length')) > MAX_BYTES) {
      controller.abort();void response.body?.cancel().catch(()=>{});return '';
    }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      for (;;) {
        if (controller.signal.aborted) return '';
        const {done,value} = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { controller.abort(); return ''; }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
      const pkg = JSON.parse(new TextDecoder().decode(bytes)), version = pkg?.version;
      return pkg?.name === 'qianmu-omniscene' && typeof version === 'string' && version.length <= 80
        && version.trim() === version && VERSION.test(version) ? version.replace(/^v/,'') : '';
    } finally {
      void reader.cancel().catch(()=>{});
      reader.releaseLock();
    }
  })();
  try {
    return await Promise.race([reading, new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve('');},timeoutMs);})]);
  } catch { return ''; }
  finally { clearTimeout(timer); }
}

export function createQianmuReleaseVersionReader({fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=5000}={}) {
  const cache = new Map(), pending = new Map();
  return async (info,{force=false}={}) => {
    const branch = officialBranch(info);
    if (!branch || typeof fetchImpl !== 'function') return '';
    if (pending.has(branch)) return pending.get(branch);
    const cached = cache.get(branch);
    const age = cached ? now() - cached.checkedAt : Infinity;
    if (!force && cached && age >= 0 && age < (cached.version ? MAX_AGE : FAILURE_MAX_AGE)) return cached.version;
    const url = `https://raw.githubusercontent.com/${REPOSITORY}/${encodeURIComponent(branch)}/package.json`;
    const request = fetchVersion(url,fetchImpl,Math.max(1,Math.min(5000,Number(timeoutMs)||5000))).then(version=>{
      if (pending.get(branch) === request) {
        pending.delete(branch);cache.delete(branch);cache.set(branch,{version,checkedAt:now()});
        if (cache.size > 8) cache.delete(cache.keys().next().value);
      }
      return version;
    });
    pending.set(branch,request);return request;
  };
}

export const readQianmuLatestRelease = createQianmuReleaseVersionReader();
