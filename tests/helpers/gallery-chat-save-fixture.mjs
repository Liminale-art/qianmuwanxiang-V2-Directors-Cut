import {galleryPreparedAssetsFixture} from './gallery-prepared-assets-fixture.mjs';
import {createGalleryWritePlanStorage} from '../../qianmu-gallery-write-plan.js';
import {resolvePreparedGalleryWrite} from '../../qianmu-gallery-resolved-write.js';
import {createNativeHistoricalJournal} from '../../qianmu-historical-journal-native.js';
import {createPagedGallerySaveSession} from '../../qianmu-gallery-chat-save.js';

export const pagedConsent={confirmed:true,scope:'paged-gallery-current-chat'};
export const gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
export async function galleryChatSaveFixture(t,options={}){
  const f=await galleryPreparedAssetsFixture(t,options),guard=f.options.guard,source=f.source;
  const writeStorage=f.own(await createGalleryWritePlanStorage({scope:f.selection.scope,guard,createStorage:f.transport.createStorage}));
  const assets=f.open(),preview=await assets.preview();
  const resolved=await resolvePreparedGalleryWrite({source,assets,writeStorage,preview,confirmed:true,guard,verifyCurrent:()=>JSON.stringify(f.context.chatMetadata)===f.live});
  const journal=()=>f.own(createNativeHistoricalJournal({createStorage:f.transport.createStorage,legacy:{loadHistoricalChatMutation:async()=>null,loadMutation:async()=>null,list:async()=>[],loadResource:async()=>null,close(){}}}));
  let saves=0,host=()=>f.save();f.context.saveMetadata=()=>{saves++;return host();};
  return {...f,resolved,writeStorage,journal,get saves(){return saves;},set host(value){host=value;},
    openWriter:extra=>f.own(createPagedGallerySaveSession({...f.options,source,writeStorage,writeReference:resolved.reference,journal:journal(),hostTimeoutMs:100,...extra})),
  };
}
