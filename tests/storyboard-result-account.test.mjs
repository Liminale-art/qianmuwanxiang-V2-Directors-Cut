import test from 'node:test';
import assert from 'node:assert/strict';
import {drainStoryboardDeliveries} from '../qianmu-storyboard-delivery-drain.js';
import {captureForeignAccountOriginals,persistStoryboardGatewayImage} from '../qianmu-storyboard-result-inbox.js';

const A='st-user:alice',B='st-user:bob',CHAT='shared-chat';
const original=()=>new Blob([Uint8Array.from([137,80,78,71])],{type:'image/png'});
const deferred=()=>{let resolve;return {promise:new Promise(yes=>{resolve=yes;}),resolve};};

function fixture(){
  let account=A,chat=CHAT,afterList=null,onFileSave=null,deleteError=null;
  const accounts=new Map([A,B].map(namespace=>[namespace,{gallery:[],taskStates:[],logs:[],pipelineLogs:[],shotPlans:[],chatMetadata:{},files:0,metadataSaves:0,settingsSaves:0}]));
  const pending=new Map(),blobs=new Map(),deleted=[];
  const key=(namespace,id)=>`${namespace}/${id}`;
  const blobStore={
    async putStoryboardPendingOriginals(id,metadata,images){pending.set(key(metadata.namespace,id),metadata);images.forEach((blob,index)=>blobs.set(`${key(metadata.namespace,id)}/${index}`,blob));},
    async listStoryboardDeliveries(namespace,chatKey){const rows=[...pending.values()].filter(row=>row.namespace===namespace&&row.chatKey===chatKey);if(afterList)await afterList();return rows;},
    async getStoryboardPendingImage(namespace,id,index){return blobs.get(`${key(namespace,id)}/${index}`);},
    async deleteStoryboardDelivery(id,namespace){
      if(deleteError){const error=deleteError;deleteError=null;throw error;}
      deleted.push(key(namespace,id));pending.delete(key(namespace,id));for(let i=0;i<8;i++)blobs.delete(`${key(namespace,id)}/${i}`);
    },
  };
  const env={
    resolveImageAccountNamespace:async()=>account,
    storyboardState:()=>accounts.get(account),ctx:()=>({chatMetadata:accounts.get(account).chatMetadata,chat:[]}),getChatKey:()=>chat,
    blobStore,storyboardVolatileDeliveries:new Map(),storyboardGalleryRecords:()=>accounts.get(account).gallery,
    storyboardFloorTakeReceipts:()=>[],storyboardUtilsModule:async()=>({saveBase64AsFile:async()=>{
      accounts.get(account).files++;if(onFileSave)await onFileSave();return '/user/images/pending.png';
    }}),storyboardBlobToBase64:async blob=>Buffer.from(await blob.arrayBuffer()).toString('base64'),
    storyboardSafeUrl:url=>url,storyboardImageExtension:()=>'.png',getCharacterName:()=> 'Alice',clone:structuredClone,
    resolveStoryboardMessageReference:()=>null,storyboardFloorTakeInitialInline:()=>false,hashText:()=>'',
    transitionStoryboardTaskState:(task,status,extra)=>({...task,status,...extra}),
    saveStoryboardFloorTakes:async(_gallery,save)=>save(),saveMetadata:async()=>{accounts.get(account).metadataSaves++;},
    storyboardValidatedAnchor:()=>({valid:false}),saveSettings:()=>{accounts.get(account).settingsSaves++;},
    storyboardScheduleInlineRender(){},rerenderIfOpen(){},toast(){},
  };
  return {accounts,pending,blobs,deleted,blobStore,env,key,
    changeAccount:value=>{account=value;},changeChat:value=>{chat=value;},afterList:value=>{afterList=value;},onFileSave:value=>{onFileSave=value;},
    failDeleteOnce:error=>{deleteError=error;}};
}

