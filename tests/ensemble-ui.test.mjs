import test from 'node:test';
import assert from 'node:assert/strict';
import {createStoryboardEnsembleController} from '../qianmu-ensemble-ui.js';
import {renderEnsembleRoutePanel,ensembleRouteTargets} from '../qianmu-ensemble-route-view.js';
import {createEnsembleStorage} from '../qianmu-ensemble-storage.js';
import * as core from '../qianmu-storyboard.js';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';
const namespace='st-user:ensemble-ui';
async function fixture({transport=streamCheckpointTransport(namespace),state=core.createStoryboardDefaults(),chatKey='chat-a'}={}){
  let active=true,changed=0,published=0,sequence=0;const mounts=[];
  const controller=createStoryboardEnsembleController({state,chatKey,isCurrent:()=>active,resolveNamespace:async()=>namespace,
    readTargets:()=>[{id:'nai',name:'测试线路',available:true,artistCapable:true}],readArtists:()=>[],
    changed:()=>changed++,publish:async()=>published++,uid:prefix=>prefix+'-'+(++sequence),
    createStore:options=>createEnsembleStorage({...options,createStorage:transport.createStorage}),
    mount:(root,{model})=>{const view={root,model,closed:false,ready:model.load(),close(){this.closed=true;}};mounts.push(view);return view;}});
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

test('new route panel always offers the library and technical routes but never old narrative template controls after adoption',()=>{
  const state=core.createStoryboardDefaults(),deps={targetOptions:()=>'<span>model</span>',shotTypes:{portrait:'人物'},templates:core.STORYBOARD_SHOT_GROUP_TEMPLATES,policy:{minImages:1,maxImages:3,concurrency:2}};
  let html=renderEnsembleRoutePanel(state,deps);assert.match(html,/sd-ensemble-library-host/);assert.match(html,/添加绘制线路/);assert.doesNotMatch(html,/sd-storyboard-route-template/);
  state.routing.enabled=true;html=renderEnsembleRoutePanel(state,deps);assert.match(html,/原镜组配置/);assert.match(html,/sd-storyboard-route-template/);
  state.routing.styleLibrary=true;html=renderEnsembleRoutePanel(state,deps);assert.doesNotMatch(html,/sd-storyboard-route-template|sd-storyboard-routing-enabled/);
});

test('display targets expose only descriptive names and availability, with artist capability and fixed Comfy requirements',()=>{
  const state=core.createStoryboardDefaults();state.routing.rules=[{id:'n',name:'NAI',target:{providerId:'novel',modelId:state.profiles.novel.model}},
    {id:'c',name:'Comfy',target:{providerId:'comfy',modelId:'comfy-workflow'}}];
  const rows=ensembleRouteTargets(state,{providers:core.STORYBOARD_PROVIDER_REGISTRY,resolveBinding:core.resolveStoryboardProfileBinding,getCapabilities:core.getStoryboardCapabilities});
  assert.equal(rows[0].available,true);assert.equal(rows[0].artistCapable,true);assert.equal(rows[1].available,false);
  assert.doesNotMatch(JSON.stringify(rows),/apiKey|baseUrl|comfyWorkflow/);
});
