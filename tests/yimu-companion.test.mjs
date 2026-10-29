import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createYimuCompanionBridge} from '../qianmu-yimu-companion.js';
import {createCompanionActions} from '../yimu/companion-runtime.mjs';
import {validateCompanion, companionEntries, sameCompanionContext} from '../yimu/companion-contract.mjs';
import {mountCompanionView} from '../yimu/companion-view.mjs';
import {createDocument, createDefaults, applyOperation, fingerprintMessages, stageSourceFromParents} from '../yimu/contract.mjs';
import {buildPlan, filterCompanionEntries} from '../yimu/core.mjs';
import {memoryMessage, byteBudget} from '../yimu/budget.mjs';

const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const deferred = () => {let resolve; const promise = new Promise(yes => {resolve = yes;}); return {promise, resolve};};
const tick = () => new Promise(resolve => setImmediate(resolve));
const key = 'scope::book';
const consent = {key, confirmedReadTo:100, confirmedLocalOwnership:true};
const entry = (id, text, source = null, patch = {}) => ({id, text, source, kind:source ? 'summary':'manual', status:'active', edited:!source, revision:1, history:[], conflicts:[], ...patch});

async function fixture(t) {
    const binding = {avatar:'Char.png',file:'Synthetic-story',integrity:'synthetic_identity'};
    const messages = Array.from({length:8},(_,i)=>({name:i%2?'甲':'用户',is_user:!(i%2),mes:`合成第${i+1}层，仅验证来源与边界。`,send_date:`synthetic-${i}`}));
    const hashes = await fingerprintMessages(messages), defaults = createDefaults();
    const state = {snapshot:{binding,messages,name:'甲',maxContext:8192,maxResponse:1024}, document:createDocument(binding),
        defaults,sourceAvailable:true,companion:{},service:{status:'ok'},loading:false};
    state.document.enabled=true;state.document.initialRange={start:1,end:8,total:8};
    const sourceState = {available:true,owner:{},coread:{books:[{id:'book',title:'合成书'}],companionSessions:[{scope:'scope',avatar:'Char.png',userAvatar:'Persona.png'}]},
        characters:[{avatar:'Char.png',name:'书友'}],personas:[{key:'Persona.png',name:'读者'}],boundaries:{book:{readTo:100}},story:clone(binding),currentKey:key};
    const record = {bookId:'book',slices:[
        {id:'fiction',summary:'小说中的甲去了月球，读者与书友没有亲历。',coveredTo:80,provenance:{source:'book',sources:['book'],bookId:'book',bucket:key,readTo:80,charFrom:0,charTo:80}},
        {id:'discussion',summary:'用户与书友讨论了甲的离别。',provenance:{source:'dialog',sources:['dialog'],bookId:'book',bucket:key,readTo:90,dialogFrom:0,dialogTo:1,dialogMessageIds:['d0','d1']}}
    ]};
    Object.defineProperty(record,'messages',{get(){throw Error('must not read complete companion chat');}});
    let account='st-user:fixture', scans=0, archiveReads=0, apiReads=0, writes=0, emits=0, sequence=0, invalid=[];
    let archiveReader=null, serverReader=null, writer=null, lifecycle={disposed:false,paused:false};
    const bridge = createYimuCompanionBridge({getState:()=>sourceState,resolveAccount:async()=>account,hash,
        listKeys:async()=>{scans++;return [key];},readRecord:async()=>{archiveReads++;return archiveReader?archiveReader():record;}});
    let attached=bridge.api;
    const read = async () => {apiReads++;return serverReader?serverReader():{document:clone(state.document),defaults:clone(defaults),sourceAvailable:true,invalidSourceIds:invalid};};
    const change = async (actual,op) => {
        writes++;assert.deepEqual(actual,binding);
        if(writer)return writer(actual,op);
        const result=applyOperation(state.document,op);state.document=result.document;return {...result,sourceAvailable:true};
    };
    const controller=createCompanionActions({state,api:{read},change,emit:()=>emits++,lifecycle:()=>lifecycle,bridge:()=>attached,id:()=>`op_${++sequence}`});
    controller.connect();t.after(()=>controller.destroy());
    const list = () => controller.action('companionList');
    const preview = async () => {if(!state.companion.list)await list();return controller.action('companionPreview',consent);};
    const link = async () => {await preview();return controller.action('companionSave');};
    const item=()=>({key,bookId:'book',scope:'scope',avatar:'Char.png',persona:'Persona.png'});
    return {state,sourceState,record,hashes,defaults,bridge,controller,list,preview,link,item,
        get archiveReads(){return archiveReads;},get apiReads(){return apiReads;},get writes(){return writes;},get scans(){return scans;},get emits(){return emits;},
        account(value){account=value;},archiveReader(value){archiveReader=value;},serverReader(value){serverReader=value;},writer(value){writer=value;},
        lifecycle(value){lifecycle={...lifecycle,...value};},invalid(value){invalid=value;},attached(value){attached=value;controller.connect();}};
}