test('same chatKey under B cannot see or delete A originals; returning to A receives exactly once without a recipe',async()=>{
  const f=fixture(),job={id:'accepted-a',chatKey:CHAT,imageAccountNamespace:A,imageAdmission:{namespace:A},target:'gallery',
    logId:'reused-log',planId:'reused-plan',planShotId:'reused-shot',
    connection:{apiKey:'do-not-store'},prompt:'private narrative',payload:{negative:'private'}};
  const captured=await captureForeignAccountOriginals(job,[{data:'iVBORw==',mime:'image/png'}],f.blobStore);
  assert.equal(captured.durable,true);assert.equal(f.pending.size,1);
  const encoded=JSON.stringify([...f.pending.values()][0]);
  assert.doesNotMatch(encoded,/do-not-store|private narrative|private|apiKey|payload|connection|prompt/);
  f.changeAccount(B);assert.equal(await drainStoryboardDeliveries(CHAT,f.env),0);
  assert.equal(f.accounts.get(B).files,0);assert.equal(f.accounts.get(B).gallery.length,0);
  assert.equal(f.accounts.get(B).metadataSaves,0);assert.equal(f.accounts.get(B).settingsSaves,0);
  assert.equal(f.pending.size,1);assert.deepEqual(f.deleted,[]);
  // A different generation may reuse an id after the accepted result was held.
  const currentA=f.accounts.get(A);
  currentA.logs.push({id:job.logId,status:'generating',snapshot:{imageAccountNamespace:A}});
  currentA.taskStates.push({id:job.id,status:'generating'});
  currentA.shotPlans.push({id:job.planId,chatKey:CHAT,status:'generating',shots:[{id:job.planShotId,status:'generating'}]});
  f.changeAccount(A);assert.equal(await drainStoryboardDeliveries(CHAT,f.env),1);
  const row=f.accounts.get(A).gallery[0];assert.equal(row.recipeUnavailable,true);assert.equal(row.inline,false);
  assert.equal(row.imageAccountNamespace,A);
  for(const field of ['prompt','negative','payload','connection','snapshot','apiKey'])assert.equal(row[field],undefined,field);
  assert.equal(f.accounts.get(A).files,1);assert.equal(f.pending.size,0);assert.equal(f.blobs.size,0);
  assert.equal(currentA.logs[0].status,'generating');assert.equal(currentA.taskStates[0].status,'generating');
  assert.equal(currentA.shotPlans[0].shots[0].status,'generating');assert.equal(currentA.settingsSaves,0);
  assert.deepEqual(f.deleted,[f.key(A,job.id)]);
  assert.equal(await drainStoryboardDeliveries(CHAT,f.env),0);assert.equal(f.accounts.get(A).gallery.length,1);
});

test('same-account cross-chat pending record waits for its original chat and remains full-fidelity',async()=>{
  const f=fixture(),record={id:'same-account',url:'/user/images/saved.png',taskId:'normal',prompt:'existing A recipe',chatKey:CHAT,
    planId:'old-plan',planShotId:'old-shot',imageIndex:0};
  f.pending.set(f.key(A,'normal'),{namespace:A,taskId:'normal',chatKey:CHAT,target:'gallery',planId:'old-plan',shotId:'old-shot',records:[record]});
  const recycled={id:'normal',chatKey:CHAT,planId:'new-plan',shotId:'new-shot',status:'completed',deliveryState:'pending_chat',resultIds:['unrelated']};
  f.accounts.get(A).taskStates.push(recycled);
  f.changeChat('other-chat');await assert.rejects(drainStoryboardDeliveries(CHAT,f.env),/聊天已变化/);
  assert.equal(f.accounts.get(A).gallery.length,0);assert.equal(f.pending.size,1);
  f.changeChat(CHAT);assert.equal(await drainStoryboardDeliveries(CHAT,f.env),1);
  assert.equal(f.accounts.get(A).gallery[0].prompt,'existing A recipe');assert.equal(f.pending.size,0);
  assert.equal(f.accounts.get(A).taskStates[0].deliveryState,'pending_chat');assert.equal(f.accounts.get(A).settingsSaves,0);
});

