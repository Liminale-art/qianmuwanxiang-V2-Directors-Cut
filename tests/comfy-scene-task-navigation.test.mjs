import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {navigateComfySceneTask} from '../qianmu-comfy-scene-task-navigation.js';
import {mountComfySceneReview,renderComfySceneReview} from '../qianmu-comfy-scene-view.js';
import {COMFY_SELECTION_SCHEMA} from '../qianmu-comfy-selection.js';
import {QIANMU_FA_ICON_MAP,qianmuIconMarkup} from '../qianmu-icon-renderer.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const namespace='st-user:scene-navigation',chatKey='chat';
const scope={namespace,chatKey,continuityId:'scene',narrativeLayer:'present'};
const lock={schema:COMFY_SELECTION_SCHEMA,scope,poolKey:'a'.repeat(64),candidateId:'candidate',executionKey:'b'.repeat(64)};
const request=()=>({scope:structuredClone(scope),lock:structuredClone(lock),attemptId:'task'});
const makeLog=()=>({id:'original-log',source:'comfy',status:'failed',snapshot:{source:'comfy',chatKey,
  imageAdmission:{version:1,namespace,attemptId:'task'},connection:{baseUrl:'https://comfy.test',credentialId:'never-displayed'},
  comfySceneOrigin:{version:1,mode:'scene',scope:structuredClone(scope),poolKey:lock.poolKey,candidateId:lock.candidateId,executionKey:lock.executionKey,sourceHash:'c'.repeat(64),connectionPresetId:''}}});
const snapshot=()=>({native:true,rows:[{scope,heads:['a'.repeat(64)],generation:0,blocked:false,error:'',branches:[{digest:'a'.repeat(64),record:{scope,lock,updatedAt:1,label:{workflowName:'workflow'},holders:[{attemptId:'task',ownerId:'private-owner',token:'private-token',status:'uncertain'}]}}]}]});
const element=()=>({hidden:true,isConnected:true,innerHTML:'',onclick:null,contains:()=>true,replaceChildren(){}});
const click=(branch='0',task='0')=>{const control={disabled:false,dataset:{sceneAction:'task',sceneBranch:branch,sceneTask:task},closest:()=>({dataset:{sceneRow:'0'}})};return {target:{closest:()=>control},preventDefault(){},stopPropagation(){}};};

test('navigation opens only the exactly bound original log without changing task, source or configuration',async()=>{
  const log=makeLog(),before=structuredClone(log),shown=[],input=request();let checks=0;
  const result=await navigateComfySceneTask(input,{namespace,chatKey,getLogs:()=>[log],guard:async()=>{checks++;},present:id=>shown.push(id)});
  assert.deepEqual(shown,['original-log']);assert.deepEqual(result,{logId:'original-log'});assert.deepEqual(log,before);assert.equal(checks,2);assert.deepEqual(input,request());
});

for(const [name,mutate]of Object.entries({
  account:log=>log.snapshot.imageAdmission.namespace='st-user:other',chat:log=>log.snapshot.chatKey='other-chat',
  attempt:log=>log.snapshot.imageAdmission.attemptId='different',source:log=>log.source='novel',snapshotSource:log=>log.snapshot.source='novel',
  independent:log=>log.snapshot.comfySceneOrigin.mode='independent',candidate:log=>log.snapshot.comfySceneOrigin.candidateId='other',
  execution:log=>log.snapshot.comfySceneOrigin.executionKey='d'.repeat(64),scene:log=>log.snapshot.comfySceneOrigin.scope.continuityId='other',
  invalidOrigin:log=>log.snapshot.comfySceneOrigin={invalid:true},originalOnly:log=>log.snapshot.originalOnly=true,
}))test(`same-looking ${name} mismatch is not treated as the original task log`,async()=>{
  const log=makeLog();mutate(log);let shown=0;
  await assert.rejects(navigateComfySceneTask(request(),{namespace,chatKey,getLogs:()=>[log],guard:async()=>{},present:()=>shown++}),/未找到准确原日志/);assert.equal(shown,0);
});

test('missing, duplicate task logs and duplicate rendered ids never guess the first match',async()=>{
  for(const logs of [[],[makeLog(),makeLog()],[makeLog(),{id:'original-log',source:'novel'}]]){
    let shown=0;await assert.rejects(navigateComfySceneTask(request(),{namespace,chatKey,getLogs:()=>logs,guard:async()=>{},present:()=>shown++}),/未找到|多份日志/);assert.equal(shown,0);
  }
});

