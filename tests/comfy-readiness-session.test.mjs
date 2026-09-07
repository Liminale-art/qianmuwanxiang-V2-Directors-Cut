import test from 'node:test';
import assert from 'node:assert/strict';
import {createComfyReadinessSession,checkComfyCharacterReadiness} from '../qianmu-comfy-character-readiness.js';
const result=()=>({ok:true,schemaVersion:1,actualGenerationVerified:false,errors:0,warnings:0,ready:true,issues:[],unverifiedWarnings:0,pendingReferenceUploads:0});
const request=()=>({baseUrl:'https://comfy.test',apiKey:'secret-a',workflow:{save:{class_type:'SaveImage',inputs:{images:['image',0]}},image:{class_type:'EmptyImage',inputs:{width:512,height:768,batch_size:1}}},model:'comfy-workflow',parameters:{count:1},referenceCount:0});
const options=()=>({transport:'gateway',headers:{'x-csrf-token':'token-a'},guard:async()=>{}});

test('identical candidate requests share only static reports; results are isolated and guards run even on hits',async()=>{
  let calls=0,guards=0;const session=createComfyReadinessSession({check:async()=>{calls++;return result();}}),input=request(),opt={...options(),guard:async()=>{guards++;}};
  const first=await session.checkComfyCharacterReadiness(input,opt);first.issues.push('changed');
  const second=await session.checkComfyCharacterReadiness(input,opt);assert.deepEqual(second.issues,[]);assert.equal(calls,1);assert.equal(session.stats().hits,1);assert.ok(guards>=6);
  assert.doesNotMatch(JSON.stringify(session.stats()),/secret|token|workflow|Authorization/);session.close();assert.equal(session.stats().bytes,0);
  await assert.rejects(()=>session.checkComfyCharacterReadiness(input,opt),/已结束/);
});

test('credentials, route, transport, headers, geometry, role/reference inputs and graph all separate entries',async()=>{
  let calls=0;const session=createComfyReadinessSession({check:async()=>{calls++;return result();}});
  try{
    await session.checkComfyCharacterReadiness(request(),options());
    for(const mutate of [r=>r.apiKey='secret-b',r=>r.baseUrl='https://different.test',r=>r.parameters.width=768,r=>r.referenceCount=1,r=>r.workflow.image.inputs.height=1024,r=>r.model='other']){
      const r=request();mutate(r);await session.checkComfyCharacterReadiness(r,options());
    }
    await session.checkComfyCharacterReadiness(request(),{...options(),transport:'browser'});
    await session.checkComfyCharacterReadiness(request(),{...options(),headers:{'x-csrf-token':'token-b'}});
    assert.equal(calls,9);assert.equal(session.stats().entries,9);
  }finally{session.close();}
});

test('failed checks and malformed or execution-authorized answers are not cached',async()=>{
  for(const bad of [()=>{throw Error('network error');},()=>({...result(),actualGenerationVerified:true}),()=>({...result(),errors:1}),()=>({...result(),ready:false}),()=>({...result(),message:'x'.repeat(270000)})]){
    let calls=0;const session=createComfyReadinessSession({check:async()=>{calls++;if(calls===1)return bad();return result();}});
    await assert.rejects(()=>session.checkComfyCharacterReadiness(request(),options()));assert.equal(session.stats().entries,0);
    assert.equal((await session.checkComfyCharacterReadiness(request(),options())).ready,true);assert.equal(calls,2);session.close();
  }
});

test('concurrent identical reads are single-flight but changed inputs cannot bless the returned report',async()=>{
  let resolve,calls=0;const session=createComfyReadinessSession({check:async()=>{calls++;return new Promise(r=>{resolve=r;});}}),input=request();
  const a=session.checkComfyCharacterReadiness(input,options()),b=session.checkComfyCharacterReadiness(input,options());
  while(!resolve)await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));resolve(result());await Promise.all([a,b]);assert.equal(calls,1);session.close();
  const changing=request(),other=createComfyReadinessSession({check:async()=>{changing.apiKey='late';return result();}});
  await assert.rejects(()=>other.checkComfyCharacterReadiness(changing,options()),/变化/);assert.equal(other.stats().entries,0);other.close();
});