test('opening/listing/unauthorized preview cannot read summaries or write an association',async t=>{
    const f=await fixture(t);assert.equal(f.archiveReads,0);assert.equal(f.apiReads,0);
    await assert.rejects(()=>f.controller.action('companionSave'),/预览/);
    await assert.rejects(()=>f.controller.action('companionPreview',consent),/选择/);
    await f.list();assert.equal(f.archiveReads,0);assert.equal(f.writes,0);
    for(const patch of [{confirmedLocalOwnership:false},{confirmedReadTo:null},{confirmedReadTo:-1},{confirmedReadTo:0.1},{key:'foreign::book'}]) {
        await assert.rejects(()=>f.controller.action('companionPreview',{...consent,...patch}),/确认|选择/);
    }
    assert.equal(f.archiveReads,0);assert.equal(f.writes,0);
});

test('preview is read-only, save rereads the same source hash, and clear preserves original records',async t=>{
    const f=await fixture(t), original=clone(f.record.slices);await f.preview();
    assert.equal(f.archiveReads,1);assert.equal(f.writes,0);assert.equal(f.state.document.companion,undefined);
    const preview=clone(f.state.companion.preview);await f.controller.action('companionSave');
    assert.equal(f.archiveReads,2);assert.equal(f.writes,1);assert.deepEqual(f.state.document.companion,preview);
    assert.match(f.state.companion.status,/已关联/);assert.equal(f.state.companion.preview,null);
    await f.controller.action('companionClear');assert.equal(f.state.document.companion,null);
    assert.deepEqual(f.record.slices,original);assert.match(f.state.companion.status,/已解除/);
});

test('another device without the companion bridge can clear an existing server association',async t=>{
    const f=await fixture(t);await f.link();const archiveReads=f.archiveReads, original=clone(f.record.slices);
    f.attached(undefined);await f.controller.action('companionClear');
    assert.equal(f.state.document.companion,null);assert.match(f.state.companion.status,/已解除/);
    assert.equal(f.archiveReads,archiveReads);assert.deepEqual(f.record.slices,original);
    await assert.rejects(()=>f.controller.action('companionList'),/请先启用/);
});

test('clear without a bridge cannot claim success when the service has not confirmed removal',async t=>{
    const f=await fixture(t);await f.link();const linked=clone(f.state.document.companion);
    f.attached(undefined);f.writer(async()=>({document:clone(f.state.document)}));
    await assert.rejects(()=>f.controller.action('companionClear'),/解除结果尚未确认/);
    assert.equal(f.state.companion.status,'');assert.deepEqual(f.state.document.companion,linked);
    f.writer(async()=>{throw Error('synthetic offline');});
    await assert.rejects(()=>f.controller.action('companionClear'),/offline/);
    assert.equal(f.state.companion.status,'');assert.deepEqual(f.state.document.companion,linked);
});

