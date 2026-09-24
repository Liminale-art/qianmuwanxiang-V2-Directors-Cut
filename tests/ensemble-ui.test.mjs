import test from 'node:test';
import assert from 'node:assert/strict';
import {createStoryboardEnsembleController} from '../qianmu-ensemble-ui.js';
import {renderEnsembleRoutePanel,ensembleRouteTargets} from '../qianmu-ensemble-route-view.js';
import {createEnsembleStorage} from '../qianmu-ensemble-storage.js';
import * as core from '../qianmu-storyboard.js';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';
const namespace='st-user:ensemble-ui';
async function fixture({transport=streamCheckpointTransport(namespace),state=core.createStoryboardDefaults(),chatKey='chat-a',configureTarget,onPublish,onMount}={}){
  let active=true,changed=0,published=0,sequence=0;const mounts=[];
  const controller=createStoryboardEnsembleController({state,chatKey,isCurrent:()=>active,resolveNamespace:async()=>namespace,
    readTargets:()=>[{id:'nai',name:'测试线路',available:true,artistCapable:true},...state.routing.rules.filter(row=>row.id!=='nai').map(row=>({id:row.id,name:row.name,available:true,artistCapable:row.target.providerId==='novel'}))],readArtists:()=>[],configureTarget,
    changed:()=>changed++,publish:async()=>{published++;await onPublish?.();},uid:prefix=>prefix+'-'+(++sequence),
    createStore:options=>createEnsembleStorage({...options,createStorage:transport.createStorage}),
    mount:(root,{model})=>{const view={root,model,closed:false,ready:onMount?onMount(root,model):model.load(),close(){this.closed=true;}};mounts.push(view);return view;}});
  const root=()=>({isConnected:true,textContent:''});
  return {state,transport,controller,mounts,root,stop:()=>{active=false;},get counts(){return {changed,published};},close:()=>controller.dispose()};
}
function draft(model){model.edit();model.setField('name','留白');model.setField('routeId','nai');}

test('opening the real controller performs no migration, enable or write; remount keeps draft and reads cached files',async()=>{
  const f=await fixture();f.state.routing.enabled=true;
  try{assert.equal(await f.controller.mount(f.root()),true);const model=f.controller.model;draft(model);const reads=f.transport.calls.length;
    for(let n=0;n<12;n++){f.controller.detach();assert.equal(await f.controller.mount(f.root()),true);}
    assert.equal(f.controller.model,model);assert.equal(model.snapshot().draft.name,'留白');assert.equal(f.transport.calls.length,reads);
    assert.deepEqual(f.counts,{changed:0,published:0});assert.equal(f.state.routing.styleLibrary,undefined);assert.equal(f.state.routing.enabled,true);
    assert.ok(f.mounts.slice(0,-1).every(view=>view.closed));
  }finally{f.close();}
});

test('saved per-chat enable adopts native mode after confirmed ST save, disabling retains old rules without reactivating them',async()=>{
  const f=await fixture();f.state.routing.enabled=true;const old=JSON.stringify(f.state.routing.rules);
  try{const model=await f.controller.load();await model.setEnabled(true);assert.equal(f.state.routing.styleLibrary,true);assert.equal(f.counts.published,1);
    await model.setEnabled(false);assert.equal(f.state.routing.styleLibrary,true);assert.equal(f.state.routing.enabled,true);
    assert.equal(JSON.stringify(f.state.routing.rules),old);assert.equal(f.counts.published,1);assert.equal(f.counts.changed,5);
    assert.equal(core.normalizeStoryboardState(f.state).routing.styleLibrary,true);
  }finally{f.close();}
});

test('editing or saving styles and choosing entries do not silently replace an active legacy mode',async()=>{
  const f=await fixture();f.state.routing.enabled=true;
  try{const model=await f.controller.load();draft(model);await model.save();const id=model.snapshot().library.schemes[0].id;await model.toggleScheme(id);
    assert.equal(f.state.routing.styleLibrary,undefined);assert.equal(f.counts.published,0);assert.equal(f.counts.changed,4);
  }finally{f.close();}
});

test('a failed native selection write never adopts the new mode or retries and invalidates preparations on both boundaries',async()=>{
  const f=await fixture();try{const model=await f.controller.load();f.transport.hook=({path})=>{if(path==='/api/files/upload')throw Error('lost receipt');};
    await assert.rejects(model.setEnabled(true));assert.equal(f.state.routing.styleLibrary,undefined);assert.equal(f.counts.changed,2);assert.equal(f.counts.published,0);
    assert.equal(f.transport.calls.filter(row=>row.options.method==='POST').length,1);assert.equal(model.snapshot().selection.enabled,false);
  }finally{f.close();}
});

test('reopening after a login rejection creates a fresh verified model instead of retaining a permanently retired cache',async()=>{
  const f=await fixture();try{const old=await f.controller.load();f.transport.hook=({json})=>json({},401);
    await assert.rejects(old.refresh());assert.throws(()=>old.snapshot());f.transport.hook=null;
    const next=await f.controller.load();assert.notEqual(next,old);assert.equal(next.snapshot().ready,true);assert.equal(f.counts.published,0);
  }finally{f.close();}
});

