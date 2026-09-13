// Native IndexedDB on an isolated origin. No ST data, provider access or paid jobs.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true});
const context=await browser.newContext(),errors=[],checks=[];let external=0;
const ok=(name,value)=>{assert.ok(value,name);checks.push(name);};
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.origin==='https://qianmu.test'&&url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Isolated delivery journal QA</title>'});
  if(url.origin==='https://qianmu.test'&&/^\/qianmu-[a-z0-9-]+\.js$/.test(url.pathname))return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('..'+url.pathname,import.meta.url))});
  external++;return route.abort();
});
async function openPage(){
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto('https://qianmu.test/');
  await page.evaluate(async()=>{
    const {createComfyDeliveryStore}=await import('/qianmu-comfy-delivery-store.js');
    const {bindComfyCloudProtocol,bindComfyCloudTask}=await import('/qianmu-comfy-cloud-protocol.js');
    window.makeStore=()=>createComfyDeliveryStore({dbName:'qianmu-delivery-browser-synthetic'});
    window.store=makeStore();window.ns='st-user:synthetic';
    window.connection=bindComfyCloudProtocol('https://cloud.comfy.org','comfy-cloud-v2');
    window.task=bindComfyCloudTask(connection,'original',{self:'/api/v2/jobs/original',cancel:'/api/v2/jobs/original/cancel'});
    window.native={version:1,namespace:ns,attemptId:'native',baseUrl:'https://native.test',createdAt:1,status:'prepared',imageCount:0,files:[]};
    window.cloud={...native,version:3,attemptId:'cloud',baseUrl:connection.origin,cloudConnection:connection};
    window.accepted={...cloud,cloudTask:task,taskLocator:{version:1,channelKey:'b'.repeat(64)}};
    window.available={...accepted,status:'available',imageCount:2,receipt:'a'.repeat(64)};
    window.partial={...available,files:[{imageIndex:0,url:'/user/images/first.png'}]};
    window.complete={...partial,status:'archived',files:[...partial.files,{imageIndex:1,url:'/user/images/second.png'}]};
    window.rejects=async action=>{try{await action();return false;}catch(error){return error.code==='comfy_delivery_storage';}};
  });return page;
}
try{
  const page=await openPage();
  ok('native v1/v2 and cloud v3 share one journal without storing secrets',await page.evaluate(async()=>{
    await store.put(native);
    await store.put({...native,version:2,attemptId:'legacy',originalOnly:true,taskLocator:{version:1,channelKey:'c'.repeat(64)}});
    await store.put({...cloud,apiKey:'synthetic-secret',workflow:{private:'not persisted'}});
    const rows=await store.list(ns),serialized=JSON.stringify(rows);
    return rows.length===3&&rows.map(row=>row.version).sort().join(',')==='1,2,3'&&!/synthetic-secret|workflow/.test(serialized);
  }));
  ok('acceptance and partial image checkpoints persist before closing',await page.evaluate(async()=>{
    await store.put(accepted);await store.put(available);await store.put(partial);
    const row=await store.get(ns,'cloud');return row.status==='available'&&row.files.length===1&&row.cloudTask.taskId==='original';
  }));
  const snapshot=await page.evaluate(async()=>({rows:await store.list(ns),usage:await store.usage(ns)}));
  await page.evaluate(()=>store.close());await page.close();
  const resumed=await openPage();
  assert.deepEqual(await resumed.evaluate(async()=>({rows:await store.list(ns),usage:await store.usage(ns)})),snapshot);
  checks.push('fresh page restores exact original task, partial files and usage');
  ok('rejected mutations leave both records and space accounting unchanged',await resumed.evaluate(async()=>{
    const before=JSON.stringify({rows:await store.list(ns),usage:await store.usage(ns)});
    const changes=[{...partial,taskLocator:{version:1,channelKey:'d'.repeat(64)}},{...partial,version:1},
      {...partial,cloudTask:{...task,taskId:'changed',links:{self:'/api/v2/jobs/changed',cancel:'/api/v2/jobs/changed/cancel'}}},
      {...partial,files:[]},{...partial,status:'prepared'}, {...partial,receipt:'e'.repeat(64)}];
    for(const row of changes)if(!await rejects(()=>store.put(row)))return false;
    return before===JSON.stringify({rows:await store.list(ns),usage:await store.usage(ns)});
  }));
  const other=await openPage();
  // Concurrent tabs must serialize through IndexedDB, not trust their stale in-memory row.
  await Promise.all([
    resumed.evaluate(()=>store.put(complete)),
    other.evaluate(async()=>{try{await store.put(partial);}catch(error){if(error.code!=='comfy_delivery_storage')throw error;}}),
  ]);
  ok('two tabs cannot rewind a completed archive',await other.evaluate(async()=>{
    const row=await store.get(ns,'cloud');return row.status==='archived'&&row.files.length===2&&await rejects(()=>store.put(partial));
  }));
  ok('stale deletion cannot remove newer checkpoints or another account',await resumed.evaluate(async()=>{
    if(!await rejects(()=>store.remove(partial)))return false;
    await store.put({...cloud,namespace:'st-user:other'});
    const own=await store.get(ns,'cloud'),foreign=await store.get('st-user:other','cloud');
    return own.status==='archived'&&foreign.status==='prepared'&&(await store.list('st-user:other')).length===1;
  }));
  ok('confirmation, usage and exact removal agree across both tabs',await other.evaluate(async()=>{
    await store.put({...complete,status:'confirmed'});
    const row=await store.get(ns,'cloud');if(!await store.remove(row))return false;
    const rows=await store.list(ns),usage=await store.usage(ns);
    return rows.length===2&&usage.count===2&&usage.bytes===rows.reduce((sum,item)=>sum+new TextEncoder().encode(JSON.stringify(item)).length,0)
      &&(await store.get('st-user:other','cloud')).status==='prepared';
  }));
  ok('closed store rejects writes while another page remains usable',await resumed.evaluate(async()=>{
    store.close();return await rejects(()=>store.put({...cloud,attemptId:'closed'}));
  }));
  ok('reopening does not invent a failed closed write',await other.evaluate(async()=>{
    const reader=makeStore();try{return await reader.get(ns,'closed')===null&&(await reader.usage(ns)).count===2;}finally{reader.close();}
  }));
  ok('real journal and Web Locks retain pending cloud ACK without downloading again',await other.evaluate(async()=>{
    const {createComfyRecoveryClient}=await import('/qianmu-comfy-recovery-client.js');
    await store.put(accepted);let calls=[],cleanup='pending';
    const delivery={schema:'qianmu.comfy-cloud-delivery.v1',state:'stored',cacheReceipt:available.receipt,imageCount:2,bytes:8,storedAt:1};
    const client=createComfyRecoveryClient({store,account:async()=>ns,fetchImpl:async(url,init)=>{
      if(!url.startsWith('/api/plugins/qianmu-tts/image/comfy/cloud/tasks/'))throw Error('Unexpected route');
      const action=url.split('/').at(-1),body=JSON.parse(init.body);calls.push(action);
      if(action==='acknowledge'&&body.apiKey)throw Error('Key must not enter ACK');
      return new Response(JSON.stringify(action==='result'?{ok:true,version:1,status:'ready',task,provider:task.provider,upstreamId:task.taskId,
        images:[{data:'aW1n',mime:'image/png'},{data:'aW1n',mime:'image/png'}],receipt:available.receipt,delivery,
        locator:{...accepted.taskLocator,attemptId:'cloud'}}:{ok:true,version:1,status:'archived',task,delivery:{...delivery,state:'archived',archivedAt:2},cleanup}));
    }});
    const first=await client.retrieveCloudOriginal(accepted,{apiKey:'synthetic',deliver:async(_job,_data,_files,checkpoint)=>{await checkpoint(complete.files);return true;}});
    if(!first.archived||!first.warning||(await store.get(ns,'cloud')).status!=='archived')return false;
    cleanup='complete';await client.retrieveCloudOriginal(accepted);
    const final=await store.get(ns,'cloud');client.close();
    return final.status==='confirmed'&&calls.join(',')==='result,acknowledge,acknowledge';
  }));
  await other.evaluate(()=>store.close());
  const ui=await openPage();
  await ui.evaluate(async()=>{
    const {mountComfyInbox}=await import('/qianmu-comfy-inbox-view.js');
    const {createComfyRecoveryClient}=await import('/qianmu-comfy-recovery-client.js');
    document.body.innerHTML='<main id="inbox"></main>';window.cloudReadable=true;window.cleanupCalls=0;window.received=[];window.capabilityMode='ready';
    const item={attemptId:'cloud-original',createdAt:1,status:'succeeded',task,taskLocator:accepted.taskLocator,archiveState:'archived',
      cacheReceipt:available.receipt,canRetryCleanup:true,resultAvailable:false,imageCount:2,cacheBytes:8};
    const totals={count:1,imageBytes:8,metadataBytes:2,temporaryBytes:0,reservedBytes:0,tasks:1};
    window.uiClient=createComfyRecoveryClient({store,account:async()=>ns,fetchImpl:async(url,init)=>{
      const body=init.body?JSON.parse(init.body):{};if(body.apiKey)throw Error('Catalog and cleanup must not use Key');
      if(url.endsWith('/capabilities')){
        if(capabilityMode==='old')return new Response('',{status:404});
        const {imageChannelKey}=await import('/qianmu-image-channel.js');
        return new Response(JSON.stringify({ok:true,version:1,accountBindingVersion:1,catalogVersion:1,expectedAccount:`st-user:${await imageChannelKey(ns.slice(8))}`,
          submission:false,cancellation:false,referenceUpload:false,resultRetrieval:capabilityMode==='ready',archiveConfirmation:capabilityMode==='ready',automaticReplay:false,
          queryProviders:['comfy-cloud','runninghub'],resultProviders:capabilityMode==='ready'?['comfy-cloud']:[]}));
      }
      if(url.endsWith('/acknowledge')){
        cleanupCalls++;return new Response(JSON.stringify({ok:true,version:1,status:'archived',task,delivery:{state:'archived',cacheReceipt:available.receipt},cleanup:'pending'}));
      }
      if(!url.endsWith('/catalog'))throw Error('Unexpected media request');
      return new Response(JSON.stringify(url.includes('/cloud/')?{ok:true,version:1,catalogVersion:1,storageReadable:cloudReadable,
        originals:cloudReadable?[item]:[],tasks:body.cursor?[{...item,attemptId:'older-cloud',status:'uncertain',archiveState:null,canRetryCleanup:false}]:[item],
        nextCursor:body.cursor?null:{channelKey:item.taskLocator.channelKey,attemptId:item.attemptId},
        totals:cloudReadable?totals:{...totals,imageBytes:null},warning:cloudReadable?'':'暂存占用暂不可读取'}:
        {ok:true,catalogVersion:1,originals:[{attemptId:'native-original',createdAt:1,status:'succeeded',taskLocator:{version:1,channelKey:'c'.repeat(64)},resultAvailable:true,canDiscard:true,cacheBytes:8,imageCount:1}],tasks:[],totals}));
    }});
    window.disposeInbox=mountComfyInbox(document.querySelector('#inbox'),{service:uiClient,receive:async row=>{received.push(row);return {archived:true};}});
  });
  await ui.waitForSelector('.sd-comfy-inbox[aria-busy="false"]');
  ok('unified inbox shows both platforms and keeps cloud originals out of bulk discard',await ui.locator('#inbox').evaluate(node=>{
    const articles=[...node.querySelectorAll('article')];return articles.length===2&&articles[1].textContent.includes('Comfy Cloud')
      &&articles[1].querySelector('input').disabled&&!articles[0].querySelector('input').disabled;
  }));
  await ui.getByRole('button',{name:'继续清理',exact:true}).click();await ui.waitForSelector('.sd-comfy-inbox[aria-busy="false"]');
  ok('cleanup button uses archive-only continuation, not image delivery',await ui.evaluate(()=>cleanupCalls===1&&received.length===0&&document.querySelector('[role="status"]').textContent.includes('尚未清理完')));
  await ui.evaluate(()=>{cloudReadable=false;});await ui.getByRole('button',{name:'刷新',exact:true}).click();await ui.waitForSelector('.sd-comfy-inbox[aria-busy="false"]');
  ok('unreadable space is explicit and archived ledger cleanup remains reachable',await ui.locator('#inbox').evaluate(node=>node.querySelector('.sd-comfy-inbox-meter').textContent.includes('暂不可读取')
    &&node.querySelector('[role="alert"]').textContent.includes('暂不可读取')&&[...node.querySelectorAll('button')].some(button=>button.textContent==='继续清理'&&!button.disabled)));
  await ui.getByRole('button',{name:'加载较早云任务',exact:true}).click();await ui.waitForSelector('.sd-comfy-inbox[aria-busy="false"]');
  ok('older task paging preserves known originals, deduplicates repeats and stops at the last page',await ui.locator('#inbox').evaluate(node=>{
    const ids=[...node.querySelectorAll('.sd-comfy-inbox-id')].map(item=>item.textContent);
    return ids.length===3&&new Set(ids).size===3&&ids.includes('older-cloud')&&!node.querySelector('[data-action="earlier-cloud"]');
  }));
  ok('platform capability summary distinguishes available receipt from unavailable new generation',await ui.locator('.sd-comfy-inbox-capabilities').evaluate(node=>node.textContent.includes('Comfy Cloud · 可领取原图')
    &&node.textContent.includes('RunningHub · 暂未开放收图')&&node.textContent.includes('云端新任务暂未开放')));
  await ui.evaluate(()=>{capabilityMode='off';cloudReadable=true;});await ui.getByRole('button',{name:'刷新',exact:true}).click();await ui.waitForSelector('.sd-comfy-inbox[aria-busy="false"]');
  ok('unsupported cloud action is disabled while its original metadata remains visible',await ui.locator('#inbox').evaluate(node=>{
    const article=[...node.querySelectorAll('article')].find(item=>item.textContent.includes('Comfy Cloud'));
    return !!article&&article.querySelector('button').disabled;
  }));
  await ui.evaluate(()=>{capabilityMode='old';});await ui.getByRole('button',{name:'刷新',exact:true}).click();await ui.waitForSelector('.sd-comfy-inbox[aria-busy="false"]');
  ok('old backend shows an update action message without disabling native receipt',await ui.locator('#inbox').evaluate(node=>node.querySelector('[role="alert"]').textContent.includes('同步更新后端并重启 ST')
    &&node.querySelectorAll('article').length===1&&!node.querySelector('article button').disabled));
  ok('real IndexedDB preparation and duplicate acceptance preserve one original identity',await ui.evaluate(async()=>{
    const job={id:'new-cloud',source:'comfy',chatKey:'chat',logId:'log',connection:{baseUrl:connection.origin,credentialId:'synthetic'},
      imageAdmission:{version:1,namespace:ns,attemptId:'new-cloud'}};
    const first=await uiClient.prepareCloud(job,connection),repeat=await uiClient.prepareCloud(job,connection);
    if(!first.created||repeat.created||first.record.cloudTask!==null)return false;
    const packet={ok:true,version:1,status:'accepted',task,locator:{...accepted.taskLocator,attemptId:'new-cloud'}};
    const bound=await uiClient.bindCloudAcceptance(first.record,packet),again=await uiClient.bindCloudAcceptance(first.record,packet);
    return bound.cloudTask.taskId===task.taskId&&JSON.stringify(bound)===JSON.stringify(again)&&(await store.get(ns,'new-cloud')).taskLocator.channelKey===accepted.taskLocator.channelKey;
  }));
  await ui.evaluate(()=>{disposeInbox();uiClient.close();});
  const submitPage=await openPage();
  ok('real IndexedDB single-submit consumes its ticket before competing clicks and survives a fresh page',await submitPage.evaluate(async()=>{
    const {createComfyRecoveryClient}=await import('/qianmu-comfy-recovery-client.js');
    const {prepareComfyWorkflow}=await import('/qianmu-comfy-workflow.js');
    const {auditComfyWorkflow,requireComfyExecution}=await import('/qianmu-comfy-audit.js');
    const {imageChannelKey}=await import('/qianmu-image-channel.js');let posts=0;
    const client=createComfyRecoveryClient({store,account:async()=>ns,fetchImpl:async(url,init)=>{
      if(url.endsWith('/capabilities'))return Response.json({ok:true,version:1,accountBindingVersion:1,catalogVersion:1,
        expectedAccount:`st-user:${await imageChannelKey(ns.slice(8))}`,submission:true,resultRetrieval:true,archiveConfirmation:true,
        cancellation:false,referenceUpload:false,automaticReplay:false,queryProviders:['comfy-cloud'],resultProviders:['comfy-cloud']});
      if(!url.endsWith('/submit'))throw Error('Unexpected request');posts++;
      const body=JSON.parse(init.body);
      return Response.json({ok:true,version:1,status:'accepted',task,locator:{...accepted.taskLocator,attemptId:body.attemptId}});
    }});
    const job={id:'ticket-cloud',source:'comfy',automatic:false,connection:{baseUrl:connection.origin},imageAdmission:{version:1,namespace:ns,attemptId:'ticket-cloud'}};
    const workflow={source:{class_type:'FixtureImage',inputs:{text:'%qianmu_prompt%'}},save:{class_type:'SaveImage',inputs:{images:['source',0]}}};
    const policy={version:1,automatic:false,maxImages:1,outputNodeIds:['save'],allowUnverified:true};
    const gateway={provider:'comfy',baseUrl:connection.origin,model:'workflow',prompt:'synthetic',parameters:{workflow},
      comfyExecution:requireComfyExecution(auditComfyWorkflow(prepareComfyWorkflow(workflow,{prompt:'synthetic'}).bind([]),policy),policy)};
    const prepared=await client.prepareCloudSubmission(job,gateway,connection);
    const results=await Promise.allSettled([client.submitCloudPrepared(prepared,'synthetic-key'),client.submitCloudPrepared(prepared,'synthetic-key')]);
    const row=await store.get(ns,'ticket-cloud');client.close();
    return posts===1&&results[0].status==='fulfilled'&&results[1].status==='rejected'&&row.cloudTask.taskId===task.taskId;
  }));
  await submitPage.close();const reopened=await openPage();
  ok('fresh page reads accepted task without a request payload or reusable submission permission',await reopened.evaluate(async()=>{
    const row=await store.get(ns,'ticket-cloud');store.close();
    return row.cloudTask.taskId===task.taskId&&!/synthetic-key|workflow|ticketToken/.test(JSON.stringify(row));
  }));
  const recipePage=await openPage();
  ok('full cloud recipe delivery preserves its paragraph anchor while sharing real image checkpoints and ACK',await recipePage.evaluate(async()=>{
    const {createComfyRecoveryClient}=await import('/qianmu-comfy-recovery-client.js');
    const row=await store.get(ns,'ticket-cloud'),receipt='e'.repeat(64);let shot;
    const client=createComfyRecoveryClient({store,account:async()=>ns,fetchImpl:async(url,init)=>{
      const body=JSON.parse(init.body),ack=url.endsWith('/acknowledge');if(ack&&body.apiKey)throw Error('ACK cannot use Key');
      return Response.json({ok:true,version:1,status:ack?'archived':'ready',task,provider:'comfy-cloud',upstreamId:task.taskId,
        receipt,images:[{mime:'image/png',data:'synthetic-image'}],locator:{...row.taskLocator,attemptId:row.attemptId},
        delivery:{state:ack?'archived':'stored',cacheReceipt:receipt,imageCount:1},...(ack?{cleanup:'complete'}:{})});
    }});
    const job={id:row.attemptId,source:'comfy',chatKey:row.chatKey,logId:row.logId,automatic:row.automatic,
      imageAdmission:{version:1,namespace:ns,attemptId:row.attemptId},connection:{baseUrl:row.baseUrl,credentialId:row.credentialId},
      profile:{model:'original'},payload:{prompt:'original scene',parameters:{workflow:{original:true}}},paragraphAnchor:{paragraphIndex:3}};
    const originalRecord=await client.cloudRecordFor(job);
    if(originalRecord.attemptId!==row.attemptId||originalRecord.cloudTask.taskId!==task.taskId)throw Error('Wrong original journal lookup');
    const result=await client.retrieveCloudJob(job,originalRecord,{apiKey:'synthetic-key',deliver:async(original,_data,_files,checkpoint,guard)=>{
      await guard();shot=original;await checkpoint([{url:'/user/images/recipe.png'}]);return true;
    }});
    const saved=await store.get(ns,row.attemptId);client.close();
    return result.archived&&saved.status==='confirmed'&&shot.payload.prompt==='original scene'&&shot.paragraphAnchor.paragraphIndex===3
      &&!shot.originalOnly&&!JSON.stringify(saved).includes('original scene');
  }));
  const rhPage=await openPage();
  ok('RH originals share real IndexedDB image checkpoints, preserve task/order and retry archive without Key or redownload',await rhPage.evaluate(async()=>{
    const {createComfyRecoveryClient}=await import('/qianmu-comfy-recovery-client.js');
    const {bindComfyCloudProtocol,bindComfyCloudTask}=await import('/qianmu-comfy-cloud-protocol.js');
    const connection=bindComfyCloudProtocol('https://www.runninghub.cn','runninghub-workflow-v1'),task=bindComfyCloudTask(connection,'1904152026220003329');
    const row={...accepted,attemptId:'rh-original',cloudConnection:connection,cloudTask:task,baseUrl:connection.origin};
    await store.put(row);window.rhRow=row;
    const receipt='f'.repeat(64),calls=[];let cleanup='pending',delivered=0;
    const client=createComfyRecoveryClient({store,account:async()=>ns,fetchImpl:async(url,init)=>{
      const action=url.split('/').at(-1),body=JSON.parse(init.body);calls.push(action);
      if(body.task.taskId!==task.taskId)throw Error('Wrong RH task');
      if(action==='acknowledge'&&body.apiKey)throw Error('Key in ACK');
      return Response.json({ok:true,version:1,status:action==='result'?'ready':'archived',task,provider:'runninghub',upstreamId:task.taskId,
        receipt,images:[0,1].map(index=>({id:`rh:${task.taskId}:${index}:save`,mime:'image/png',data:'synthetic'})),
        locator:{...row.taskLocator,attemptId:row.attemptId},delivery:{state:action==='result'?'stored':'archived',cacheReceipt:receipt,imageCount:2},cleanup});
    }});
    const first=await client.retrieveCloudOriginal(row,{apiKey:'synthetic-key',deliver:async(job,data,_files,checkpoint)=>{
      if(!job.originalOnly||data.images[1].id!==`rh:${task.taskId}:1:save`)throw Error('Wrong original output order');
      delivered++;await checkpoint([{imageIndex:0,url:'/user/images/rh-0.png'},{imageIndex:1,url:'/user/images/rh-1.png'}]);return true;
    }});
    if(!first.archived||!first.warning||(await store.get(ns,row.attemptId)).status!=='archived')return false;
    cleanup='complete';const next=await client.retrieveCloudOriginal(row),saved=await store.get(ns,row.attemptId);client.close();
    return next.archived&&saved.status==='confirmed'&&saved.files.length===2&&delivered===1&&calls.join(',')==='result,acknowledge,acknowledge'
      &&!JSON.stringify(saved).includes('synthetic-key');
  }));
  await rhPage.close();const rhReopened=await openPage();
  ok('RH completed originals survive a fresh page with the exact platform ID and two local files',await rhReopened.evaluate(async()=>{
    const row=await store.get(ns,'rh-original');return row.status==='confirmed'&&row.cloudTask.taskId==='1904152026220003329'
      &&row.cloudTask.provider==='runninghub'&&row.files[0].url==='/user/images/rh-0.png'&&row.files[1].url==='/user/images/rh-1.png';
  }));
  const rhSubmit=await openPage();
  ok('RH explicit-tier generation uses one actual client ticket, freezes the original and survives page reopen',await rhSubmit.evaluate(async()=>{
    const {createComfyRecoveryClient}=await import('/qianmu-comfy-recovery-client.js');
    const {bindComfyCloudProtocol,bindComfyCloudTask}=await import('/qianmu-comfy-cloud-protocol.js');
    const {prepareComfyWorkflow}=await import('/qianmu-comfy-workflow.js');
    const {auditComfyWorkflow,requireComfyExecution}=await import('/qianmu-comfy-audit.js');
    const {imageChannelKey}=await import('/qianmu-image-channel.js');
    const connection=bindComfyCloudProtocol('https://www.runninghub.cn','runninghub-workflow-v1'),task=bindComfyCloudTask(connection,'1904152026220003330');
    let posts=0;const client=createComfyRecoveryClient({store,account:async()=>ns,fetchImpl:async(url,init)=>{
      if(url.endsWith('/capabilities'))return Response.json({ok:true,version:1,accountBindingVersion:1,catalogVersion:1,
        expectedAccount:`st-user:${await imageChannelKey(ns.slice(8))}`,submission:true,submissionProviders:['comfy-cloud','runninghub'],
        resultRetrieval:true,archiveConfirmation:true,cancellation:false,referenceUpload:false,automaticReplay:false,
        queryProviders:['comfy-cloud','runninghub'],resultProviders:['comfy-cloud','runninghub']});
      if(!url.endsWith('/submit'))throw Error('Unexpected request');posts++;
      const body=JSON.parse(init.body);if(body.request.runninghub.instanceType!=='plus'||body.request.prompt!=='original')throw Error('Changed frozen RH input');
      return Response.json({ok:true,version:1,status:'accepted',task,locator:{version:1,channelKey:'d'.repeat(64),attemptId:body.attemptId}});
    }});
    const job={id:'rh-new',source:'comfy',automatic:false,profile:{comfyInstanceType:'plus'},connection:{baseUrl:connection.origin},imageAdmission:{version:1,namespace:ns,attemptId:'rh-new'}};
    const workflow={source:{class_type:'FixtureImage',inputs:{text:'%qianmu_prompt%'}},save:{class_type:'SaveImage',inputs:{images:['source',0]}}};
    const policy={version:1,automatic:false,maxImages:1,outputNodeIds:['save'],allowUnverified:true};
    const gateway={provider:'comfy',baseUrl:connection.origin,model:'workflow',prompt:'original',parameters:{workflow},
      comfyExecution:requireComfyExecution(auditComfyWorkflow(prepareComfyWorkflow(workflow,{prompt:'original'}).bind([]),policy),policy)};
    const prepared=await client.prepareCloudSubmission(job,gateway,connection);job.profile.comfyInstanceType='ultra';gateway.prompt='changed';
    const results=await Promise.allSettled([client.submitCloudPrepared(prepared,'synthetic-key'),client.submitCloudPrepared(prepared,'synthetic-key')]);
    const row=await store.get(ns,'rh-new');client.close();
    return posts===1&&results[0].status==='fulfilled'&&results[1].status==='rejected'&&row.cloudTask.taskId===task.taskId;
  }));
  await rhSubmit.close();const rhNewReopened=await openPage();
  ok('RH new task reopens with exact original identity and no reusable payload or credential',await rhNewReopened.evaluate(async()=>{
    const row=await store.get(ns,'rh-new');return row.cloudTask.taskId==='1904152026220003330'&&!/synthetic-key|"instanceType":|"workflow":/.test(JSON.stringify(row));
  }));
  const usagePage=await openPage();await usagePage.addStyleTag({content:await readFile(new URL('../style.css',import.meta.url),'utf8')});
  await usagePage.evaluate(async()=>{
    const {mountComfyInbox}=await import('/qianmu-comfy-inbox-view.js');
    const {bindComfyCloudProtocol,bindComfyCloudTask}=await import('/qianmu-comfy-cloud-protocol.js');
    document.body.innerHTML='<div id="story-director-modal" style="position:static;width:100%;display:block"><div id="usage-host"></div></div>';
    const task=bindComfyCloudTask(bindComfyCloudProtocol('https://www.runninghub.cn','runninghub-workflow-v1'),'1904152026220003330');
    const row={attemptId:'rh-usage',task,engine:'cloud',archiveState:'archived',createdAt:1,canRetryCleanup:false,
      usage:{consumeCoins:'1.2500',consumeMoney:'0',thirdPartyConsumeMoney:null,taskCostTime:'35'}};
    mountComfyInbox(document.querySelector('#usage-host'),{service:{list:async()=>({namespace:ns,rows:[],bytes:0}),
      catalogAll:async()=>({namespace:ns,originals:[row,{...row,attemptId:'rh-unknown',usage:null}],totals:{imageBytes:0,metadataBytes:0,temporaryBytes:0,reservedBytes:0}})}});
  });
  await usagePage.waitForSelector('.sd-comfy-inbox[aria-busy="false"]');
  for(const width of [320,393,1100]){
    await usagePage.setViewportSize({width,height:900});
    ok(`reported RH decimals and missing values fit the original inbox grid at ${width}`,await usagePage.locator('.sd-comfy-inbox-rows').evaluate(node=>{
      const [first,second]=node.querySelectorAll('article'),usage=first.querySelector('.sd-comfy-inbox-usage');
      return first.children.length===3&&usage.parentElement.tagName==='DIV'&&usage.textContent.includes('RH币 1.2500')
        &&usage.textContent.includes('第三方金额 未提供')&&second.textContent.includes('平台用量未提供')
        &&first.scrollWidth<=first.clientWidth+1&&!/[￥$]/.test(usage.textContent);
    }));
  }
  assert.equal(external,0);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({checks,external,errors},null,2));
}finally{await context.close();await browser.close();}
