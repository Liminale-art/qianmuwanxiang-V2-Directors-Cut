import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createStoryboardDefaults} from '../qianmu-storyboard.js';
import {captureStoryboardVibeRecipe} from '../qianmu-vibe-recipe.js';
import * as references from '../qianmu-comfy-references.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==','base64');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(){
  const state=createStoryboardDefaults();Object.assign(state,{view:'assets',assetView:'vibes'});
  const inputs=Object.fromEntries(Object.entries({name:'Light',url:'https://images.test/vibe.png',gallery:'',strength:'0',info:'0'}).map(([key,value])=>[`.sd-storyboard-vibe-${key}`,{value}]));
  const file={files:[]},button={disabled:false},root={isConnected:true,querySelector:key=>key==='.sd-storyboard-vibe-file'?file:key==='.sd-storyboard-create-vibe'?button:inputs[key]};
  const env={state,account:'st-user:one',chat:'chat-one',gallery:[],saved:0,writes:[],notices:[],confirm:async()=>true,upload:async()=>'/user/images/Qianmu/vibe.png'};
  const context=vm.createContext({createStoryboardDefaults,captureStoryboardVibeRecipe,storyboardState:()=>env.state,storyboardAdmissionEpoch:1,activeTab:'imagegen',
    getChatKey:()=>env.chat,getCharacterName:()=> 'Qianmu',storyboardGalleryRecords:()=>env.gallery,uid:()=> 'new-vibe',
    featureRuntime:{load:async key=>key==='imageAdmission'?{resolveImageAccountNamespace:async()=>env.account}:references},
    storyboardUtilsModule:async()=>({saveBase64AsFile:async(...args)=>{env.writes.push(args);return env.upload();}}),
    confirmDialog:(...args)=>env.confirm(...args),toast:message=>env.notices.push(message),saveSettings:()=>env.saved++,renderModal:()=>{}});
  vm.runInContext(['storyboardVibeAmount','storyboardSafeUrl','storyboardSaveVibeFromForm','storyboardDeleteVibe'].map(section).join('\n'),context);
  return {env,state,context,inputs,file,button,root,save:()=>context.storyboardSaveVibeFromForm(root),field:(key,value)=>{inputs[`.sd-storyboard-vibe-${key}`].value=value;}};
}
const oldItem=()=>({id:'original',name:'Old',previewUrl:'/user/images/old.png',providerIds:['novel'],modelIds:['nai-diffusion-4-full'],strength:.6,informationExtracted:1,tags:['kept'],notes:'Keep',createdAt:7,updatedAt:8});

test('actual Vibe save preserves zero values and unrelated old metadata; library is NAI-specific even when managed from another channel',async()=>{
  const e=fixture();e.state.source='banana';assert.equal(await e.save(),true);assert.equal(e.env.saved,1);
  assert.equal(e.state.vibeLibrary[0].providerIds[0],'novel');assert.equal(e.state.vibeLibrary[0].strength,0);assert.equal(e.state.vibeLibrary[0].informationExtracted,0);
  e.state.vibeLibrary=[oldItem()];e.state.editingVibeId='original';assert.equal(await e.save(),true);
  assert.equal(e.state.vibeLibrary.length,1);assert.equal(e.state.vibeLibrary[0].createdAt,7);assert.equal(e.state.vibeLibrary[0].notes,'Keep');assert.equal(e.state.vibeLibrary[0].modelIds[0],'nai-diffusion-4-full');assert.equal(e.state.vibeLibrary[0].tags[0],'kept');
});

test('invalid sources, stale gallery choice and capacity fail without publishing or silently clipping data',async()=>{
  for(const value of ['blob:https://app.test/preview','data:image/png;base64,x','https://user:secret@images.test/a.png','//images.test/a.png','']){
    const e=fixture();e.field('url',value);assert.equal(await e.save(),false,value);assert.equal(e.env.saved,0);assert.equal(e.state.vibeLibrary.length,0);assert.equal(e.button.disabled,false);
  }
  const e=fixture();e.field('name','a'.repeat(101));assert.equal(await e.save(),false);e.field('name','Valid');e.field('gallery','missing');assert.equal(await e.save(),false);e.field('gallery','');
  e.state.vibeLibrary=Array.from({length:500},(_,i)=>({id:String(i)}));assert.equal(await e.save(),false);assert.equal(e.env.saved,0);
});

test('actual static-image validation rejects a spoofed upload before contacting the ST file endpoint',async()=>{
  const e=fixture();e.file.files=[new File(['not an image'],'fake.png',{type:'image/png'})];assert.equal(await e.save(),false);assert.equal(e.env.writes.length,0);assert.equal(e.state.vibeLibrary.length,0);assert.equal(e.root._sdVibeSaveBusy,false);
});