test('a previously confirmed enabled choice restores native mode on another device without a file write',async()=>{
  const first=await fixture();let second;
  try{await (await first.controller.load()).setEnabled(true);first.close();const start=first.transport.calls.length;second=await fixture({transport:first.transport});
    await second.controller.load();assert.equal(second.state.routing.styleLibrary,true);assert.equal(second.counts.published,1);
    assert.equal(first.transport.calls.slice(start).some(row=>row.options.method==='POST'),false);
  }finally{first.close();second?.close();}
});

test('closing the view during a confirmed write keeps its save; retiring the chat prevents late local adoption',async()=>{
  for(const retire of [false,true]){
    const f=await fixture();try{const model=await f.controller.load();f.transport.hook=({path})=>{if(path==='/api/files/upload'){if(retire)f.stop();else f.controller.detach();}};
      if(retire){await assert.rejects(model.setEnabled(true));assert.equal(f.state.routing.styleLibrary,undefined);}
      else{await model.setEnabled(true);assert.equal(f.state.routing.styleLibrary,true);}
    }finally{f.close();}
  }
});

test('library saves publish once to each subscribed view, and unsubscribed views receive no later edits',async()=>{
  const f=await fixture();try{const model=await f.controller.load(),one=[],two=[];
    const remove=model.subscribe((_s,k)=>one.push(k));model.subscribe((_s,k)=>two.push(k));draft(model);remove();const count=one.length;
    await model.save();assert.equal(one.length,count);assert.ok(two.length>count);assert.equal(model.snapshot().busy,false);
  }finally{f.close();}
});

test('the scheme library is the only route panel regardless of unpublished legacy flags',()=>{
  for(const routing of [{},{enabled:true},{enabled:true,styleLibrary:true}]){
    const html=renderEnsembleRoutePanel({routing});assert.match(html,/sd-ensemble-library-host/);
    assert.doesNotMatch(html,/绘制线路|原镜组|手动生成|sd-storyboard-route-template|sd-storyboard-routing-enabled|sd-storyboard-add-route/);
  }
});

test('display targets expose only descriptive names and availability, with artist capability and fixed Comfy requirements',()=>{
  const state=core.createStoryboardDefaults();state.routing.rules=[{id:'n',name:'NAI',target:{providerId:'novel',modelId:state.profiles.novel.model}},
    {id:'c',name:'Comfy',target:{providerId:'comfy',modelId:'comfy-workflow'}}];
  const rows=ensembleRouteTargets(state,{providers:core.STORYBOARD_PROVIDER_REGISTRY,resolveBinding:core.resolveStoryboardProfileBinding,getCapabilities:core.getStoryboardCapabilities});
  assert.equal(rows[0].available,true);assert.equal(rows[0].artistCapable,true);assert.equal(rows[1].available,false);
  assert.doesNotMatch(JSON.stringify(rows),/apiKey|baseUrl|comfyWorkflow/);
});

test('same connected host coalesces attachment and preserves the existing mounted view',async()=>{
  const f=await fixture();try{const root=f.root();const first=f.controller.mount(root),second=f.controller.mount(root);assert.equal(first,second);await first;
    const view=f.mounts[0],reads=f.transport.calls.length;for(let i=0;i<12;i++)assert.equal(await f.controller.mount(root),true);
    assert.equal(f.mounts.length,1);assert.equal(view.closed,false);assert.equal(f.transport.calls.length,reads);
  }finally{f.close();}
});

test('a view readiness failure retires its mount so the visible retry really attaches again',async()=>{
  let attempts=0;const f=await fixture({onMount:(_root,model)=>++attempts===1?Promise.reject(Error('mount failed')):model.load()});
  try{
    let retry;const button={addEventListener:(_type,fn)=>{retry=fn;}},root={...f.root(),ownerDocument:{createElement:()=>button},append(){}};
    assert.equal(await f.controller.mount(root),false);assert.equal(f.mounts[0].closed,true);assert.equal(typeof retry,'function');
    retry();assert.equal(await f.controller.mount(root),true);assert.equal(attempts,2);assert.equal(f.mounts[1].closed,false);
  }finally{f.close();}
});