test('changed source between preview and confirm does not save or imply success',async t=>{
    const f=await fixture(t);await f.preview();const previous=clone(f.state.companion.preview);
    f.record.slices[0].summary='用户后来修订后的小说背景';
    await assert.rejects(()=>f.controller.action('companionSave'),/变化/);
    assert.equal(f.writes,0);assert.equal(f.state.companion.status,'');assert.deepEqual(f.state.companion.preview,previous);
});

test('a faulty bridge cannot reuse a previous hash while changing preview text',async t=>{
    const f=await fixture(t);await f.preview();
    const returned={...clone(f.state.companion.preview),entries:f.state.companion.preview.entries.map(entry=>({...entry,text:'different'}))};
    f.attached({...f.bridge.api,readSnapshot:async()=>returned});
    await assert.rejects(()=>f.controller.action('companionSave'),/变化/);
    assert.equal(f.writes,0);assert.equal(f.state.companion.status,'');
});

test('catalog account mismatch rejects before any summary read',async t=>{
    const f=await fixture(t);await f.list();f.account('st-user:another');
    await assert.rejects(()=>f.controller.action('companionPreview',consent),/账户|变化/);
    assert.equal(f.archiveReads,0);assert.equal(f.writes,0);
});

test('changed persona or scope cannot borrow another local archive',async t=>{
    const f=await fixture(t);await f.list();f.sourceState.coread.companionSessions[0].userAvatar='Other.png';
    await assert.rejects(()=>f.controller.action('companionPreview',consent),/范围|变化/);
    assert.equal(f.archiveReads,0);assert.equal(f.writes,0);
});

test('an all-future/unknown snapshot is not a successful empty association',async t=>{
    const f=await fixture(t);f.record.slices[0].provenance.readTo=101;delete f.record.slices[1].provenance;
    await assert.rejects(()=>f.preview(),/没有可关联/);
    assert.equal(f.state.companion.preview,null);assert.deepEqual(f.state.companion.omitted,{future:1,unknown:1,mixed:0});
    await assert.rejects(()=>f.controller.action('companionSave'),/预览/);assert.equal(f.writes,0);
});

for(const outcome of ['reject','unconfirmed','revision'])test(`save ${outcome} preserves preview and cannot show success`,async t=>{
    const f=await fixture(t);await f.preview();
    if(outcome==='reject')f.writer(async()=>{throw Error('synthetic offline');});
    if(outcome==='unconfirmed')f.writer(async()=>({document:clone(f.state.document)}));
    if(outcome==='revision')f.state.document.revision++;
    await assert.rejects(()=>f.controller.action('companionSave'),/offline|尚未确认|变化/);
    assert.equal(f.state.companion.status,'');assert.ok(f.state.companion.preview);
});

for(const transition of ['chat','view','destroy','bridge'])test(`late preview after ${transition} is discarded`,async t=>{
    const f=await fixture(t);await f.list();const pending=deferred();f.archiveReader(()=>pending.promise);
    const oldView=f.state.companion, run=f.controller.action('companionPreview',consent);
    while(!f.archiveReads)await tick();
    if(transition==='chat')f.state.snapshot.binding={...f.state.snapshot.binding,file:'another'};
    if(transition==='view')f.state.companion={};
    if(transition==='destroy')f.controller.destroy();
    if(transition==='bridge')f.attached(undefined);
    pending.resolve(f.record);await run;
    assert.equal(oldView.preview,null);assert.equal(f.writes,0);assert.equal(f.state.companion.status||'','');
});

test('late confirmed save does not report success in another chat',async t=>{
    const f=await fixture(t);await f.preview();const pending=deferred();f.writer(()=>pending.promise);
    const run=f.controller.action('companionSave');while(!f.writes)await tick();
    f.state.snapshot.binding={...f.state.snapshot.binding,file:'another'};f.state.companion={};
    pending.resolve({document:{...clone(f.state.document),companion:clone(f.state.companion.preview)}});
    await run;assert.deepEqual(f.state.companion,{});
});

