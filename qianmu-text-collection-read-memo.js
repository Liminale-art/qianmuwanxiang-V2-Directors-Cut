// Ephemeral, account-scope-owned browsing acceleration. Never persistent, never
// used by a writer or backup, and never a substitute for the caller's guards.
// The byte budget counts serialized UTF-16 + keys, NOT a browser heap metric.
export const COLLECTION_READ_MEMO_LIMITS=Object.freeze({originals:16,bytes:2*1024*1024,searches:4,ttlMs:60000});
export function createCollectionReadMemo({now=Date.now}={}){
  const limits=COLLECTION_READ_MEMO_LIMITS,originals=new Map();let bytes=0,searches=new WeakMap();
  const valid=at=>now()>=at&&now()-at<limits.ttlMs;
  const key=row=>JSON.stringify(row); // includes the entire verified descriptor, not only its body hash
  const remove=id=>{const item=originals.get(id);if(item){bytes-=item.bytes;originals.delete(id);}};
  const prune=()=>{for(const [id,item]of originals)if(!valid(item.at))remove(id);};
  return Object.freeze({
    getOriginal(row){prune();const id=key(row),item=originals.get(id);if(!item)return null;
      originals.delete(id);originals.set(id,item);return item.entry;},
    rememberOriginal(row,entry){
      prune();const id=key(row),size=2*(JSON.stringify(entry).length+id.length)+256;remove(id);if(size>limits.bytes)return;
      while(originals.size>=limits.originals||bytes+size>limits.bytes)remove(originals.keys().next().value);
      // OriginalStore returns recursively frozen validated entries. Keep exactly
      // that verified version, without another complete text copy or mutation.
      originals.set(id,{entry,bytes:size,at:now()});bytes+=size;
    },
    getSearch(state,term){const pool=searches.get(state),item=pool?.get(term);if(!item)return null;
      if(!valid(item.at)){pool.delete(term);return null;}pool.delete(term);pool.set(term,item);return item.indices.slice();},
    getCandidates(state,term){let best=null;const pool=searches.get(state);
      for(const [prior,item]of pool||[]){if(!valid(item.at)){pool.delete(prior);continue;}
        if(prior&&term.includes(prior)&&(!best||item.indices.length<best.length))best=item.indices;}
      // With literal substring matching, a longer term cannot match any entry
      // proven negative for its shorter substring. Never infer from a preview.
      return best?.slice()||null;},
    rememberSearch(state,term,indices){
      let pool=searches.get(state);if(!pool){searches=new WeakMap();pool=new Map();searches.set(state,pool);}
      pool.delete(term);while(pool.size>=limits.searches)pool.delete(pool.keys().next().value);
      // At most four complete match sets for ONE exact index object. Only live
      // positions are retained (<= 4 * 10000 * 4 bytes), never search text bodies.
      pool.set(term,{indices:Uint32Array.from(indices),at:now()});
    },
    clear(){originals.clear();bytes=0;searches=new WeakMap();},
  });
}
