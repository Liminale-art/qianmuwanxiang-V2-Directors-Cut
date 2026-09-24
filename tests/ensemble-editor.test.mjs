import test from 'node:test';
import assert from 'node:assert/strict';
import {createEnsembleStorage} from '../qianmu-ensemble-storage.js';
import {createEnsembleLibraryEditor} from '../qianmu-ensemble-editor.js';
import {renderEnsembleLibrary} from '../qianmu-ensemble-view.js';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';
const namespace='st-user:editor-test';
async function fixture({chatKey='chat-a',transport=streamCheckpointTransport(namespace),onChange}={}){
  let active=true,sequence=0;const events=[],store=await createEnsembleStorage({namespace,chatKey,isCurrent:()=>active,resolveNamespace:async()=>namespace,createStorage:transport.createStorage});
  const targets=[{id:'nai',name:'NAI测试方案',providerLabel:'NAI',artistCapable:true,available:true},{id:'comfy',name:'固定工作流',providerLabel:'Comfy',artistCapable:false,available:true}];
  const artists=[{id:'ink',name:'水墨'}];
  const editor=createEnsembleLibraryEditor({store,chatKey,isCurrent:()=>active,readTargets:()=>targets,readArtists:()=>artists,uid:prefix=>prefix+'-'+(++sequence),onChange:(state,kind)=>{events.push({state,kind});return onChange?.(state,kind);}});
  return {editor,store,transport,events,targets,artists,stop:()=>{active=false;},close(){editor.close();store.close();}};
}
function fill(editor){editor.edit();editor.setField('name','留白水墨');editor.setField('description','静默的室内与回忆');editor.setField('tagText','ink, 留白，ink');editor.setField('routeId','nai');editor.setField('artistPresetId','ink');}
const posts=f=>f.transport.calls.filter(row=>row.options.method==='POST').length;
test('opening coalesces reads, repeated renders do not fetch, and empty chat choices remain off',async()=>{
  const f=await fixture();try{await Promise.all([f.editor.load(),f.editor.load()]);assert.equal(f.transport.calls.length,2);assert.equal(f.editor.snapshot().selection.enabled,false);
    for(let i=0;i<20;i++){renderEnsembleLibrary(f.editor.snapshot());await f.editor.load();}assert.equal(f.transport.calls.length,2);assert.equal(posts(f),0);
  }finally{f.close();}
});
test('explicit save writes a normalized shared style without credentials or a duplicate drawing configuration',async()=>{
  const f=await fixture();try{await f.editor.load();fill(f.editor);const draft=f.editor.snapshot().draft;await f.editor.save();const saved=(await f.store.readLibrary()).value.schemes[0];
    assert.equal(saved.id,draft.id);assert.deepEqual(saved.tags,['ink','留白']);assert.equal(saved.binding.routeId,'nai');assert.equal(saved.binding.artistPresetId,'ink');assert.equal(f.editor.snapshot().draft,null);assert.equal(f.editor.snapshot().message,'方案已保存');
    assert.doesNotMatch(JSON.stringify(saved),/apiKey|baseUrl|tagText|workflow/);assert.equal(posts(f),2);
  }finally{f.close();}
});
test('plain field edits are draft-only notifications, so input cursors need no form rerender or server call',async()=>{
  const f=await fixture();try{await f.editor.load();fill(f.editor);const count=f.transport.calls.length;f.events.length=0;
    for(const value of ['a','ab','','中','中文'])f.editor.setField('name',value);
    assert.ok(f.events.every(event=>event.kind==='draft'));assert.equal(f.transport.calls.length,count);assert.equal(f.editor.snapshot().draft.name,'中文');
  }finally{f.close();}
});
test('search and archive visibility filter locally and emit only list updates',async()=>{
  const f=await fixture();try{await f.editor.load();fill(f.editor);await f.editor.save();const count=f.transport.calls.length;
    f.editor.setSearch('留白');assert.match(renderEnsembleLibrary(f.editor.snapshot()),/留白水墨/);f.editor.setSearch('不存在');assert.match(renderEnsembleLibrary(f.editor.snapshot()),/没有匹配/);
    f.editor.showArchived(true);assert.equal(f.transport.calls.length,count);assert.equal(f.events.at(-1).kind,'list');
  }finally{f.close();}
});
test('only current chat selection changes, while the global style remains visible in another chat',async()=>{
  const f=await fixture();let other;try{await f.editor.load();fill(f.editor);await f.editor.save();const key=f.editor.snapshot().library.schemes[0].id;
    await f.editor.toggleScheme(key);await f.editor.setEnabled(true);await f.editor.setStyleLock(false);
    other=await fixture({chatKey:'other',transport:f.transport});await other.editor.load();assert.equal(other.editor.snapshot().library.schemes.length,1);assert.equal(other.editor.snapshot().selection.enabled,false);
    assert.deepEqual(other.editor.snapshot().selection.schemeIds,[]);assert.equal((await f.store.readSelection()).value.styleLock,false);
  }finally{f.close();other?.close();}
});
test('without a chat the global editor works, but enabled sets and style locks cannot invent a chat',async()=>{
  const f=await fixture({chatKey:null});try{await f.editor.load();fill(f.editor);await f.editor.save();await assert.rejects(f.editor.setEnabled(true),{code:'ensemble_editor'});
    assert.equal(f.editor.snapshot().selection,null);assert.equal([...f.transport.files.keys()].some(key=>key.includes('ensemble-chat-')),false);
  }finally{f.close();}
});
test('archiving and restoring preserve original style fields, chat selection and immutable server bodies',async()=>{
  const f=await fixture();try{await f.editor.load();fill(f.editor);await f.editor.save();const original=f.editor.snapshot().library.schemes[0];await f.editor.toggleScheme(original.id);const files=[...f.transport.files.keys()];
    await f.editor.archive(original.id);assert.equal(f.editor.snapshot().library.schemes[0].archived,true);assert.deepEqual(f.editor.snapshot().selection.schemeIds,[original.id]);
    await assert.rejects(f.editor.toggleScheme(original.id),{code:'ensemble_editor'});await f.editor.archive(original.id);
    const restored=f.editor.snapshot().library.schemes[0];assert.equal(restored.archived,false);assert.deepEqual(restored.binding,original.binding);assert.notEqual(restored.revision,original.revision);assert.ok(files.every(key=>f.transport.files.has(key)));
  }finally{f.close();}
});
test('another client update causes a conflict without overwriting its version or discarding the local draft',async()=>{
  const f=await fixture();let other;try{await f.editor.load();fill(f.editor);await f.editor.save();const key=f.editor.snapshot().library.schemes[0].id;f.editor.edit(key);f.editor.setField('name','本页草稿');
    other=await fixture({transport:f.transport});await other.editor.load();other.editor.edit(key);other.editor.setField('name','另一端已保存');await other.editor.save();
    await assert.rejects(f.editor.save(),{code:'st_account_storage_conflict'});assert.equal(f.editor.snapshot().draft.name,'本页草稿');assert.equal(f.editor.snapshot().needsRefresh,true);
    const before=posts(f);await assert.rejects(f.editor.save(),{code:'ensemble_editor'});assert.equal(posts(f),before);
    await f.editor.refresh();assert.equal(f.editor.snapshot().library.schemes[0].name,'另一端已保存');assert.equal(f.editor.snapshot().draft.name,'本页草稿');assert.equal(f.editor.snapshot().needsRefresh,true);
    f.editor.cancelEdit();f.editor.edit(key);assert.equal(f.editor.snapshot().draft.name,'另一端已保存');
  }finally{f.close();other?.close();}
});
test('unconfirmed writes are attempted once and retain the draft until explicit refresh and reopening',async()=>{
  const f=await fixture();try{await f.editor.load();fill(f.editor);f.transport.hook=({path})=>{if(path==='/api/files/upload')throw Error('lost acknowledgement');};
    await assert.rejects(f.editor.save(),error=>error.writeState==='unconfirmed');assert.equal(posts(f),1);assert.equal(f.editor.snapshot().needsRefresh,true);assert.equal(f.editor.snapshot().draft.name,'留白水墨');
    await assert.rejects(f.editor.save(),{code:'ensemble_editor'});assert.equal(posts(f),1);
  }finally{f.close();}
});
test('missing routes or unsupported artists require repair instead of switching to the first available binding',async()=>{
  const f=await fixture();try{await f.editor.load();fill(f.editor);f.editor.setField('routeId','comfy');await assert.rejects(f.editor.save(),{code:'ensemble_editor'});assert.equal(posts(f),0);
    f.editor.setField('artistPresetId','');f.targets[1].available=false;await assert.rejects(f.editor.save(),{code:'ensemble_editor'});assert.equal(posts(f),0);
  }finally{f.close();}
});
test('account invalidation retires visible snapshots rather than redrawing another account under old data',async()=>{
  const f=await fixture();try{await f.editor.load();fill(f.editor);f.stop();assert.throws(()=>f.editor.setField('name','new'),{code:'ensemble_editor'});
    const view=f.events.at(-1).state;assert.equal(view.library,null);assert.equal(view.draft,null);assert.equal(view.selection,null);assert.deepEqual(view.targets,[]);assert.equal(posts(f),0);
  }finally{f.close();}
});
test('a native login rejection retires editor snapshots even before the host notices a session change',async()=>{
  const f=await fixture();try{await f.editor.load();fill(f.editor);await f.editor.save();f.editor.edit('style-1');
    f.transport.hook=({json})=>json({},401);await assert.rejects(f.editor.refresh(),{code:'st_account_storage_account'});
    assert.equal(f.events.at(-1).state.library,null);assert.equal(f.events.at(-1).state.draft,null);assert.deepEqual(f.events.at(-1).state.targets,[]);
    const requests=f.transport.calls.length;await assert.rejects(f.editor.refresh(),{code:'ensemble_editor'});assert.equal(f.transport.calls.length,requests);
  }finally{f.close();}
});
test('closing during a read prevents late repaint and does not close the borrowed storage',async()=>{
  const f=await fixture();let release,reached;const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{reached=r;});
  f.transport.hook=async()=>{reached();await gate;};const loading=f.editor.load(),failure=assert.rejects(loading,{code:'ensemble_editor'});await started;
  const count=f.events.length;f.editor.close();release();await failure;assert.equal(f.events.length,count);f.transport.hook=null;assert.equal((await f.store.readLibrary()).exists,false);f.store.close();
});
test('display observer failures cannot turn a confirmed ST save into failure or trigger a retry',async()=>{
  const f=await fixture({onChange:async()=>{throw Error('observer');}});try{await f.editor.load();fill(f.editor);await f.editor.save();assert.equal((await f.store.readLibrary()).value.schemes.length,1);assert.equal(posts(f),2);}finally{f.close();}
});
test('the renderer escapes names, tags, descriptions and bindings while using local 2.25px SVG controls',async()=>{
  const f=await fixture();try{await f.editor.load();fill(f.editor);f.editor.setField('name','<img src=x onerror=alert(1)>');f.editor.setField('description','</textarea><script>alert(1)</script>');await f.editor.save();
    const html=renderEnsembleLibrary(f.editor.snapshot());assert.doesNotMatch(html,/<img|<script|onerror="|https?:\/\//);assert.match(html,/&lt;img/);assert.match(html,/stroke-width="2.25"/);assert.doesNotMatch(html,/API Key|password|requestPath/);
  }finally{f.close();}
});

test('style list and edit surface expose no route-management or development instructions',async()=>{
  const f=await fixture();try{await f.editor.load();let html=renderEnsembleLibrary(f.editor.snapshot());
    assert.doesNotMatch(html,/全局方案库|已归档|线路|复用|保存 Key|镜头数量/);assert.doesNotMatch(html,/sd-ensemble-editor/);
    fill(f.editor);html=renderEnsembleLibrary(f.editor.snapshot());assert.match(html,/生成方式|适用画面/);assert.doesNotMatch(html,/data-ensemble-list|data-ensemble-search|绘制线路|画师绑定|复用|保存 Key/);
    await f.editor.save();const row=f.editor.snapshot().library.schemes[0];f.editor.edit(row.id);assert.match(renderEnsembleLibrary(f.editor.snapshot()),/data-ensemble-action="remove"/);
    await f.editor.remove(row.id);assert.equal(f.editor.snapshot().library.schemes.length,0);assert.equal(f.editor.snapshot().draft,null);
  }finally{f.close();}
});
