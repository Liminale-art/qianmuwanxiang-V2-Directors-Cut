// Isolated native IndexedDB, synthetic records only; production ST is never contacted.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {storyboardFunctionSource as section} from '../tests/helpers/storyboard-form-fixture.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.QIANMU_PLAYWRIGHT_MODULE||'playwright');
const sources=new Map(await Promise.all(['qianmu-blobstore.js','qianmu-plan-archive-write.js','qianmu-config-undo.js','qianmu-config-connections.js','qianmu-json-input.js','qianmu-data-migrations.js'].map(async file=>['https://qianmu.test/'+file,await readFile(new URL('../'+file,import.meta.url),'utf8')])));
const browser=await chromium.launch({channel:process.env.QIANMU_BROWSER_CHANNEL||undefined,headless:true}),context=await browser.newContext();let external=0;const errors=[];
await context.route('**/*',route=>{const url=route.request().url();return url==='https://qianmu.test/'?route.fulfill({contentType:'text/html',body:'<!doctype html>'}):sources.has(url)?route.fulfill({contentType:'application/javascript',body:sources.get(url)}):(external++,route.abort());});
try {
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto('https://qianmu.test/');
  const checks=await page.evaluate(async source=>{
    const api=await import('/qianmu-blobstore.js'),checks=[];
    const check=(name,ok)=>{if(!ok)throw Error(name);checks.push(name);};
    const make=(key,prompt)=>({key,chatKey:'fixture',planId:'same',updatedAt:1,plan:{shots:[{prompt}]}});
    const put=rows=>api.putStoryboardPlanArchives(rows,{preserveExisting:true});
    const snapshot={key:'snapshot-conflict',chatKey:'fixture',recordId:'image',snapshot:{prompt:'old image'}};
    await api.putStoryboardSnapshots([snapshot]);const beforeSnapshot=(await api.getStoryboardSnapshots([snapshot.key]))[0];
    await api.putStoryboardSnapshots([{...snapshot,updatedAt:1}],{preserveExisting:true});
    check('automatic snapshot retries preserve the original metadata',JSON.stringify((await api.getStoryboardSnapshots([snapshot.key]))[0])===JSON.stringify(beforeSnapshot));
    let snapshotConflict=false;try{await api.putStoryboardSnapshots([{...snapshot,key:'snapshot-new'},{...snapshot,snapshot:{prompt:'imported image'}}],{preserveExisting:true});}catch{snapshotConflict=true;}
    check('automatic snapshot collision preserves old originals and aborts the complete batch',snapshotConflict&&(await api.getStoryboardSnapshots(['snapshot-new'])).length===0&&(await api.getStoryboardSnapshots([snapshot.key]))[0].snapshot.prompt==='old image');
    await api.putStoryboardSnapshots([{...snapshot,snapshot:{prompt:'explicit user edit'}}]);
    check('explicit snapshot editing remains available',(await api.getStoryboardSnapshots([snapshot.key]))[0].snapshot.prompt==='explicit user edit');
    const pipeline={id:'pipeline-conflict',status:'success',stages:[{response:'original private text'}]};
    await api.putStoryboardPipelineLogs([pipeline]);
    const beforePipeline=(await api.getStoryboardPipelineLogs([pipeline.id]))[0];
    const preservePipelines=rows=>api.putStoryboardPipelineLogs(rows,{preserveExisting:true});
    await preservePipelines([{...pipeline,archivedAt:1}]);
    check('identical pipeline retries do not overwrite archival metadata',JSON.stringify((await api.getStoryboardPipelineLogs([pipeline.id]))[0])===JSON.stringify(beforePipeline));
    let conflict=false;try{await preservePipelines([{...pipeline,id:'pipeline-new'}, {...pipeline,stages:[{response:'different text'}]}]);}catch{conflict=true;}
    check('pipeline collision rejects atomically and preserves the old full text',conflict&&(await api.getStoryboardPipelineLogs(['pipeline-new'])).length===0&&JSON.stringify((await api.getStoryboardPipelineLogs([pipeline.id]))[0])===JSON.stringify(beforePipeline));
    const racing=await Promise.allSettled([preservePipelines([{...pipeline,id:'pipeline-race',choice:'A'}]),preservePipelines([{...pipeline,id:'pipeline-race',choice:'B'}])]);
    check('concurrent conflicting pipeline writers cannot both succeed',racing.filter(item=>item.status==='fulfilled').length===1&&(await api.getStoryboardPipelineLogs(['pipeline-race'])).length===1);
    const old=make('fixture-key','old'),fresh=make('fixture-key','new');
    await api.putStoryboardPlanArchives([old]);
    const added=await put([fresh]),key=added.stored[0];
    check('different content receives an independent key',key!=='fixture-key');
    const rows=await api.getStoryboardPlanArchives(['fixture-key',key]);
    check('old payload preserved and new payload readable',rows[0].plan.shots[0].prompt==='old'&&rows[1].plan.shots[0].prompt==='new'&&rows[1].key===key);
    check('identical retries reuse the same variant',(await put([fresh])).stored[0]===key);
    const batch=await put([fresh,fresh,make('fixture-key','third')]);
    check('duplicate batch inputs are idempotent and ordered',batch.stored[0]===key&&batch.stored[1]===key&&batch.stored[2]!==key);
    const parallel=await Promise.all([put([make('race','A')]),put([make('race','B')])]);
    check('concurrent writers never overwrite one another',parallel[0].stored[0]!==parallel[1].stored[0]&&(await api.getStoryboardPlanArchives(parallel.flatMap(r=>r.stored))).length===2);
    const original=IDBObjectStore.prototype.add;
    try {
      IDBObjectStore.prototype.add=function(value,...args){if(this.name==='storyboard_plan_archives'&&value.key==='abort-two')throw Error('fixture write failure');return original.call(this,value,...args);};
      let rejected=false;try{await put([make('abort-one','one'),make('abort-two','two')]);}catch{rejected=true;}
      check('failure aborts the whole batch without partial new records',rejected&&(await api.getStoryboardPlanArchives(['abort-one','abort-two'])).length===0);
    } finally { IDBObjectStore.prototype.add=original; }
    check('failure does not remove existing originals',(await api.getStoryboardPlanArchives(['fixture-key']))[0].plan.shots[0].prompt==='old');
    check('writer does not mutate caller records',fresh.key==='fixture-key'&&fresh.plan.shots[0].prompt==='new');
    const prior={id:'entry-plan',chatKey:'entry-chat',status:'completed',updatedAt:1,shots:[{id:'s',status:'completed',prompt:'before import'}]};
    const base='entry-chat␟entry-plan';await api.putStoryboardPlanArchives([{key:base,chatKey:prior.chatKey,planId:prior.id,plan:prior}]);
    const state={shotPlans:[{...structuredClone(prior),shots:[{id:'s',status:'completed',prompt:'after import'}]}]};
    const {createConfigUndoSlot}=await import('/qianmu-config-undo.js');
    window.configUndo=createConfigUndoSlot();window.settings=state;configUndo.remember({settings:{theme:'before'}},state);
    Object.assign(window,await import('/qianmu-plan-archive-write.js'),{clone:structuredClone,blobStore:api,storyboardState:()=>state,
      storyboardPlanArchiveEpoch:0,storyboardPlanArchiveCache:new Map(),saveSettings(){},storyboardPackageArchiveAllowed:async()=>true});
    const entry=new Function(source+';return {archive:storyboardArchiveShotPlans,portable:storyboardPlansForPortableExport,release:storyboardReleasePlanArchive};')();
    check('actual entry archives into the returned collision-free reference',await entry.archive()===1&&state.shotPlans[0].archiveRef!==base);
    check('verified archive transition retains the original recovery snapshot',configUndo.available(state)&&configUndo.read(state).settings.theme==='before');
    storyboardPlanArchiveCache.clear();
    const current=await entry.portable(state.shotPlans,{strict:true});
    const previous=await entry.portable([{...prior,archiveRef:base}],{strict:true});
    check('both original and imported prompts survive cache clearing and portable rehydration',current[0].shots[0].prompt==='after import'&&previous[0].shots[0].prompt==='before import');
    const usage=await api.estimateBlobStoreUsage(),scope=usage.stores.find(row=>row.name==='storyboard_plan_archives').scopes.find(row=>row.chatKey==='entry-chat');
    check('storage counts both variants by record chat ownership',scope.count===2&&scope.bytes>0);
    const activeKey=state.shotPlans[0].archiveRef;await entry.release(state.shotPlans[0]);
    check('releasing the selected variant leaves the older archive intact',(await api.getStoryboardPlanArchives([activeKey])).length===0&&(await api.getStoryboardPlanArchives([base])).length===1);
    await put([{key:base,chatKey:prior.chatKey,planId:prior.id,plan:{...prior,shots:[{id:'s',prompt:'another variant'}]}}]);
    const cleared=await api.clearChatScopedStorage([{name:'storyboard_plan_archives',chatKey:'entry-chat'}]);
    const remaining=await api.estimateBlobStoreUsage();
    check('explicit chat cleanup includes variants without touching other chats',cleared.count===2&&cleared.failed.length===0&&!remaining.chatScopes.some(row=>row.chatKey==='entry-chat')&&(await api.getStoryboardPlanArchives(['fixture-key'])).length===1);
    return checks;
  },['storyboardPlanIsTerminal','storyboardPlanArchiveKey','storyboardPlanHasHeavyPayload','storyboardPlanArchivePayload','storyboardPlanLightweightSummary','storyboardArchiveShotPlans','storyboardPlansForPortableExport','storyboardReleasePlanArchive'].map(section).join('\n'));
  assert.equal(external,0);assert.deepEqual(errors,[]);console.log(JSON.stringify({nativeIndexedDB:true,checks,external,errors}));
} finally {await context.close();await browser.close();}