test('same-account pending task updates only when its frozen image ids and origin match',async()=>{
  const f=fixture(),record={id:'frozen-image',url:'/user/images/saved.png',taskId:'original-task',chatKey:CHAT,
    planId:'original-plan',planShotId:'original-shot',imageIndex:0};
  f.pending.set(f.key(A,'original-task'),{namespace:A,taskId:'original-task',chatKey:CHAT,target:'gallery',
    planId:'original-plan',shotId:'original-shot',records:[record]});
  f.accounts.get(A).taskStates.push({id:'original-task',chatKey:CHAT,planId:'original-plan',shotId:'original-shot',
    status:'completed',deliveryState:'pending_chat',resultIds:['frozen-image']});
  assert.equal(await drainStoryboardDeliveries(CHAT,f.env),1);
  assert.equal(f.accounts.get(A).taskStates[0].deliveryState,'delivered');
  assert.equal(f.accounts.get(A).settingsSaves,1);
});

test('remote original is materialized as bounded Blob, never stored as an external URL',async()=>{
  const f=fixture(),job={id:'remote',chatKey:CHAT,imageAccountNamespace:A,target:'gallery'};
  const captured=await captureForeignAccountOriginals(job,[{url:'https://provider.invalid/original.png'}],f.blobStore,
    {fetchImpl:async()=>new Response(original(),{headers:{'content-type':'image/png'}})});
  assert.equal(captured.durable,true);
  assert.equal(f.pending.get(f.key(A,'remote')).url,undefined);
  assert.equal(f.blobs.get(`${f.key(A,'remote')}/0`).size,4);
});

test('more than eight returned originals are rejected before any inbox write with a provider-check hint',async()=>{
  const f=fixture(),job={id:'too-many',chatKey:CHAT,imageAccountNamespace:A,target:'gallery'};
  await assert.rejects(captureForeignAccountOriginals(job,Array.from({length:9},()=>({data:'iVBORw==',mime:'image/png'})),f.blobStore),
    /超过 8 张.*原生图渠道核对/);
  assert.equal(f.pending.size,0);assert.equal(f.blobs.size,0);
});

test('switching ST account during utils or Comfy filename preparation never calls the ST file writer',async()=>{
  for(const phase of ['utils','filename']){
    let account=A,writes=0;const entered=deferred(),release=deferred();
    const options={requireLocal:phase==='filename',utilsModule:async()=>{
      if(phase==='utils'){entered.resolve();await release.promise;}
      return {saveBase64AsFile:async()=>{writes++;return '/user/images/forbidden.png';}};
    },comfyFilename:async()=>{entered.resolve();await release.promise;return 'comfy.png';},
    assertOwner:async()=>{if(account!==A)throw Error('account changed');},safeUrl:value=>value,
    toBase64:async()=>'',characterName:()=> 'Alice',fetchImpl:async()=>assert.fail('no fetch'),origin:'https://st.invalid'};
    const job={source:phase==='filename'?'comfy':'novel'};
    const running=persistStoryboardGatewayImage({data:'aW1hZ2U=',mime:'image/png'},job,0,options);
    await entered.promise;account=B;release.resolve();await assert.rejects(running,/account changed/);
    assert.equal(writes,0,phase);
  }
});

test('switching account after fetched Blob conversion never calls the ST file writer',async()=>{
  let account=A,writes=0;const entered=deferred(),release=deferred();
  const url='https://provider.invalid/original.png';
  const running=persistStoryboardGatewayImage({url}, {source:'novel'},0,{
    utilsModule:async()=>({saveBase64AsFile:async()=>{writes++;return '/user/images/forbidden.png';}}),
    comfyFilename:async()=>assert.fail('not Comfy'),assertOwner:async()=>{if(account!==A)throw Error('account changed');},
    safeUrl:value=>value,toBase64:async()=>{entered.resolve();await release.promise;return 'iVBORw==';},
    characterName:()=> 'Alice',fetchImpl:async()=>new Response(original(),{headers:{'content-type':'image/png'}}),origin:'https://st.invalid',
  });
  await entered.promise;account=B;release.resolve();assert.equal(await running,url);assert.equal(writes,0);
});

