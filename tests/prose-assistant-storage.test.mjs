import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {collectProseAssistantLocalStorage as collect} from '../qianmu-prose-assistant-storage.js';
import {renderStorageBackupSection,storageDiagnosticSnapshot,storageSettingsSnapshotWithoutDiagnostics,STORAGE_CATEGORY_LABELS} from '../qianmu-storage-backup-view.js';
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
test('resource row explains local logical estimates and unsaved exclusions without offering destructive generic cleanup',()=>{
 const html=renderStorageBackupSection(null,n=>`${n} B`,{data:{assistantStorage:measured()}});assert.match(html,/场外特助 · 当前账户旧本机副本/);assert.match(html,/1 个会话 · 3 轮问答 · 1000 B 逻辑估算/);assert.match(html,/完整 1 · 失败 1 · 停止 1/);assert.match(html,/1 份清空版本标记/);assert.match(html,/不含未保存回复/);assert.match(html,/非可重建缓存/);assert.equal(STORAGE_CATEGORY_LABELS.assistant,'场外特助');
 const failed=renderStorageBackupSection(null,String,{data:{assistantStorage:{status:'unavailable',error:'<bad>'}}});assert.match(failed,/&lt;bad&gt;/);assert.doesNotMatch(failed,/<bad>|0 个会话/);
});
test('extracted settings/diagnostic accounting snapshots preserve the original partition without mutating settings',()=>{
 const settings={value:1,logHistory:['API'],logOpenState:{a:true},imagegen:{model:'model',logs:['image'],pipelineLogs:['pipe']}},original=structuredClone(settings);
 assert.deepEqual(storageDiagnosticSnapshot(settings),{apiLogs:['API'],storyboardLogs:['image'],storyboardPipelineLogs:['pipe']});
 assert.deepEqual(storageSettingsSnapshotWithoutDiagnostics(settings),{value:1,logHistory:[],logOpenState:{},imagegen:{model:'model',logs:[],pipelineLogs:[]}});assert.deepEqual(settings,original);
 assert.deepEqual(storageDiagnosticSnapshot({logHistory:null,imagegen:{logs:1}}),{apiLogs:[],storyboardLogs:[],storyboardPipelineLogs:[]});
});

test('actual global inventory counts assistant once, apart from pending collections and never as recoverable or generic-cleanable cache',async()=>{
 const entry=await readFile(new URL('../index.js',import.meta.url),'utf8'),code=entry.slice(entry.indexOf('async function collectStorageInventory()'),entry.indexOf('async function storageInventoryScope()'));
 let assistant={...measured(),namespace,native:{status:'ready',total:{bytes:9000000,count:50}}};const zero=()=>({status:'ready',bytes:0,count:0}),unknown=()=>({status:'unavailable',bytes:0,count:0});
 const context=vm.createContext({settings:{},storyboardAdmissionEpoch:1,navigator:{storage:{estimate:async()=>({usage:100000,quota:200000})}},
  collectionFloorTools:{storageSummary:async()=>({status:'unavailable',pending:{status:'ready',bytes:50,count:1}}),assistantStorageSummary:async valid=>{assert.equal(valid(),true);return assistant;}},
  notesSyncControls(){},getQianmuNotesStorage:async()=>zero(),focusClockLibrary:()=>({summary:async()=>zero()}),
  blobStore:{estimateBlobStoreUsage:async()=>({totalBytes:100,recoverableBytes:10,categories:[]}),auditOrphanedReaderBlobs:async()=>({}),classifyStoragePressure:()=>({})},
  featureRuntime:{load:async()=>({resolveImageAccountNamespace:async()=>namespace,manageImageAdmissionStorage:async()=>zero(),collectComfyStorage:async()=>unknown(),collectVibeStorage:async()=>unknown(),collectCharacterStorage:async()=>unknown(),collectStoryboardRestoreStorage:async()=>unknown(),collectStoryboardMappingStorage:async()=>unknown(),collectStoryboardCarrierStorage:async()=>unknown()})},
  storyboardManageImageChannels:async()=>zero(),storyboardImageServiceRuntime:async()=>({manage:async()=>zero()}),storyboardComfyRecoveryRuntime:async()=>({usage:async()=>zero()}),storageJsonBytes:()=>0,storageSettingsSnapshotWithoutDiagnostics,storageDiagnosticSnapshot,getChatStore:()=>({})});
 vm.runInContext(code,context);const result=await context.collectStorageInventory();assert.equal(result.trackedBytes,1150);assert.equal(result.recoverableBytes,10);assert.equal(result.manageableBytes,100);assert.equal(result.categories.find(row=>row.category==='assistant').bytes,1000);assert.equal(result.categories.find(row=>row.category==='collections').bytes,50);
 assistant={namespace,status:'unavailable',bytes:null,count:null};assert.equal((await context.collectStorageInventory()).trackedBytes,150);
 assistant={...measured(),namespace:'st-user:bob'};await assert.rejects(context.collectStorageInventory(),/账户已变化/);
 assert.match(entry,/data\.collectionStorage\?\.pending,data\.assistantStorage/,'unknown usage and incomplete warning both include assistant state');
});
