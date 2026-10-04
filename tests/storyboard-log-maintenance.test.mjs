import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');
const start=source.indexOf("  root.querySelector('.sd-storyboard-clear-logs')?.addEventListener");
const end=source.indexOf("  root.querySelectorAll('[data-storyboard-log]')",start);
assert.ok(start>=0&&end>start);

function fixture(){
  const f={state:{logs:[{id:'one'}],pipelineLogs:[{id:'pipeline'}]},cleared:0,saved:0,rendered:0,recoveryReset:0,notices:[],chat:'original'};
  const context=vm.createContext({state:f.state,settings:{},storyboardState:()=>f.state,storyboardAdmissionEpoch:1,getChatKey:()=>f.chat,
    storyboardPipelineArchiveEpoch:1,storyboardPipelineArchiveCache:new Map([['one',1]]),storyboardPipelineArchiveWrites:new Map([['one',1]]),storyboardPipelineArchiveHydration:{},
    storyboardActiveJobs:new Map(),storyboardQueue:[],storyboardQueuePendingCount:()=>0,storyboardQueueSettling:0,storyboardReceiveComfyImage:{pending:0},storyboardReceiveServiceImage:{pending:0},
    storyboardOriginalRecovery:{reset(){f.recoveryReset++;}},confirmDialog:async()=>true,
    blobStore:{blobStoreAvailable:()=>true,clearStoryboardPipelineLogs:async()=>{f.cleared++;}},saveSettings:()=>f.saved++,renderModal:()=>f.rendered++,toast:(...args)=>f.notices.push(args)});
  context.root={isConnected:true,querySelector:()=>({addEventListener:(_name,callback)=>f.click=callback})};
  vm.runInContext(source.slice(start,end),context);f.c=context;return f;
}

test('log tab renders without reconciling or saving unrelated gallery origins',()=>{
  let reconciles=0;const state={view:'logs'},c=vm.createContext({storyboardState:()=>state,storyboardReconcileGalleryLinks:()=>reconciles++,renderStoryboardLogs:()=>'<logs/>',htmlEscape:String,storyboardPageTitle:()=> 'Logs',storyboardPageKey:()=> 'logs',renderStoryboardNav:()=>'',storyboardVibeLibraryController:null});
  vm.runInContext(section('renderStoryboardTab'),c);
  assert.match(c.renderStoryboardTab(),/<logs\/>/);assert.equal(reconciles,0);
  state.view='create';c.renderStoryboardCreate=()=>'<create/>';assert.match(c.renderStoryboardTab(),/<create\/>/);assert.equal(reconciles,1);
});

test('clear remains diagnostic-only, preserves other records and confirms before archive removal',async()=>{
  const f=fixture();f.state.storyboardImages=[{id:'saved'}];await f.click();
  assert.equal(f.cleared,1);assert.equal(f.saved,1);assert.equal(f.rendered,1);assert.equal(f.recoveryReset,1);
  assert.equal(f.state.logs.length,0);assert.equal(f.state.pipelineLogs.length,0);assert.deepEqual(f.state.storyboardImages,[{id:'saved'}]);
});

for(const mode of ['active','queued','pending','settling','comfy','service'])test('stale clear icon cannot remove logs after '+mode+' work begins',async()=>{
  const f=fixture();f.c.confirmDialog=async()=>{if(mode==='active')f.c.storyboardActiveJobs.set('job',{});if(mode==='queued')f.c.storyboardQueue.push({});if(mode==='pending')f.c.storyboardQueuePendingCount=()=>1;if(mode==='settling')f.c.storyboardQueueSettling=1;if(mode==='comfy')f.c.storyboardReceiveComfyImage.pending=1;if(mode==='service')f.c.storyboardReceiveServiceImage.pending=1;return true;};
  await f.click();assert.equal(f.cleared,0);assert.equal(f.saved,0);assert.equal(f.state.logs.length,1);assert.equal(f.recoveryReset,0);
});

for(const mode of ['cancel','page','chat','account','owner','logs'])test('confirmation '+mode+' preserves logs without storage writes',async()=>{
  const f=fixture(),original=f.state;f.c.confirmDialog=async()=>{if(mode==='page')f.c.root.isConnected=false;if(mode==='chat')f.chat='next';if(mode==='account')f.c.storyboardAdmissionEpoch++;if(mode==='owner')f.c.settings={};if(mode==='logs')f.state={logs:[],pipelineLogs:[]};return mode!=='cancel';};
  await f.click();assert.equal(f.cleared,0);assert.equal(f.saved,0);assert.equal(original.logs.length,1);
});

test('archive failure keeps original summaries and successful stale archive completion cannot clear new owner state',async()=>{
  const failed=fixture();failed.c.blobStore.clearStoryboardPipelineLogs=async()=>{throw Error('archive unavailable');};await failed.click();
  assert.equal(failed.state.logs.length,1);assert.equal(failed.saved,0);assert.equal(failed.c.storyboardPipelineArchiveEpoch,1);
  const f=fixture(),original=f.state;f.c.blobStore.clearStoryboardPipelineLogs=async()=>{f.state={logs:[{id:'new'}],pipelineLogs:[]};f.c.storyboardPipelineArchiveCache.set('new',2);};
  await f.click();assert.equal(original.logs.length,1);assert.equal(f.state.logs[0].id,'new');assert.equal(f.c.storyboardPipelineArchiveCache.get('new'),2);assert.equal(f.saved,0);assert.equal(f.rendered,0);
});