test('wrong page namespace or chat, mismatched target lock and invalid task identifiers are rejected before reading logs',async()=>{
  for(const mode of ['account','chat','lock','task']){
    const target=request();let reads=0;const options={namespace,chatKey,getLogs:()=>{reads++;return [makeLog()];},guard:async()=>{},present:()=>assert.fail('opened')};
    if(mode==='account')options.namespace='st-user:other';if(mode==='chat')options.chatKey='other';if(mode==='lock')target.lock.scope.chatKey='different';if(mode==='task')target.attemptId='task\n';
    await assert.rejects(navigateComfySceneTask(target,options));assert.equal(reads,0);
  }
});

test('account guard, cleared log, changed origin or replaced object during navigation stops without opening another page',async()=>{
  for(const mode of ['account','clear','origin','replace']){
    let logs=[makeLog()],checks=0,shown=0;
    await assert.rejects(navigateComfySceneTask(request(),{namespace,chatKey,getLogs:()=>logs,guard:async()=>{if(++checks===2){if(mode==='account')throw Error('account changed');if(mode==='clear')logs=[];if(mode==='origin')logs[0].snapshot.comfySceneOrigin.sourceHash='f'.repeat(64);if(mode==='replace')logs=[makeLog()];}},present:()=>shown++}));
    assert.equal(shown,0);
  }
});

test('a status update while locating the same original may be displayed without authorizing any recovery action',async()=>{
  const log=makeLog();let checks=0,shown;
  await navigateComfySceneTask(request(),{namespace,chatKey,getLogs:()=>[log],guard:async()=>{if(++checks===2)log.status='success';},present:id=>{shown=id;}});
  assert.equal(shown,log.id);assert.equal(log.status,'success');
});

test('task links are optional, escape task text and never serialize owner or reservation tokens into controls',()=>{
  const data=snapshot();data.rows[0].branches[0].record.holders[0].attemptId='<img src=x>';
  assert.doesNotMatch(renderComfySceneReview(data),/data-scene-action="task"/);
  const html=renderComfySceneReview(data,{taskLinks:true});assert.match(html,/data-scene-action="task"/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img|private-owner|private-token/);
  assert.ok(QIANMU_FA_ICON_MAP['fa-arrow-right']);assert.match(qianmuIconMarkup('fa-arrow-right'),/<svg/);assert.doesNotMatch(qianmuIconMarkup('fa-arrow-right'),/<use|https?:/);
});

test('actual management click passes only the selected branch identity and never asks the manager to settle, unlock or synchronize',async()=>{
  const host=element(),data=snapshot(),second=structuredClone(data.rows[0].branches[0]);second.digest='b'.repeat(64);second.record.lock.candidateId='second';data.rows[0].branches.push(second);const requests=[];
  const manager=new Proxy({review:async()=>data},{get(target,key){if(key in target)return target[key];return ()=>assert.fail('unexpected manager '+String(key));}});
  await mountComfySceneReview({host,manager,namespace,chatKey,current:()=>true,guard:async()=>{},openTask:async target=>requests.push(target)});
  await host.onclick(click('1'));assert.equal(requests.length,1);assert.equal(requests[0].lock.candidateId,'second');assert.deepEqual(Object.keys(requests[0]).sort(),['attemptId','lock','scope']);assert.doesNotMatch(JSON.stringify(requests),/private-token|private-owner/);
});

test('missing task and navigation errors keep the manager readable without altering held tasks',async()=>{
  const host=element(),data=snapshot(),before=structuredClone(data),notices=[];let calls=0;
  await mountComfySceneReview({host,manager:{review:async()=>data},namespace,chatKey,current:()=>true,guard:async()=>{},openTask:async()=>{calls++;throw Error('未找到准确原日志');},notify:message=>notices.push(message)});
  await host.onclick(click('9'));assert.equal(calls,0);await host.onclick(click());assert.equal(calls,1);assert.match(host.innerHTML,/未找到准确原日志/);assert.deepEqual(data,before);assert.equal(notices.length,2);
});

