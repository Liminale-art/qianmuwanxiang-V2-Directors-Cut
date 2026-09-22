import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {galleryOriginalHttpFixture,originalPng} from './gallery-original-http-fixture.mjs';
import {streamCheckpointTransport} from './stream-checkpoint-fixture.mjs';
import {createCurrentGalleryArchiveSession} from '../../qianmu-gallery-archive-source.js';
import {createGalleryArchiveStorage} from '../../qianmu-gallery-archive-storage.js';
import {chatGalleryDigest} from '../../qianmu-chat-gallery-digest.js';
import {prepareCurrentGalleryRestore} from '../../qianmu-gallery-restore-runtime.js';
import {createGalleryRestorePlanStorage} from '../../qianmu-gallery-restore-plan.js';
import {openPreparedGallerySource} from '../../qianmu-gallery-prepared-source.js';
import {createPreparedGalleryAssets} from '../../qianmu-gallery-restore-assets.js';

export async function galleryPreparedAssetsFixture(t,{count=3,serverRecipe=true,recordBytes=0}={}){
  const host=await galleryOriginalHttpFixture(t),transport=streamCheckpointTransport(host.account),calls=[],state={active:true,hook:null};
  const own=resource=>{t.after(()=>resource.close());return resource;};
  host.context.chat.push({mes:'fixture narrative',name:'Alice',is_user:false});
  const rows=Array.from({length:count},(_,index)=>({...structuredClone(host.rows[0]),id:'record-'+index,createdAt:index,future:{keep:[null,false,0,''],...(recordBytes?{text:'x'.repeat(recordBytes)}:{})}})).reverse();
  const store=host.context.chatMetadata.story_director_liminale;store.storyboardImages=rows;
  const save=()=>fs.writeFile(host.file,[JSON.stringify({chat_metadata:host.context.chatMetadata}),...host.context.chat.map(m=>JSON.stringify(m))].join('\n')+'\n');await save();
  const target={kind:'character',avatar:'Alice.png',chatId:'chat'};let recipePath;
  if(serverRecipe&&rows.length){
    const row=rows[0],saved=await host.service.preserve(host.req,{version:1,expectedAccount:host.expectedAccount,target,
      selection:{recordId:row.id,createdAt:row.createdAt,gallerySha256:chatGalleryDigest(rows).sha256}});
    row.snapshotServerRef=saved.reference;delete row.snapshot;recipePath=path.join(host.req.user.directories.root,'.qianmu-recipes-v1',saved.reference.id+'.json');await save();
  }
  const fetchImpl=async(url,options)=>{assert.ok(url.startsWith('/api/plugins/qianmu-tts/'));calls.push({url,options});
    if(state.hook){const response=await state.hook(url,options);if(response)return response;}
    return fetch(host.origin+url.slice('/api/plugins/qianmu-tts'.length),options);
  };
  const options={getContext:()=>host.context,epoch:()=>0,account:async()=>host.account,headers:host.context.getRequestHeaders,
    guard:()=>state.active,isCurrent:()=>state.active,canPrepare:()=>true,createStorage:transport.createStorage,fetchImpl};
  const session=own(await createCurrentGalleryArchiveSession(options)),saved=await session.preserveAll();session.close();
  assert.equal(saved.originals.state,'complete');assert.equal(saved.evidences.state,'complete');
  const selection={schema:'qianmu.gallery.source-version.v3',scope:session.scope,sourceReceipt:saved.sourceReceipt,manifest:saved.reference,supplement:saved.supplement,evidence:saved.evidence};
  const archive=own(await createGalleryArchiveStorage({scope:session.scope,guard:()=>state.active,verifyRecord:()=>false,createStorage:transport.createStorage}));
  store.storyboardImages=[];await save();
  const prepared=await prepareCurrentGalleryRestore({...options,selection,archive});assert.equal(prepared.compatible,true);
  const planStorage=own(await createGalleryRestorePlanStorage({scope:session.scope,guard:()=>state.active,createStorage:transport.createStorage}));
  const source=own(await openPreparedGallerySource({reference:prepared.reference,planStorage,archive,guard:()=>state.active}));
  const originalFile=await fs.readFile(host.file),live=JSON.stringify(host.context.chatMetadata);
  const verifyCurrent=async()=>state.active&&JSON.stringify(host.context.chatMetadata)===live&&(await fs.readFile(host.file)).equals(originalFile);
  return {...host,rows,store,transport,calls,state,selection,archive,planStorage,prepared,source,options,recipePath,save,originalFile,live,png:originalPng,own,
    open:extra=>own(createPreparedGalleryAssets({source,account:options.account,headers:options.headers,guard:options.guard,verifyCurrent,fetchImpl,...extra})),
  };
}