test('A-to-B switch during inbox read fails closed without touching either gallery or deleting A metadata',async()=>{
  const f=fixture();f.pending.set(f.key(A,'read'),{namespace:A,taskId:'read',chatKey:CHAT,target:'gallery',records:[{id:'read',url:'/saved.png'}]});
  f.afterList(()=>{f.changeAccount(B);});
  await assert.rejects(drainStoryboardDeliveries(CHAT,f.env),/账户或聊天已变化/);
  for(const namespace of [A,B])assert.equal(f.accounts.get(namespace).gallery.length,0);
  assert.equal(f.pending.size,1);assert.deepEqual(f.deleted,[]);
});

test('missing second original rolls back first staged gallery row and preserves A inbox for retry',async()=>{
  const f=fixture(),id='partial';f.pending.set(f.key(A,id),{namespace:A,taskId:id,chatKey:CHAT,target:'gallery',imageCount:2,originalOnly:true});
  f.blobs.set(`${f.key(A,id)}/0`,original());
  await assert.rejects(drainStoryboardDeliveries(CHAT,f.env),/原图缺失/);
  assert.equal(f.accounts.get(A).gallery.length,0);assert.equal(f.accounts.get(A).metadataSaves,0);assert.equal(f.accounts.get(A).files,0);
  assert.equal(f.pending.size,1);assert.equal(f.blobs.size,1);assert.deepEqual(f.deleted,[]);
});

test('failed inbox delete after saved metadata retries without writing the same ST original twice',async()=>{
  const f=fixture(),id='delete-retry';
  f.pending.set(f.key(A,id),{namespace:A,taskId:id,chatKey:CHAT,target:'gallery',imageCount:1,originalOnly:true});
  f.blobs.set(`${f.key(A,id)}/0`,original());
  f.failDeleteOnce(new Error('temporary IDB failure'));
  assert.equal(await drainStoryboardDeliveries(CHAT,f.env),1);
  assert.equal(f.accounts.get(A).files,1);assert.equal(f.accounts.get(A).metadataSaves,1);
  assert.equal(f.accounts.get(A).gallery.length,1);assert.equal(f.pending.size,1);
  // The persisted gallery is authoritative even when its old inbox Blob is missing.
  f.blobs.delete(`${f.key(A,id)}/0`);
  assert.equal(await drainStoryboardDeliveries(CHAT,f.env),0);
  assert.equal(f.accounts.get(A).files,1);assert.equal(f.accounts.get(A).gallery.length,1);
  assert.equal(f.pending.size,0);assert.deepEqual(f.deleted,[f.key(A,id)]);
});

test('original-only gallery ID collisions from another account or chat fail closed before ST file writes',async()=>{
  for(const mismatch of ['account','chat']){
    const f=fixture(),id=`collision-${mismatch}`;
    f.pending.set(f.key(A,id),{namespace:A,taskId:id,chatKey:CHAT,target:'gallery',imageCount:1,originalOnly:true});
    f.blobs.set(`${f.key(A,id)}/0`,original());
    f.accounts.get(A).gallery.push({id:`pending-${id}-0`,taskId:id,chatKey:mismatch==='chat'?'other-chat':CHAT,
      imageAccountNamespace:mismatch==='account'?B:A,imageIndex:0,origin:'service_recovered',recipeUnavailable:true,url:'/saved.png'});
    await assert.rejects(drainStoryboardDeliveries(CHAT,f.env),/原图与图库记录来源冲突/);
    assert.equal(f.accounts.get(A).files,0,mismatch);assert.equal(f.accounts.get(A).metadataSaves,0,mismatch);
    assert.equal(f.accounts.get(A).gallery.length,1,mismatch);assert.equal(f.pending.size,1,mismatch);
    assert.deepEqual(f.deleted,[],mismatch);
  }
});