test('cache-hit scope cancellation and close during fetch never return a reusable success',async()=>{
  let allowed=true;const session=createComfyReadinessSession({check:async()=>result()}),opt={...options(),guard:async()=>{if(!allowed)throw Error('account changed');}};
  await session.checkComfyCharacterReadiness(request(),opt);allowed=false;await assert.rejects(()=>session.checkComfyCharacterReadiness(request(),opt),/account changed/);session.close();
  let signal;const waiting=createComfyReadinessSession({check:async(_r,options)=>{signal=options.signal;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));}});
  const run=waiting.checkComfyCharacterReadiness(request(),options());while(!signal)await new Promise(r=>setImmediate(r));waiting.close();await assert.rejects(()=>run,/aborted/);assert.equal(signal.aborted,true);assert.equal(waiting.stats().entries,0);
});

test('bounded capacity falls back to fresh read-only checks, not failures or unbounded retained metadata',async()=>{
  let calls=0;const session=createComfyReadinessSession({maxEntries:1,maxBytes:1024,check:async()=>{calls++;return result();}}),a=request(),b={...a,apiKey:'b'};
  await session.checkComfyCharacterReadiness(a,options());await session.checkComfyCharacterReadiness(b,options());await session.checkComfyCharacterReadiness(b,options());await session.checkComfyCharacterReadiness(a,options());
  assert.equal(calls,3);assert.equal(session.stats().entries,1);assert.ok(session.stats().bytes<=1024);session.close();
  const tiny=createComfyReadinessSession({maxBytes:1,check:async()=>result()});await tiny.checkComfyCharacterReadiness(a,options());assert.equal(tiny.stats().entries,0);tiny.close();
  for(const values of [{maxEntries:65},{maxBytes:3*1024*1024},{maxEntries:0}])assert.throws(()=>createComfyReadinessSession(values),/限额/);
});

test('a static report drops unrelated remote fields and concurrent distinct request work is bounded',async()=>{
  const safe=createComfyReadinessSession({check:async()=>({...result(),apiKey:'server-echo',executionAuthorized:true,workflow:{}})});
  const answer=await safe.checkComfyCharacterReadiness(request(),options());assert.doesNotMatch(JSON.stringify(answer),/apiKey|executionAuthorized|workflow|server-echo/);safe.close();
  const deferred=[],busy=createComfyReadinessSession({check:async()=>new Promise(resolve=>deferred.push(resolve))});
  const tasks=Array.from({length:8},(_,i)=>busy.checkComfyCharacterReadiness({...request(),model:String(i)},options()));
  while(deferred.length<8)await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(()=>busy.checkComfyCharacterReadiness({...request(),model:'overflow'},options()),/正在处理/);
  deferred.forEach(resolve=>resolve(result()));await Promise.all(tasks);assert.equal(busy.stats().pending,0);busy.close();
});

test('gateway actual bounded parsing is reused only inside the probe session; a normal queue check still makes a new request',async()=>{
  let calls=0;const check=(r,opt)=>checkComfyCharacterReadiness(r,{...opt,fetchImpl:async()=>{calls++;return new Response(JSON.stringify(result()));}});
  const session=createComfyReadinessSession({check}),r=request();
  await session.checkComfyCharacterReadiness(r,options());await session.checkComfyCharacterReadiness(r,options());assert.equal(calls,1);
  await check(r,options());assert.equal(calls,2);session.close();
  const next=createComfyReadinessSession({check});await next.checkComfyCharacterReadiness(r,options());assert.equal(calls,3);next.close();
});

test('external abort is respected before any read and cancels an active gateway stream',async()=>{
  const controller=new AbortController();controller.abort();let reads=0;
  await assert.rejects(()=>checkComfyCharacterReadiness(request(),{...options(),signal:controller.signal,fetchImpl:async()=>{reads++;return new Response('{}');}}));assert.equal(reads,0);
  const live=new AbortController();let signal;
  const session=createComfyReadinessSession({check:async(_r,opt)=>{signal=opt.signal;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));}});
  const run=session.checkComfyCharacterReadiness(request(),{...options(),signal:live.signal});while(!signal)await new Promise(r=>setImmediate(r));live.abort();await assert.rejects(()=>run,/aborted/);session.close();
});
