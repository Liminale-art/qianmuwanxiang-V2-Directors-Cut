import {createLocalVibeAssetStore} from './qianmu-vibe-asset-store.js';
import {createLocalVibeEncodingStore,validateVibeEncodingIdentity} from './qianmu-vibe-encoding-store.js';
import {parseNovelVibeFile,appendNovelVibeEncoding,vibeFileError} from './qianmu-vibe-file.js';

// Capture an account-bound local return sink BEFORE charging. This is not a
// native-storage error fallback: every newly submitted encoding uses the sink.
// A late paid result can be retained without any request to the newly logged-in
// account. The ordinary native reader later preserves these exact new originals.
export async function createVibeEncodingRetention({namespace,id,identity,cacheKey,attemptId,guard,readSource,
  createAssets=createLocalVibeAssetStore,createReceipts=createLocalVibeEncodingStore}={}){
  const bound=structuredClone({namespace,id,identity,cacheKey,attemptId});
  const fail=()=>{throw vibeFileError('retention','Vibe编码保全记录已变化，未继续提交');};
  if(typeof guard!=='function'||typeof readSource!=='function')fail();
  await validateVibeEncodingIdentity(bound.identity,bound.cacheKey);await guard();
  const assets=createAssets(),receipts=createReceipts();let closed=false,used=false;
  const close=()=>{closed=true;assets.close();receipts.close();};
  const checked=async status=>{if(closed)fail();const row=await receipts.get(bound.namespace,bound.cacheKey);
    if(!row||row.attemptId!==bound.attemptId||row.status!==status||JSON.stringify(row.identity)!==JSON.stringify(bound.identity)
      ||row.sourceAssetRef?.namespace!==bound.namespace||row.sourceAssetRef?.id!==bound.id)fail();return row;};
  try{
    await checked('reserved');await guard();
    const text=await readSource({namespace:bound.namespace,id:bound.id});await guard();
    const parsed=await parseNovelVibeFile(text),source=parsed[0];
    if(parsed.length!==1||source.assetId!==bound.id||source.document.type!=='image'||source.document.id!==bound.identity.sourceId)fail();
    await checked('reserved');await guard();
    await assets.putFile(bound.namespace,source.serialized);await guard();
    return Object.freeze({close,async retain(encoding){
      if(used||closed)fail();used=true;
      await checked('submitting');
      const next=await appendNovelVibeEncoding(source.document,bound.identity.capabilityModelId,bound.identity.parameters.information_extracted,encoding);
      // Only immutable local asset bytes are written after the original account
      // goes away. Never relax the remote account guard to save a late response.
      const [head]=await assets.putFile(bound.namespace,next.serialized),assetRef={version:1,namespace:bound.namespace,id:head.assetId};
      await receipts.transition(bound.namespace,bound.cacheKey,bound.attemptId,'ready',{assetRef});return assetRef;
    }});
  }catch(error){close();throw error;}
}