test('full-recipe ID collision with another result fails closed and preserves inbox',async()=>{
  const variants={taskId:'different-task',chatKey:'other-chat',planId:'other-plan',planShotId:'other-shot',
    imageIndex:1,url:'/another.png'};
  for(const [field,value] of Object.entries(variants)){
    const f=fixture(),id='recipe-collision',record={id:'same-image-id',taskId:id,chatKey:CHAT,
      planId:'plan',planShotId:'shot',imageIndex:0,url:'/saved.png'};
    f.pending.set(f.key(A,id),{namespace:A,taskId:id,chatKey:CHAT,target:'gallery',planId:'plan',shotId:'shot',records:[record]});
    f.accounts.get(A).gallery.push({...record,[field]:value});
    await assert.rejects(drainStoryboardDeliveries(CHAT,f.env),/分镜与图库记录来源冲突/,field);
    assert.equal(f.accounts.get(A).gallery.length,1,field);assert.equal(f.accounts.get(A).metadataSaves,0,field);
    assert.equal(f.pending.size,1,field);assert.deepEqual(f.deleted,[],field);
  }
});

test('exact full-recipe record already in the same account and chat clears only its stale inbox',async()=>{
  const f=fixture(),id='recipe-retry',record={id:'known-image-id',taskId:id,chatKey:CHAT,
    planId:'plan',planShotId:'shot',imageIndex:0,url:'/saved.png'};
  f.accounts.get(A).gallery.push({...record});
  f.pending.set(f.key(A,id),{namespace:A,taskId:id,chatKey:CHAT,target:'gallery',planId:'plan',shotId:'shot',records:[record]});
  assert.equal(await drainStoryboardDeliveries(CHAT,f.env),0);
  assert.equal(f.accounts.get(A).gallery.length,1);assert.equal(f.pending.size,0);
  assert.deepEqual(f.deleted,[f.key(A,id)]);
});

test('malformed full-recipe inbox rows fail closed before any other pending original is written',async()=>{
  const variants=[[],[{id:'',taskId:'recipe',chatKey:CHAT,planId:'plan',planShotId:'shot',imageIndex:0,url:'/saved.png'}],
    [{id:'image',taskId:'recipe',chatKey:CHAT,planId:'plan',planShotId:'shot',imageIndex:0,url:'/saved.png'},
      {id:'image',taskId:'recipe',chatKey:CHAT,planId:'plan',planShotId:'shot',imageIndex:1,url:'/other.png'}],
    [{id:'first',taskId:'recipe',chatKey:CHAT,planId:'plan',planShotId:'shot',imageIndex:0,url:'/first.png'},
      {id:'second',taskId:'recipe',chatKey:CHAT,planId:'plan',planShotId:'shot',imageIndex:0,url:'/second.png'}],
    [{id:'gap',taskId:'recipe',chatKey:CHAT,planId:'plan',planShotId:'shot',imageIndex:1,url:'/gap.png'}],
    [{id:'image',taskId:'wrong',chatKey:CHAT,planId:'plan',planShotId:'shot',imageIndex:0,url:'/saved.png'}],
    [{id:'image',taskId:'recipe',chatKey:'other-chat',planId:'plan',planShotId:'shot',imageIndex:0,url:'/saved.png'}]];
  for(const rows of variants){
    const f=fixture(),id='original';
    f.pending.set(f.key(A,id),{namespace:A,taskId:id,chatKey:CHAT,target:'gallery',imageCount:1,originalOnly:true});
    f.blobs.set(`${f.key(A,id)}/0`,original());
    f.pending.set(f.key(A,'recipe'),{namespace:A,taskId:'recipe',chatKey:CHAT,target:'gallery',planId:'plan',shotId:'shot',records:rows});
    await assert.rejects(drainStoryboardDeliveries(CHAT,f.env),/记录缺失|记录不完整或重复|序号不完整/);
    assert.equal(f.accounts.get(A).files,0);assert.equal(f.accounts.get(A).metadataSaves,0);
    assert.equal(f.accounts.get(A).gallery.length,0);assert.equal(f.pending.size,2);assert.deepEqual(f.deleted,[]);
  }
});