test('contract rejects ambiguous identities, empty data, future entries, and coerces nature labels',async t=>{
    const f=await fixture(t);await f.preview();const value=clone(f.state.companion.preview);
    for(const patch of [{account:'anonymous'},{key:'different::book'},{entries:[]},{confirmed:false},{entries:[{...value.entries[0],readTo:101}]}])assert.throws(()=>validateCompanion({...value,...patch}));
    value.entries[0].sourceLabel='这是用户和书友的真实经历';
    assert.equal(validateCompanion(value).entries[0].sourceLabel,'书中情节（阅读背景）');
    const entries=companionEntries(value), message=memoryMessage(entries).content;
    assert.ok(entries.every(entry=>entry.source===null));
    assert.match(message,/书中背景（不等于亲历或知情）/);assert.match(message,/共同交流记录/);
    assert.match(message,/秘密|角色知情/);
});

test('associated book and dialog are background only and cannot cover or replace current raw floors',async t=>{
    const f=await fixture(t);await f.link();
    const plan=await buildPlan(f.state.document,f.defaults,f.state.snapshot);
    assert.equal(plan.entries.length,2);assert.deepEqual(plan.coveredRanges,[]);
    assert.ok(plan.entries.every(entry=>entry.source===null&&entry.companion));
});

test('reverse reader is opt-in, exact account/persona/story, and exposes no unprocessed raw or companion echo',async t=>{
    const f=await fixture(t), item=f.item();
    assert.equal((await f.bridge.consume(item)).active,false);assert.equal(f.apiReads,0);
    await f.link();f.state.document.settings={companionShareCustom:true};f.state.document.entries=[entry('manual','只属于故事的明确人工记忆')];
    const result=await f.bridge.consume(item);
    assert.equal(result.active,true);assert.match(result.text,/明确人工记忆/);assert.doesNotMatch(result.text,/合成第|月球|甲的离别/);
    assert.deepEqual(result.consumedSliceIds,['fiction','discussion']);
    const before=f.apiReads;
    assert.equal((await f.bridge.consume({...item,persona:'other'})).active,false);
    f.sourceState.story={...f.sourceState.story,file:'other'};assert.equal((await f.bridge.consume(item)).active,false);
    f.sourceState.story=clone(f.state.snapshot.binding);f.account('st-user:other');assert.equal((await f.bridge.consume(item)).active,false);
    assert.equal(f.apiReads,before);
});

test('mainline purpose suppresses only source IDs and never sends story prose',async t=>{
    const f=await fixture(t);await f.link();f.state.document.entries=[entry('manual','不得反向暴露的故事原文')];
    const result=await f.bridge.consume(f.item(),'mainline');
    assert.deepEqual(result,{active:true,text:'',consumedSliceIds:['fiction','discussion']});
    const pool=[{id:'fiction',__src:key},{id:'discussion',__src:key},{id:'new',__src:key},{id:'fiction',__src:'other::book'}];
    assert.deepEqual(await f.bridge.filterMainline(pool),pool.slice(2));
    f.sourceState.story={...f.sourceState.story,file:'branch'};
    assert.deepEqual(await f.bridge.filterMainline(pool),pool);
});

for(const condition of ['paused','disabled','source','removed','server-error','server-revision','server-disabled','server-source'])test(`reverse link fails closed for ${condition}`,async t=>{
    const f=await fixture(t);await f.link();f.state.document.entries=[entry('manual','故事记忆')];
    if(condition==='paused')f.lifecycle({paused:true});
    if(condition==='disabled')f.state.document.enabled=false;
    if(condition==='source')f.state.sourceAvailable=false;
    if(condition==='removed')f.state.document.companion=null;
    if(condition==='server-error')f.serverReader(async()=>{throw Error('offline');});
    if(condition.startsWith('server-')&&condition!=='server-error')f.serverReader(async()=>({document:{...clone(f.state.document),revision:f.state.document.revision+(condition==='server-revision'?1:0),enabled:condition!=='server-disabled'},defaults:f.defaults,sourceAvailable:condition!=='server-source'}));
    assert.equal((await f.bridge.consume(f.item())).active,false);
    if(['paused','disabled','source','removed'].includes(condition))assert.equal(f.apiReads,0);
});

