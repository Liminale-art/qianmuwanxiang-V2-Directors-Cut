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
  assert.equal(external,0);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({checks,external,errors},null,2));
}finally{await context.close();await browser.close();}
