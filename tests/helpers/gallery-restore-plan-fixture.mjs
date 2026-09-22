import assert from 'node:assert/strict';
import {chatEvidenceFixture} from './chat-evidence-fixture.mjs';
import {streamCheckpointTransport} from './stream-checkpoint-fixture.mjs';
import {createCurrentGalleryArchiveSession} from '../../qianmu-gallery-archive-source.js';
import {createGalleryArchiveStorage} from '../../qianmu-gallery-archive-storage.js';
import {createGalleryRestoreSource} from '../../qianmu-gallery-restore-source.js';
import {chatCharacterReceiptErrorPayload} from '../../qianmu-chat-character-receipt.js';

export async function galleryRestorePlanFixture(t,{count=3,large=false}={}){
  const host=await chatEvidenceFixture(t),transport=streamCheckpointTransport('st-user:alice'),calls=[];
  let active=true,epoch=0;
  const rows=Array.from({length:count},(_,i)=>({id:'r'+i,createdAt:i,url:'/user/images/r.png',tags:[],snapshot:{prompt:'original '+i},future:large?'x'.repeat(450000):{keep:[false,0,null,'']}})).reverse();
  if(rows.length>2)[rows[0],rows[1]]=[rows[1],rows[0]];
  const store={storyboardImages:rows,storyboardCollections:[{id:'album',name:'原合集',future:false}]};
  const context={chatId:host.target.chatId,characterId:0,characters:[{avatar:'Alice.png',chat:host.target.chatId}],chat:structuredClone(host.messages),chatMetadata:{story_director_liminale:store},getRequestHeaders:()=>({'X-CSRF-Token':'fixture'})};
  const save=()=>host.write({header:{chat_metadata:context.chatMetadata},body:context.chat});
  const fetchImpl=async(url,options)=>{
    calls.push({url,method:options.method});const method={'receipt':'inspectGallery','supplement':'readGallerySupplement','evidence-source':'readGalleryEvidenceSource'}[url.split('/').at(-1)];
    assert.ok(method,'only complete read-only source endpoints allowed: '+url);
    try{return Response.json(await host.service[method](host.req,JSON.parse(options.body),{signal:options.signal}));}
    catch(error){const result=chatCharacterReceiptErrorPayload(error);return Response.json(result.body,{status:result.status});}
  };
  const options={getContext:()=>context,epoch:()=>epoch,account:async()=>'st-user:alice',headers:context.getRequestHeaders,guard:()=>active,isCurrent:()=>active,canPrepare:()=>true,fetchImpl,createStorage:transport.createStorage};
  const own=resource=>{t.after(()=>resource.close());return resource;};
  await save();const session=own(await createCurrentGalleryArchiveSession({...options,preserveOriginals:false})),result=await session.preserveAll();
  assert.equal(result.supplements.state,'complete');assert.equal(result.evidences.state,'complete');
  const selection={schema:'qianmu.gallery.source-version.v3',scope:session.scope,sourceReceipt:result.sourceReceipt,manifest:result.reference,supplement:result.supplement,evidence:result.evidence};
  session.close();
  const archive=own(await createGalleryArchiveStorage({scope:selection.scope,guard:()=>active,verifyRecord:()=>false,createStorage:transport.createStorage}));
  return {host,transport,calls,context,store,rows,save,selection,archive,options,own,
    async source(){return own(await createGalleryRestoreSource({selection,archive,guard:()=>active}));},
    stop(){active=false;},switchChat(){epoch++;},
  };
}