for(const condition of ['binding','revision','paused','bridge'])test(`late reverse result cannot survive a ${condition} change`,async t=>{
    const f=await fixture(t);await f.link();const pending=deferred(), saved=clone(f.state.document);
    f.serverReader(()=>pending.promise);const run=f.bridge.consume(f.item());while(!f.apiReads)await tick();
    if(condition==='binding')f.state.snapshot.binding={...f.state.snapshot.binding,file:'other'};
    if(condition==='revision')f.state.document.revision++;
    if(condition==='paused')f.lifecycle({paused:true});
    if(condition==='bridge')f.attached(undefined);
    pending.resolve({document:saved,defaults:f.defaults,sourceAvailable:true});
    assert.equal((await run).active,false);
});

test('optional reverse server read has a bounded timeout and never blocks on an unresolved request',async t=>{
    const f=await fixture(t);await f.link();f.serverReader(()=>new Promise(()=>{}));
    const start=Date.now();assert.equal((await f.bridge.consume(f.item())).active,false);
    assert.ok(Date.now()-start<1500);assert.equal(f.writes,1);
});

test('reverse invalid edited stage remains available without exposing its automatic children',async t=>{
    const f=await fixture(t);await f.link();
    const a=entry('fine_a','不允许绕过人工修订的旧读法甲',{start:1,end:1,hashes:[f.hashes[0]]});
    const b=entry('fine_b','不允许绕过人工修订的旧读法乙',{start:2,end:2,hashes:[f.hashes[1]]});
    f.state.document.entries=[a,b];
    const stage=entry('stage','手动修订的含义',stageSourceFromParents(f.state.document,[{id:a.id,revision:1},{id:b.id,revision:1}]),{kind:'stage',edited:true});
    f.state.document.entries.push(stage);f.invalid(['stage']);
    const result=await f.bridge.consume(f.item());assert.equal(result.active,true);assert.match(result.text,/手动修订的含义/);
    assert.equal(f.state.document.entries.at(-1).status,'active','read validation does not mutate client truth');
});

test('reverse plan keeps invalid context while excluding deleted, excluded and recent-floor summaries',async t=>{
    const f=await fixture(t);await f.link();
    const fine=(id,floor,patch={})=>entry(id,id,{start:floor,end:floor,hashes:[f.hashes[floor-1]]},patch);
    f.state.document.entries=[fine('valid_detail',1),fine('source_changed',2),fine('deleted_detail',2,{status:'deleted'}),
        fine('excluded_detail',3,{status:'excluded'}),fine('too_recent_detail',8)];
    f.invalid(['source_changed']);const result=await f.bridge.consume(f.item());
    assert.match(result.text,/valid_detail|source_changed/);assert.doesNotMatch(result.text,/deleted_detail|excluded_detail|too_recent_detail/);
});

test('a mismatched server binding or moved document cannot activate reverse use or duplicate suppression',async t=>{
    const f=await fixture(t);await f.link();
    for(const patch of [{binding:{...f.state.snapshot.binding,file:'different'}},{movedTo:{...f.state.snapshot.binding,file:'new-name'}}]) {
        f.serverReader(async()=>({document:{...clone(f.state.document),...patch},defaults:f.defaults,sourceAvailable:true}));
        assert.equal((await f.bridge.consume(f.item(),'mainline')).active,false);
    }
});

