import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {exerciseImageInfo} from './helpers/image-info-edit-fixture.mjs';
import {storyboardFunctionSource as fn} from './helpers/storyboard-form-fixture.mjs';

const snapshot={source:'comfy',profile:{model:'comfy-workflow'},payload:{prompt:'red hair, blue coat',negative:'blur',shotSpec:{characters:[]},parameters:{}}};
for(const mode of ['new','existing','duplicate-case','remove','save-failure','membership-limit','foreign-owner'])test('actual detail collection mutation '+mode,async()=>{
  const collections=[{id:'old',name:'Old folder'},{id:'existing',name:'Scenes'}];
  const ids=mode==='membership-limit'?Array.from({length:31},(_,i)=>'legacy-'+i):['old'];
  const record={id:'image',floor:0,source:'comfy',collectionIds:ids,collectionId:ids[0]},before=structuredClone(record),beforeCollections=structuredClone(collections);let saves=0,namespace='st-user:fixture';
  const result=await exerciseImageInfo({snapshot,record,collections,inspectOnly:true,readonly:true,readNamespace:async()=>namespace,
    save:async()=>{saves++;if(mode==='save-failure')throw Error('save unavailable');},
    onOpen:async options=>{assert.equal(options.readonly,true);assert.equal(options.onGenerate,undefined);if(mode==='foreign-owner')namespace='st-user:other';
      const choice=mode==='remove'?{id:'old',checked:false}:mode==='existing'?{id:'existing',checked:true}:mode==='duplicate-case'?{name:'sCeNeS',checked:true}:{name:'New folder',checked:true};
      await options.onCollections(choice,options.guard);
    }});
  if(['save-failure','membership-limit','foreign-owner'].includes(mode)){
    assert.ok(result.error);assert.deepEqual(record,before);assert.deepEqual(collections,beforeCollections);assert.equal(saves,mode==='save-failure'?1:0);
  }else{
    assert.equal(result.error,undefined);assert.equal(saves,1);assert.equal(result.drafts.length,0);
    if(mode==='remove')assert.deepEqual(Array.from(record.collectionIds),[]);
    else{assert.equal(record.collectionIds[0],'old');assert.equal(record.collectionIds.length,2);}
    if(mode==='new'){assert.equal(collections.length,3);assert.equal(collections[2].name,'New folder');assert.equal(record.collectionIds[1],collections[2].id);}
    if(['existing','duplicate-case'].includes(mode)){assert.equal(collections.length,2);assert.equal(record.collectionIds[1],'existing');}
  }
});
test('actual collection removal preserves all unrelated historical memberships beyond display and add limits',async()=>{
  const record={id:'image',floor:0,collectionIds:Array.from({length:120},(_,i)=>'legacy-'+i),collectionId:'legacy-0'};
  const result=await exerciseImageInfo({snapshot,record,inspectOnly:true,save:async()=>{},onOpen:async options=>options.onCollections({id:'legacy-80',checked:false},options.guard)});
  assert.equal(result.error,undefined);assert.equal(record.collectionIds.length,119);assert.ok(record.collectionIds.includes('legacy-119'));assert.ok(!record.collectionIds.includes('legacy-80'));
});
test('failed new collection does not remove a concurrent attachment in its original gallery after account changes',async()=>{
  const collections=[],record={id:'image',floor:0,collectionIds:['old'],collectionId:'old'},other={id:'other',collectionIds:[]};let namespace='st-user:fixture',activeRecords=[record,other];
  const result=await exerciseImageInfo({snapshot,record,collections,readRecords:()=>activeRecords,inspectOnly:true,readNamespace:async()=>namespace,
    save:async()=>{other.collectionIds=[collections[0].id];namespace='st-user:new';activeRecords=[{id:'foreign'}];throw Error('late save failed');},
    onOpen:async options=>options.onCollections({name:'Keep referenced collection',checked:true},options.guard)});
  assert.match(result.error.message,/late save failed/);assert.deepEqual(record.collectionIds,['old']);assert.equal(collections.length,1);assert.equal(other.collectionIds[0],collections[0].id);
});
for(const mode of ['save','cancelled-owner','owner-after-await','save-failure'])test('tag write is explicit and guarded '+mode,async()=>{
  let current=mode!=='cancelled-owner',saves=0,reads=0;const record={id:'a',tags:['original']},editor={dataset:{mediaTagEditor:'gallery:a'},_qianmuGalleryCurrent:()=>current,
    _qianmuGalleryVerify:async()=>{if(mode==='owner-after-await')current=false;}};
  const c=vm.createContext({storyboardGalleryRecords:()=>{reads++;return [record];},saveMetadata:async()=>{saves++;if(mode==='save-failure')throw Error('write failed');}});
  vm.runInContext(fn('storyboardPersistMediaTagEditor'),c);
  if(mode==='save-failure')await assert.rejects(c.storyboardPersistMediaTagEditor(editor,['new']),/write failed/);
  else assert.equal(await c.storyboardPersistMediaTagEditor(editor,['new']),mode==='save');
  assert.deepEqual(record.tags,mode==='save'?['new']:['original']);assert.equal(saves,['save','save-failure'].includes(mode)?1:0);assert.equal(reads,['save','save-failure'].includes(mode)?1:0);
});