test('pending full-recipe ID cannot shadow an original-only result in the same drain batch',async()=>{
  const f=fixture(),id='original';
  f.pending.set(f.key(A,id),{namespace:A,taskId:id,chatKey:CHAT,target:'gallery',imageCount:1,originalOnly:true});
  f.blobs.set(`${f.key(A,id)}/0`,original());
  f.pending.set(f.key(A,'recipe'),{namespace:A,taskId:'recipe',chatKey:CHAT,target:'gallery',planId:'plan',shotId:'shot',
    records:[{id:`pending-${id}-0`,taskId:'recipe',chatKey:CHAT,planId:'plan',planShotId:'shot',imageIndex:0,url:'/recipe.png'}]});
  await assert.rejects(drainStoryboardDeliveries(CHAT,f.env),/编号冲突/);
  assert.equal(f.accounts.get(A).files,0);assert.equal(f.accounts.get(A).gallery.length,0);
  assert.equal(f.pending.size,2);assert.deepEqual(f.deleted,[]);
});

test('a subset of frozen task result IDs preserves its inbox without claiming a complete delivery',async()=>{
  const f=fixture(),id='partial-frozen',record={id:'first-image',taskId:id,chatKey:CHAT,
    planId:'plan',planShotId:'shot',imageIndex:0,url:'/first.png'};
  f.pending.set(f.key(A,id),{namespace:A,taskId:id,chatKey:CHAT,target:'gallery',planId:'plan',shotId:'shot',records:[record]});
  f.accounts.get(A).taskStates.push({id,chatKey:CHAT,planId:'plan',shotId:'shot',status:'completed',
    deliveryState:'pending_chat',resultIds:['first-image','second-image']});
  await assert.rejects(drainStoryboardDeliveries(CHAT,f.env),/图片清单不一致/);
  assert.equal(f.accounts.get(A).gallery.length,0);assert.equal(f.accounts.get(A).taskStates[0].deliveryState,'pending_chat');
  assert.equal(f.accounts.get(A).metadataSaves,0);assert.equal(f.accounts.get(A).settingsSaves,0);assert.equal(f.pending.size,1);
});

test('A-to-B switch after ST file call suppresses B gallery, metadata, log and task writes',async()=>{
  const f=fixture(),id='file-gate',state=f.accounts.get(A);state.logs.push({id:'log',snapshot:{imageAccountNamespace:A}});
  state.taskStates.push({id,status:'generating'});
  f.pending.set(f.key(A,id),{namespace:A,taskId:id,chatKey:CHAT,target:'gallery',imageCount:1,originalOnly:true,logId:'log'});
  f.blobs.set(`${f.key(A,id)}/0`,original());
  const entered=deferred(),release=deferred();f.onFileSave(async()=>{entered.resolve();await release.promise;});
  const receive=drainStoryboardDeliveries(CHAT,f.env);await entered.promise;f.changeAccount(B);release.resolve();
  await assert.rejects(receive,/账户或聊天已变化/);
  assert.equal(f.accounts.get(B).gallery.length,0);assert.equal(f.accounts.get(B).metadataSaves,0);
  assert.equal(f.accounts.get(B).settingsSaves,0);assert.equal(f.accounts.get(B).taskStates.length,0);
  assert.equal(f.pending.size,1);assert.deepEqual(f.deleted,[]);
});