test('reverse text fits its complete wrapper budget and skips whole oversized entries',async t=>{
    const f=await fixture(t);await f.link();f.state.document.settings={companionShareCustom:true};
    f.state.document.entries=[entry('huge','过大条目'.repeat(2000)),entry('small','完整的小记忆')];
    const result=await f.bridge.consume(f.item());assert.match(result.text,/完整的小记忆/);assert.doesNotMatch(result.text,/过大条目/);
    assert.ok(byteBudget([{role:'system',content:result.text}])<=6000);
});

test('excerpt cannot be admitted when its oversized selected parent was skipped',async t=>{
    const f=await fixture(t);await f.link();
    const parent=entry('fine','父摘要过大'.repeat(2000),{start:1,end:1,hashes:[f.hashes[0]]});
    f.state.document.entries=[parent,entry('quote','原文补充',parent.source,{kind:'excerpt',parent:{id:'fine',revision:1},quote:{start:0,end:2},quoteText:'孤立引文',quoteSpeaker:'甲'})];
    const result=await f.bridge.consume(f.item());assert.equal(result.text,'');
});

test('only exact confirmed source identity activates a link',async t=>{
    const f=await fixture(t);await f.link();const value=f.state.document.companion;
    const context={...f.item(),account:value.account,story:clone(f.state.snapshot.binding)};
    assert.equal(sameCompanionContext(value,context,f.state.snapshot.binding),true);
    for(const field of ['account','key','bookId','scope','persona','avatar'])assert.equal(sameCompanionContext(value,{...context,[field]:'other'},f.state.snapshot.binding),false);
    for(const field of ['avatar','file','integrity'])assert.equal(sameCompanionContext(value,{...context,story:{...context.story,[field]:'other'}},f.state.snapshot.binding),false);
});

// Minimal isolated DOM: behavioral contract only, not rendered/live visual proof.
function dom() {
    const all=node=>node.children.flatMap(child=>[child,...all(child)]);
    class Element {
        constructor(tag){this.tagName=tag;this.children=[];this.events={};this._text='';this.value='';this.disabled=false;this.checked=false;}
        set textContent(value){this._text=String(value);this.children=[];}
        get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
        set innerHTML(_){throw Error('no untrusted HTML');}
        append(...children){this.children.push(...children);}
        replaceChildren(...children){this._text='';this.children=children;}
        addEventListener(name,fn){this.events[name]=fn;}
        setAttribute(name,value){(this.attrs ||= {})[name]=String(value);}
        emit(name){this.events[name]?.({target:this});}
        click(){if(!this.disabled)this.emit('click');}
        querySelectorAll(selector){return all(this).filter(node=>selector.split(',').includes(node.tagName));}
    }
    const document={createElement:tag=>new Element(tag)};
    const el=(tag,cls='',text='')=>{const node=document.createElement(tag);node.className=cls;node.textContent=text;return node;};
    const button=(text,fn)=>{const node=el('button','',text);node.addEventListener('click',fn);return node;};
    return {document,el,button,all};
}
async function viewFixture(t){
    const f=await fixture(t),d=dom(),calls=[];
    const view=mountCompanionView({...d,onAction:async(type,payload)=>{calls.push({type,payload});}});
    const render=()=>view.render(f.state);render();
    const nodes=tag=>d.all(view.element).filter(node=>node.tagName===tag);
    return {...f,view,calls,render,nodes,button:text=>nodes('button').find(node=>node.textContent===text),input:type=>nodes('input').find(node=>node.type===type)};
}

test('view requires one explicit ownership/cutoff confirmation and preserves the draft while busy',async t=>{
    const f=await viewFixture(t);await f.list();f.render();
    assert.equal(f.button('读取并预览摘要').disabled,true);assert.equal(f.input('number').value,'100');
    f.input('checkbox').checked=true;f.input('checkbox').emit('change');assert.equal(f.button('读取并预览摘要').disabled,false);
    f.state.companion.busy=true;f.render();assert.equal(f.input('checkbox').checked,true);assert.equal(f.button('读取并预览摘要').disabled,true);
    f.state.companion.busy=false;f.render();f.button('读取并预览摘要').click();await tick();
    assert.deepEqual(f.calls.at(-1),{type:'companionPreview',payload:consent});
});