const chosen=model=>({target:{providerId:'novel',modelId:model,capabilityModelId:'nai-diffusion-5-full',connectionPresetId:'',parameterPresetId:''},artistCapable:true,label:'NovelAI · '+model});
test('new styles configure their own generation draft without first creating a separate route',async()=>{
  const f=await fixture({configureTarget:async()=>chosen('alias-a')});try{
    const model=await f.controller.load();model.edit();model.setField('name','水墨');await model.configure();
    assert.equal(f.state.routing.rules.length,0);assert.equal(f.counts.published,0);assert.equal(f.transport.calls.some(row=>row.options.method==='POST'),false);
    const target=model.snapshot().draft.configuredTarget;assert.equal(target.target.modelId,'alias-a');await model.save();
    assert.equal(f.state.routing.rules.length,1);assert.equal(f.state.routing.rules[0].id,target.id);assert.equal(f.state.routing.rules[0].target.modelId,'alias-a');
    const saved=model.snapshot().library.schemes[0];assert.equal(saved.binding.routeId,target.id);assert.equal(saved.configuredTarget,undefined);assert.equal(f.counts.published,1);
    model.edit(saved.id);await model.configure();model.cancelEdit();assert.equal(f.state.routing.rules.length,1);assert.equal(f.counts.published,1);
  }finally{f.close();}
});
test('repeated edits reuse a scheme-owned route and never modify another shared scheme binding',async()=>{
  let selected='alias-a';const f=await fixture({configureTarget:async()=>chosen(selected)});try{
    const model=await f.controller.load();model.edit();model.setField('name','one');await model.configure();await model.save();const row=model.snapshot().library.schemes[0],id=row.binding.routeId;
    selected='alias-b';model.edit(row.id);await model.configure();await model.save();assert.equal(f.state.routing.rules.length,1);assert.equal(f.state.routing.rules[0].id,id);assert.equal(f.state.routing.rules[0].target.modelId,'alias-b');
    model.edit();model.setField('name','two');model.setField('routeId',id);await model.save();selected='alias-c';model.edit(row.id);await model.configure();await model.save();
    assert.equal(f.state.routing.rules.length,2);assert.equal(f.state.routing.rules.find(item=>item.id===id).target.modelId,'alias-b');
    assert.notEqual(model.snapshot().library.schemes.find(item=>item.id===row.id).binding.routeId,id);
  }finally{f.close();}
});
test('cancelled target picking leaves the style and internal route draft untouched',async()=>{
  const f=await fixture({configureTarget:async()=>null});try{const model=await f.controller.load();model.edit();const before=model.snapshot().draft;await model.configure();assert.deepEqual(model.snapshot().draft,before);model.cancelEdit();assert.equal(f.state.routing.rules.length,0);assert.equal(f.counts.published,0);}finally{f.close();}
});
test('unknown save acknowledgement preserves the referenced route and blocks automatic resubmission',async()=>{
  const f=await fixture({configureTarget:async()=>chosen('alias-a')});try{const model=await f.controller.load();model.edit();model.setField('name','one');await model.configure();
    f.transport.hook=({path})=>{if(path==='/api/files/upload')throw Error('receipt lost');};await assert.rejects(model.save(),error=>error.writeState==='unconfirmed');
    assert.equal(f.state.routing.rules.length,1);const calls=f.transport.calls.length;await assert.rejects(model.save());assert.equal(f.transport.calls.length,calls);assert.equal(model.snapshot().needsRefresh,true);
  }finally{f.close();}
});

test('delayed settings publication and parent rerender preserve the draft and perform one scheme write',async()=>{
  let release,started;const entered=new Promise(resolve=>{started=resolve;}),pending=new Promise(resolve=>{release=resolve;});
  const f=await fixture({configureTarget:async()=>chosen('alias-a'),onPublish:async()=>{started();await pending;}});
  try{
    await f.controller.mount(f.root());const model=f.controller.model;model.edit();model.setField('name','watercolor');await model.configure();
    const save=model.save();await entered;f.controller.detach();await f.controller.mount(f.root());
    assert.equal(f.controller.model,model);assert.equal(model.snapshot().draft.name,'watercolor');assert.equal(model.snapshot().busy,true);
    assert.equal(f.transport.calls.filter(row=>row.options.method==='POST').length,0);
    await assert.rejects(model.save());release();await save;
    assert.equal(f.state.routing.rules.length,1);assert.equal(model.snapshot().library.schemes.length,1);
    const writes=f.transport.calls.filter(row=>row.options.method==='POST').map(row=>JSON.parse(row.options.body));
    assert.equal(writes.length,2,'one immutable document plus its head, not a second logical save');
    assert.equal(new Set(writes.map(row=>row.name)).size,2);assert.equal(f.counts.published,1);
  }finally{release();f.close();}
});

test('failed settings publication restores a scheme-owned route before any library write',async()=>{
  let failed=false,selected='alias-a';const f=await fixture({configureTarget:async()=>chosen(selected),onPublish:async()=>{if(failed)throw Error('settings unavailable');}});
  try{
    const model=await f.controller.load();model.edit();model.setField('name','one');await model.configure();await model.save();
    const saved=model.snapshot().library.schemes[0],before=structuredClone(f.state.routing.rules),posts=f.transport.calls.filter(row=>row.options.method==='POST').length;
    failed=true;selected='alias-b';model.edit(saved.id);await model.configure();await assert.rejects(model.save(),/settings unavailable/);
    assert.deepEqual(f.state.routing.rules,before);assert.equal(f.transport.calls.filter(row=>row.options.method==='POST').length,posts);
    assert.equal(model.snapshot().draft.name,'one');assert.equal(model.snapshot().library.schemes.length,1);
  }finally{f.close();}
});