test('valid local upload uses the shared byte validator and persistent hashed file, without copying bytes into settings',async()=>{
  const e=fixture();e.file.files=[new File([png],'actual.png',{type:'image/png'})];assert.equal(await e.save(),true);assert.equal(e.env.writes.length,1);
  assert.match(e.env.writes[0][2],/^qianmu_reference_[0-9a-f]{64}$/);assert.equal(e.state.vibeLibrary[0].previewUrl,'/user/images/Qianmu/vibe.png');assert.ok(!JSON.stringify(e.state).includes(png.toString('base64')));
});

test('late local upload cannot publish after page, account, chat, field, file, source or existing-item changes',async()=>{
  const changes=[e=>e.root.isConnected=false,e=>e.env.account='st-user:two',e=>e.env.chat='chat-two',e=>e.field('name','Changed'),e=>e.file.files=[],e=>e.state.source='banana',e=>e.state.editingVibeId='',e=>e.state.vibeLibrary[0].notes='External edit',e=>e.context.storyboardAdmissionEpoch++,e=>e.env.state=createStoryboardDefaults()];
  for(const change of changes){
    const e=fixture();e.state.vibeLibrary=[oldItem()];e.state.editingVibeId='original';e.file.files=[new File([png],'actual.png',{type:'image/png'})];
    const started=deferred(),finish=deferred();e.env.upload=()=>{started.resolve();return finish.promise;};const pending=e.save();await started.promise;change(e);finish.resolve('/user/images/Qianmu/late.png');
    assert.equal(await pending,false);assert.equal(e.env.saved,0);assert.equal(e.state.vibeLibrary[0].previewUrl,'/user/images/old.png');assert.equal(e.button.disabled,false);
  }
});

test('repeated save is not a second upload, and an upload error leaves both the old entry and editable draft intact',async()=>{
  const e=fixture();e.file.files=[new File([png],'actual.png',{type:'image/png'})];const started=deferred(),finish=deferred();e.env.upload=()=>{started.resolve();return finish.promise;};
  const first=e.save();await started.promise;assert.equal(await e.save(),false);assert.equal(e.env.writes.length,1);finish.resolve('/user/images/Qianmu/one.png');assert.equal(await first,true);
  e.state.vibeLibrary=[oldItem()];e.state.editingVibeId='original';e.env.upload=async()=>{throw Error('upload unavailable');};assert.equal(await e.save(),false);assert.equal(e.state.vibeLibrary[0].name,'Old');assert.equal(e.inputs['.sd-storyboard-vibe-name'].value,'Light');assert.equal(e.root._sdVibeSaveBusy,false);
});

test('gallery replacement while saving invalidates that source rather than attaching a different image',async()=>{
  const e=fixture();e.env.gallery=[{id:'picture',url:'/user/images/one.png'}];e.field('gallery','picture');const before=deferred();let calls=0;
  e.context.featureRuntime.load=async()=>({resolveImageAccountNamespace:async()=>{if(++calls===2)await before.promise;return e.env.account;}});
  const pending=e.save();await new Promise(r=>setImmediate(r));e.env.gallery[0].url='/user/images/two.png';before.resolve();assert.equal(await pending,false);assert.equal(e.env.saved,0);
});

test('delete confirmation is bound to original account and exact item, with cancellation leaving selections intact',async()=>{
  for(const change of [e=>e.env.account='st-user:two',e=>e.env.chat='other',e=>e.state.vibeLibrary[0].name='New name',e=>e.state.view='create']){
    const e=fixture(),item=oldItem();e.state.vibeLibrary=[item];e.state.selectedVibeIds=[item.id];e.env.confirm=async()=>{change(e);return true;};assert.equal(await e.context.storyboardDeleteVibe(item),false);assert.equal(e.state.vibeLibrary.length,1);assert.equal(e.env.saved,0);
  }
  const e=fixture(),item=oldItem();e.state.vibeLibrary=[item,{...oldItem(),id:'other'}];e.state.selectedVibeIds=[item.id,'other'];e.env.confirm=async()=>false;
  assert.equal(await e.context.storyboardDeleteVibe(item),false);e.env.confirm=async()=>true;assert.equal(await e.context.storyboardDeleteVibe(item),true);assert.equal(e.state.vibeLibrary.length,1);assert.equal(e.state.selectedVibeIds.length,1);assert.equal(e.state.selectedVibeIds[0],'other');
});
