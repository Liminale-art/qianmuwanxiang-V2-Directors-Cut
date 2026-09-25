import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {collectProseAssistantLocalStorage as collect} from '../qianmu-prose-assistant-storage.js';
import {renderStorageBackupSection,collectionCleanupOptions,storageDiagnosticSnapshot,storageSettingsSnapshotWithoutDiagnostics,runStorageInventoryJobs,STORAGE_CATEGORY_LABELS} from '../qianmu-storage-backup-view.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const namespace='st-user:alice',account='st-user:'+createHash('sha256').update('alice').digest('hex');
const measured=()=>({namespace:account,status:'ready',scope:'current-account-local',estimated:true,bytes:1000,count:3,records:2,chats:1,markers:1,complete:1,failed:1,cancelled:1});

test('inventory keeps the host guard namespace separate from the hashed store key and never loads chat or uses model/server APIs',async()=>{
 let reads=0;const result=await collect({resolveNamespace:async()=>namespace,isCurrent:()=>true,store:{usage:async(key,{guard})=>{reads++;assert.equal(key,account);assert.equal(guard(),true);return {...measured(),secret:'discarded'};},close:()=>assert.fail('borrowed store')}});
 assert.equal(reads,1);assert.equal(result.namespace,namespace);assert.equal(result.bytes,1000);assert.equal(result.chats,1);assert.equal('secret' in result,false);assert.ok(Object.isFrozen(result));
});
test('unavailable or invalid observations never turn into zero, while account/page changes reject the whole observation',async()=>{
 for(const bad of [null,{...measured(),namespace:'foreign'},{...measured(),count:99}]){const result=await collect({resolveNamespace:async()=>namespace,isCurrent:()=>true,store:{usage:async()=>{if(bad===null)throw Error('PRIVATE');return bad;}}});assert.equal(result.status,'unavailable');assert.equal(result.bytes,null);assert.doesNotMatch(result.error,/PRIVATE/);}
 for(const mode of ['account','page']){let owner=namespace,live=true;await assert.rejects(collect({resolveNamespace:async()=>owner,isCurrent:()=>live,store:{usage:async()=>{if(mode==='account')owner='st-user:bob';else live=false;return measured();}}}),{code:'prose_assistant_storage_stale'});}
});
test('routine assistant row hides storage internals while explicit cleanup keeps the original risks and known bytes',()=>{
 const data={assistantStorage:measured()},html=renderStorageBackupSection(null,n=>`${n} B`,{data});assert.match(html,/<span>场外特助<\/span><span>暂未读取<\/span>/);assert.doesNotMatch(html,/逻辑估算|清空版本标记|不含未保存回复/);assert.equal(STORAGE_CATEGORY_LABELS.assistant,'场外特助');
 const choices=collectionCleanupOptions(data);assert.equal(choices.length,1);assert.equal(choices[0].bytes,1000);assert.match(choices[0].risk[0],/不可恢复.*不删除ST记录/);
 const failed=renderStorageBackupSection(null,String,{data:{assistantStorage:{status:'unavailable',error:'<bad>'}}});assert.match(failed,/<span>场外特助<\/span><span>暂未读取<\/span>/);assert.doesNotMatch(failed,/<bad>|<span>场外特助<\/span><span>0/);
});
test('extracted settings/diagnostic accounting snapshots preserve the original partition without mutating settings',()=>{
 const settings={value:1,logHistory:['API'],logOpenState:{a:true},imagegen:{model:'model',logs:['image'],pipelineLogs:['pipe']}},original=structuredClone(settings);
 assert.deepEqual(storageDiagnosticSnapshot(settings),{apiLogs:['API'],storyboardLogs:['image'],storyboardPipelineLogs:['pipe']});
 assert.deepEqual(storageSettingsSnapshotWithoutDiagnostics(settings),{value:1,logHistory:[],logOpenState:{},imagegen:{model:'model',logs:[],pipelineLogs:[]}});assert.deepEqual(settings,original);
 assert.deepEqual(storageDiagnosticSnapshot({logHistory:null,imagegen:{logs:1}}),{apiLogs:[],storyboardLogs:[],storyboardPipelineLogs:[]});
});

test('actual global inventory counts assistant once, apart from pending collections and never as recoverable or generic-cleanable cache',async()=>{
 const entry=await readFile(new URL('../index.js',import.meta.url),'utf8'),code=section('collectStorageInventory');
 let assistant={...measured(),namespace,native:{status:'ready',total:{bytes:9000000,count:50}}};const zero=()=>({status:'ready',bytes:0,count:0}),unknown=()=>({status:'unavailable',bytes:0,count:0});
 const context=vm.createContext({runStorageInventoryJobs,settings:{},storyboardAdmissionEpoch:1,navigator:{storage:{estimate:async()=>({usage:100000,quota:200000})}},
  collectionFloorTools:{storageSummary:async()=>({status:'unavailable',pending:{status:'ready',bytes:50,count:1}}),assistantStorageSummary:async valid=>{assert.equal(valid(),true);return assistant;}},
  notesSyncControls(){},getQianmuNotesStorage:async()=>zero(),focusClockLibrary:()=>({summary:async()=>zero()}),
  blobStore:{estimateBlobStoreUsage:async()=>({totalBytes:100,recoverableBytes:10,categories:[]}),auditOrphanedReaderBlobs:async()=>({}),classifyStoragePressure:()=>({})},
  featureRuntime:{load:async()=>({resolveImageAccountNamespace:async()=>namespace,manageImageAdmissionStorage:async()=>zero(),collectComfyStorage:async()=>unknown(),collectVibeStorage:async()=>unknown(),collectCharacterStorage:async()=>unknown(),collectStoryboardRestoreStorage:async()=>unknown(),collectStoryboardMappingStorage:async()=>unknown(),collectStoryboardCarrierStorage:async()=>unknown()})},
  storyboardManageImageChannels:async()=>zero(),storyboardImageServiceRuntime:async()=>({manage:async()=>zero()}),storyboardComfyRecoveryRuntime:async()=>({usage:async()=>zero()}),storageJsonBytes:()=>0,storageSettingsSnapshotWithoutDiagnostics,storageDiagnosticSnapshot,getChatStore:()=>({})});
 const progress=[];vm.runInContext(code,context);const result=await context.collectStorageInventory((done,total)=>progress.push([done,total]));assert.equal(result.trackedBytes,1150);assert.equal(result.recoverableBytes,10);assert.equal(result.manageableBytes,100);assert.equal(result.categories.find(row=>row.category==='assistant').bytes,1000);assert.equal(result.categories.find(row=>row.category==='collections').bytes,50);
 assert.deepEqual(progress[0],[0,20]);assert.deepEqual(progress.at(-1),[20,20]);assert.equal(progress.length,21);
 assistant={namespace,status:'unavailable',bytes:null,count:null};assert.equal((await context.collectStorageInventory()).trackedBytes,150);
 assistant={...measured(),namespace:'st-user:bob'};await assert.rejects(context.collectStorageInventory(),/账户已变化/);
 assert.match(entry,/data\.collectionStorage\?\.pending,data\.assistantStorage/,'unknown usage and incomplete warning both include assistant state');
});
