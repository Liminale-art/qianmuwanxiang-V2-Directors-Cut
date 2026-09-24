import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {cleanupProseAssistantStorage as cleanup} from '../qianmu-prose-assistant-storage.js';
import {collectionCleanupOptions,renderStorageBackupSection} from '../qianmu-storage-backup-view.js';
import {createStorageCleanupSession} from '../qianmu-storage-cleanup-session.js';
const namespace='st-user:alice',account='st-user:'+createHash('sha256').update('alice').digest('hex');
function fixture(){
 const f={live:true,owner:namespace,checks:0,writes:0,confirmations:[],rows:[{count:2}],accepted:true};
 f.plan={version:1,namespace:account,entries:f.rows};
 f.options={expectedNamespace:namespace,resolveNamespace:async()=>f.owner,isCurrent:()=>f.live,check:()=>{f.checks++;if(!f.live)throw Error('PRIVATE');},confirm:async(...args)=>{f.confirmations.push(args);return f.accepted;},otherModules:2,
  store:{planCleanup:async(key,{guard})=>{assert.equal(key,account);assert.equal(guard(),true);return f.plan;},clearPlan:async(key,plan,{confirmed,guard})=>{assert.equal(key,account);assert.equal(plan,f.plan);assert.equal(confirmed,true);assert.equal(guard(),true);f.writes++;return {status:'complete',clearedConversations:1,clearedTurns:2,retainedRevisionMarkers:true};},close:()=>assert.fail('borrowed store must remain open')}};return f;
}
test('explicit second confirmation owns exact observed plan and explains original data, markers and skipped modules',async()=>{
 const f=fixture(),result=await cleanup(f.options);assert.equal(f.writes,1);assert.equal(result.clearedTurns,2);assert.equal(f.confirmations.length,1);
 for(const value of ['不可恢复','1 个会话、2 轮','复制留存','不删除正文','版本标记','其他 2 个模块本次不执行','新增记录不清'])assert.ok(f.confirmations[0][1].includes(value),value);
 assert.doesNotMatch(f.confirmations[0][1],/alice|apiKey|PRIVATE/);
 assert.match(f.confirmations[0][0],/旧本机副本/);assert.match(f.confirmations[0][1],/不删除ST中的助手记录/);
});
test('cancel and empty account do not clear records, while context/account change after confirmation invalidates permission',async()=>{
 for(const accepted of [false,null,1]){const f=fixture();f.accepted=accepted;assert.equal((await cleanup(f.options)).status,'cancelled');assert.equal(f.writes,0);}
 const empty=fixture();empty.plan.entries=[];assert.equal((await cleanup(empty.options)).status,'empty');assert.equal(empty.confirmations.length,0);assert.equal(empty.writes,0);
 for(const mode of ['account','page','task']){const f=fixture();f.options.confirm=async()=>{if(mode==='account')f.owner='st-user:bob';else if(mode==='page')f.live=false;else f.options.check=()=>{throw Error('PRIVATE');};return true;};
  // The check closure is captured on entry, just as the real lock is.
  if(mode==='task'){let changed=false;f.options.check=()=>{if(changed)throw Error('PRIVATE');};f.options.confirm=async()=>{changed=true;return true;};}
  await assert.rejects(cleanup(f.options),{code:'prose_assistant_storage_stale'});assert.equal(f.writes,0);
 }
});
test('conflict is explicit and unknown failures never leak storage content or claim completed deletion',async()=>{
 for(const code of ['prose_assistant_history_conflict','QuotaExceededError']){const f=fixture();f.options.store.clearPlan=async()=>{throw Object.assign(Error('PRIVATE dialogue/key'),{code});};await assert.rejects(cleanup(f.options),error=>{assert.doesNotMatch(error.message,/PRIVATE|dialogue\/key/);assert.match(error.message,code.includes('conflict')?/整批未清理/:/未能确认完成/);return true;});}
 const f=fixture();f.options.store.clearPlan=async()=>{f.live=false;return {status:'complete'};};await assert.rejects(cleanup(f.options),{code:'prose_assistant_storage_stale'});
});
test('chooser exposes originals only when verified nonempty, does not offer markers as clearable content, and enables the sole assistant item',()=>{
 const data={assistantStorage:{status:'ready',count:2,bytes:100}};const items=collectionCleanupOptions(data);assert.equal(items.length,1);assert.equal(items[0].id,'__assistant__');assert.equal(items[0].risk[1],true);assert.match(items[0].label,/当前账户 · 本机/);
 for(const state of [{status:'unavailable',count:2,bytes:100},{status:'ready',count:0,bytes:100}])assert.equal(collectionCleanupOptions({assistantStorage:state}).length,0);
 const html=renderStorageBackupSection(null,String,{data,ready:true});assert.match(html,/class="sd-btn sd-primary sd-storage-clean" >/);
});
test('shared cleanup lock excludes opening or active assistant and invalidates later activity; actual entry routes assistant before any generic deletion',async()=>{
 let assistant=true;const owner={},root={isConnected:true},session=createStorageCleanupSession({owner:()=>owner,scope:()=>1,epoch:()=>1,activity:()=>({proseAssistant:assistant})});assert.equal(session.begin(root),null);
 assistant=false;const token=session.begin(root);assert.ok(token);assistant=true;assert.throws(()=>token.check());assistant=false;assert.throws(()=>token.check());token.release();assert.equal(session.busy,false);
 const source=await readFile(new URL('../index.js',import.meta.url),'utf8'),start=source.indexOf("onClick(root.querySelector('.sd-storage-clean'), async () => {");const handler=source.slice(start,source.indexOf("onClick(root.querySelector('.sd-storage-chat-clean')",start));
 assert.ok(handler.indexOf("selected.includes('__assistant__')")<handler.indexOf('blobStore.clearStorageItems'));assert.match(handler,/cleanupAssistant\(root,confirmDialog,\(\)=>cleanup.check\(\),inventory\?\.assistantStorage\?\.namespace,selected.length-1\);cleanup.check\(\);await refreshStorageInventory\(true\);return;/);
 assert.match(source,/proseAssistant: collectionFloorTools.assistantBusy===true/);
});
