import {normalizeStoryboardContinuationLinks,storyboardContinuationIdentityInput,storyboardContinuationSavePending} from './qianmu-storyboard-continuation-proof.js?v=1.59.349';
import {normalizeStoryboardFloorTakeReceipts} from './qianmu-storyboard-floor-take-receipt.js?v=1.59.349';
import {storyboardFloorTakeSavePending} from './qianmu-storyboard-floor-take.js?v=1.59.349';
import {parseBoundedJson} from './qianmu-json-input.js';
import {assertPortableStoryboardData} from './qianmu-storyboard-package-security.js';
import {vibeDigest} from './qianmu-vibe-file.js';

export const GALLERY_CONTINUITY_FIELDS=Object.freeze(['storyboardContinuations','storyboardFloorTakeReceipts']);
export const GALLERY_SUPPLEMENT_FIELDS=Object.freeze(['storyboardCollections','characterDrafts',...GALLERY_CONTINUITY_FIELDS]);
const fail=()=>{throw Error('续写或换版依据不兼容，未截断、重建或猜补');};
export function galleryContinuitySavePending(store){return storyboardContinuationSavePending(store)||storyboardFloorTakeSavePending(store?.storyboardFloorTakeReceipts);}

// Keep the original JSON, including unknown portable fields. Normalization is
// validation only, never a replacement for the archived original. Prefix
// digests must still be checked against narrative by the eventual consumer.
export async function projectGalleryContinuity(value,owner){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!GALLERY_CONTINUITY_FIELDS.includes(key)))fail();
  const copy=parseBoundedJson(JSON.stringify(value),{maxBytes:2*1048576,maxDepth:28,maxNodes:100000,label:'分镜来源依据'});
  for(const key of GALLERY_CONTINUITY_FIELDS){if(!Object.hasOwn(copy,key))continue;
    const rows=key==='storyboardContinuations'?normalizeStoryboardContinuationLinks(copy[key]):normalizeStoryboardFloorTakeReceipts(copy[key]);
    for(const row of rows){if(row.chatKey!==owner?.chatKey)fail();
      if(key==='storyboardContinuations'&&(row.namespace!==owner?.namespace||await vibeDigest(storyboardContinuationIdentityInput(row))!==row.id))fail();}
  }
  await assertPortableStoryboardData(copy);return copy;
}

// Only disjoint or byte-equivalent facts merge. A later timestamp, same ID or
// larger counter alone never permits replacing an existing retirement/path.
export function mergeGalleryContinuity(before,incoming,equal){
  const saved={},conflicts=[],added={};
  for(const field of GALLERY_CONTINUITY_FIELDS){
    if(!Object.hasOwn(incoming,field))continue;
    const key=row=>field==='storyboardContinuations'?row.id:JSON.stringify([row.chatKey,row.messageKey,row.swipeId]);
    const rows=new Map((before[field]||[]).map(row=>[key(row),row]));added[field]=0;
    for(const row of incoming[field]){const id=key(row),old=rows.get(id);
      if(!old){rows.set(id,row);added[field]++;}
      else if(!equal(old,row))conflicts.push({field,id:row.id,reason:'different-source-evidence'});
    }
    saved[field]=[...rows.values()];
  }
  return {saved,conflicts,added};
}