test('actual inbox API uses account-scoped metadata keys and separate bounded image payloads',async t=>{
  const savedIndex=globalThis.indexedDB,savedRange=globalThis.IDBKeyRange,stores=new Map();
  const database={objectStoreNames:{contains:name=>stores.has(name)},createObjectStore:name=>{stores.set(name,new Map());},
    transaction:name=>{
      const data=stores.get(name),tx={pending:0,done:false,oncomplete:null,onerror:null,onabort:null};
      const complete=()=>setTimeout(()=>{if(!tx.pending&&!tx.done){tx.done=true;tx.oncomplete?.();}},0);
      const request=action=>{tx.pending++;const req={};setTimeout(()=>{try{req.result=action();req.onsuccess?.();}catch(error){req.error=error;req.onerror?.();tx.onerror?.();}
        tx.pending--;complete();},0);return req;};
      tx.objectStore=()=>({
        put:(value,key)=>request(()=>{data.set(key,structuredClone(value));return key;}),
        get:key=>request(()=>structuredClone(data.get(key))),
        delete:key=>request(()=>data.delete(key)),
        openCursor:range=>{
          const keys=[...data.keys()].filter(key=>key>=range.lower&&key<=range.upper).sort(),req={};let index=0;tx.pending++;
          const step=()=>setTimeout(()=>{if(index>=keys.length){req.result=null;req.onsuccess?.();tx.pending--;complete();return;}
            const key=keys[index++];req.result={key,value:structuredClone(data.get(key)),continue:step};req.onsuccess?.();},0);
          step();return req;
        },
      });return tx;
    }};
  globalThis.indexedDB={open:()=>{const req={result:database};setTimeout(()=>{req.onupgradeneeded?.();req.onsuccess?.();},0);return req;}};
  globalThis.IDBKeyRange={bound:(lower,upper)=>({lower,upper})};
  t.after(()=>{globalThis.indexedDB=savedIndex;globalThis.IDBKeyRange=savedRange;});
  const store=await import(`../qianmu-blobstore.js?account-inbox-${Date.now()}`),row=namespace=>({namespace,taskId:'same',chatKey:CHAT,
    imageCount:1,originalOnly:true,target:'gallery',prompt:'must be discarded',connection:{apiKey:'secret'}});
  await store.putStoryboardPendingOriginals('same',row(A),[original()]);
  await store.putStoryboardPendingOriginals('same',row(B),[original()]);
  const alice=await store.listStoryboardDeliveries(A,CHAT),bob=await store.listStoryboardDeliveries(B,CHAT);
  assert.equal(alice.length,1);assert.equal(bob.length,1);
  assert.equal(alice[0].namespace,A);assert.equal(bob[0].namespace,B);
  assert.equal(alice[0].prompt,undefined);assert.equal(alice[0].connection,undefined);
  const raw=stores.get('storyboard_inbox');assert.equal(raw.size,4);
  assert.ok([...raw.keys()].filter(key=>key.startsWith('m:')).length===2);
  assert.equal((await store.getStoryboardPendingImage(A,'same',0)).size,4);
  await store.deleteStoryboardDelivery('same',B);
  assert.equal((await store.listStoryboardDeliveries(B,CHAT)).length,0);
  assert.equal((await store.listStoryboardDeliveries(A,CHAT)).length,1);
  assert.equal((await store.getStoryboardPendingImage(A,'same',0)).size,4);
  await store.deleteStoryboardDelivery('same',A);
  assert.equal(raw.size,0);
  for(let index=0;index<8;index++)await store.putStoryboardPendingOriginals(`cap-${index}`,{...row(A),taskId:`cap-${index}`},[original()]);
  await assert.rejects(store.putStoryboardPendingOriginals('cap-8',{...row(A),taskId:'cap-8'},[original()]),/已达 8 项/);
  assert.equal((await store.listStoryboardDeliveries(A,CHAT)).length,8);
  assert.equal((await store.listStoryboardDeliveries(B,CHAT)).length,0);
});