test('preview shows bounded source nature and edited cutoff disables saving until reconfirmed',async t=>{
    const f=await viewFixture(t);await f.list();f.render();f.input('checkbox').checked=true;f.input('checkbox').emit('change');
    await f.preview();f.render();assert.equal(f.button('确认关联以上摘要').disabled,false);
    assert.match(f.view.element.textContent,/书中背景（不等于亲历或知情）/);assert.match(f.view.element.textContent,/共同交流/);
    assert.doesNotMatch(f.view.element.textContent,/只关联本次预览的摘要/);
    f.input('number').value='90';f.input('number').emit('input');
    assert.equal(f.input('checkbox').checked,false);assert.equal(f.button('确认关联以上摘要').disabled,true);
    f.input('checkbox').checked=true;f.input('checkbox').emit('change');assert.equal(f.button('确认关联以上摘要').disabled,true);
});

test('empty results do not show source-count diagnostics or an empty confirm button',async t=>{
    const f=await viewFixture(t);await f.list();f.state.companion.omitted={future:2,unknown:1,mixed:1};f.render();
    assert.doesNotMatch(f.view.element.textContent,/超出已读范围|来源不完整|混合来源/);assert.equal(f.button('确认关联以上摘要'),undefined);
    f.state.companion.list={account:'st-user:fixture',items:[]};f.render();assert.equal(f.nodes('input').length,0);
    assert.match(f.view.element.textContent,/本机没有可关联/);
});

test('companion sharing keeps custom slices private unless the Yimu setting explicitly allows them', () => {
    const source = {id:'source', kind:'summary', text:'正文记忆'};
    const custom = {id:'custom', kind:'manual', text:'用户私人补充'};
    const stage = {id:'stage', kind:'stage', text:'混合阶段总结', source:{parents:[{id:'source',revision:1},{id:'custom',revision:1}]} };
    const excerpt = {id:'excerpt', kind:'excerpt', parent:{id:'custom'}, text:'私人回查'};
    const document = {entries:[source, custom]};
    assert.deepEqual(filterCompanionEntries([source, custom, stage, excerpt], document).map(item=>item.id), ['source']);
    assert.deepEqual(filterCompanionEntries([source, custom, stage, excerpt], document, {includeCustom:true}).map(item=>item.id), ['source','custom','stage','excerpt']);
});

test('changing selected archive or chat resets ownership consent; unavailable service disables actions',async t=>{
    const f=await viewFixture(t);await f.list();f.state.companion.list.items.push({...f.state.companion.list.items[0],key:'scope::second',bookId:'second',readTo:50});f.render();
    f.input('checkbox').checked=true;f.input('checkbox').emit('change');
    f.nodes('select')[0].value='scope::second';f.nodes('select')[0].emit('change');
    assert.equal(f.input('checkbox').checked,false);assert.equal(f.input('number').value,'50');
    f.state.service.status='error';f.render();assert.ok(f.nodes('button').every(node=>node.disabled));
    f.state.service.status='ok';f.state.snapshot.binding={...f.state.snapshot.binding,file:'other'};f.render();assert.equal(f.input('checkbox').checked,false);
});

test('late Qianmu readiness reconnects through quiet refresh and removes its listener on disposal',async()=>{
    const source=await readFile(new URL('../yimu/index.mjs',import.meta.url),'utf8');
    assert.match(source,/addEventListener\(COMPANION_READY, focus\)/);
    assert.match(source,/removeEventListener\(COMPANION_READY, focus\)/);
    assert.match(source,/const focus = .*refresh\(\{ quiet: true, auto: false \}\)/);
});