test('rapid task clicks share the existing busy gate and page replacement cannot open the old log',async()=>{
  const host=element(),data=snapshot();let active=true,release,attempts=0,presented=0,checks=0;
  await mountComfySceneReview({host,manager:{review:async()=>data},namespace,chatKey,current:()=>active,guard:async()=>{if(!active)throw Error('page changed');},
    openTask:target=>{attempts++;return navigateComfySceneTask(target,{namespace,chatKey,getLogs:()=>[makeLog()],guard:async()=>{if(++checks===1)await new Promise(resolve=>{release=resolve;});if(!active)throw Error('page changed');},present:()=>presented++});}});
  const first=host.onclick(click());await new Promise(resolve=>setImmediate(resolve));await host.onclick(click());assert.equal(attempts,1);active=false;release();await first;assert.equal(presented,0);
});

test('narrow task rows keep long identifiers in the flexible column and the local icon on a separate fixed track',async()=>{
  const css=await readFile(new URL('../style.css',import.meta.url),'utf8');
  assert.match(css,/\.sd-comfy-scene-task\s*\{[^}]*display:grid;grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(css,/\.sd-comfy-scene-task>button\s*\{[^}]*grid-column:2;grid-row:1 \/ span 2/);
  assert.match(css,/\.sd-comfy-scene-review code[^}]*overflow-wrap:anywhere/);
});

test('the actual versioned scene loader exposes task navigation and keeps its lazy views on the same release URL',async()=>{
  const source=await readFile(new URL('../index.js',import.meta.url),'utf8'),runtimeSource=await readFile(new URL('../qianmu-comfy-lock-runtime.js',import.meta.url),'utf8');
  assert.ok(source.includes('load: () => import(`./qianmu-comfy-lock-runtime.js?v=${VERSION}`)'));
  assert.match(runtimeSource,/new URL\(`\.\/\$\{name\}\.js\$\{new URL\(import\.meta\.url\)\.search\}`,import\.meta\.url\)/);
  const versioned=await import('../qianmu-comfy-lock-runtime.js?v=scene-navigation-test'),log=makeLog();let opened='';
  await versioned.navigateComfySceneTask(request(),{namespace,chatKey,getLogs:()=>[log],guard:async()=>{},present:id=>{opened=id;}});assert.equal(opened,'original-log');
  const host=element();await versioned.mountComfySceneReview({host,manager:{review:async()=>snapshot()},namespace,chatKey,current:()=>true,guard:async()=>{},openTask:()=>{}});
  assert.match(host.innerHTML,/data-scene-action="task"/);
});

test('real workbench entry mounts the task navigator and opens only the matched row in its existing log page',async()=>{
  const host=element(),state={view:'create',source:'comfy',logs:[makeLog()]},root={isConnected:true,querySelector:()=>host},effects=[];
  const other={dataset:{storyboardLog:'other'},open:false,scrollIntoView:()=>assert.fail('wrong row')},row={dataset:{storyboardLog:'original-log'},open:false,scrollIntoView:options=>effects.push(['scroll',options.block])};
  const manager={review:async()=>snapshot()},runtime={mountComfySceneReview,navigateComfySceneTask};
  const context=vm.createContext({root,MODAL_ID:'modal',storyboardState:()=>state,getChatKey:()=>chatKey,storyboardAdmissionEpoch:1,storyboardComfySceneRuntime:async()=>manager,
    featureRuntime:{load:async key=>key==='imageAdmission'?{resolveImageAccountNamespace:async()=>namespace}:runtime},confirmDialog:()=>assert.fail('unexpected confirmation'),toast:()=>{},applyQianmuIcons:()=>{},
    storyboardRememberPageScroll:value=>{assert.equal(value,root);effects.push(['remember']);},saveSettings:()=>effects.push(['save-view']),renderModal:()=>effects.push(['render']),
    document:{getElementById:id=>{assert.equal(id,'modal');return {querySelectorAll:selector=>{assert.equal(selector,'[data-storyboard-log]');return [other,row];}};}}});
  vm.runInContext(section('storyboardShowComfySceneLocks'),context);await context.storyboardShowComfySceneLocks(root);await host.onclick(click());
  assert.equal(state.view,'logs');assert.equal(row.open,true);assert.equal(other.open,false);assert.deepEqual(effects,[['remember'],['save-view'],['render'],['scroll','nearest']]);assert.deepEqual(state.logs,[makeLog()]);
});
