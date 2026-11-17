import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createYimuCompanionBridge} from '../qianmu-yimu-companion.js';
import {createCompanionActions} from '../yimu/companion-runtime.mjs';
import {validateCompanion, validateBookSnapshot, upgradeCompanion, companionBooks, mergeCompanionBook, removeCompanionBook, companionEntries, sameCompanionContext, COMPANION_LIMITS} from '../yimu/companion-contract.mjs';
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
        characters:[{avatar:'Char.png',name:'书友'}],personas:[{key:'Persona.png',name:'读者'}],boundaries:{book:{readTo:100,label:'第3章 · 40%'}},story:clone(binding),currentKey:key};
    const record = {bookId:'book',slices:[
        {id:'fiction',summary:'小说中的甲去了月球，读者与书友没有亲历。',coveredTo:80,provenance:{source:'book',sources:['book'],bookId:'book',bucket:key,readTo:80,charFrom:0,charTo:80}},
        {id:'discussion',summary:'用户与书友讨论了甲的离别。',provenance:{source:'dialog',sources:['dialog'],bookId:'book',bucket:key,readTo:90,dialogFrom:0,dialogTo:1,dialogMessageIds:['d0','d1']}}
    ]};
    Object.defineProperty(record,'messages',{get(){throw Error('must not read complete companion chat');}});
    const records={[key]:record};
    let account='st-user:fixture', scans=0, archiveReads=0, apiReads=0, writes=0, emits=0, sequence=0, invalid=[], clock=0;
    let archiveReader=null, serverReader=null, writer=null, lifecycle={disposed:false,paused:false};
    const bridge = createYimuCompanionBridge({getState:()=>sourceState,resolveAccount:async()=>account,hash,
        listKeys:async()=>{scans++;return Object.keys(records);},readRecord:async wanted=>{archiveReads++;return archiveReader?archiveReader():records[wanted];}});
    let attached=bridge.api;
    const read = async () => {apiReads++;return serverReader?serverReader():{document:clone(state.document),defaults:clone(defaults),sourceAvailable:true,invalidSourceIds:invalid};};
    const change = async (actual,op) => {
        writes++;assert.deepEqual(actual,binding);
        if(writer)return writer(actual,op);
        const result=applyOperation(state.document,op);state.document=result.document;return {...result,sourceAvailable:true};
    };
    const controller=createCompanionActions({state,api:{read},change,emit:()=>emits++,lifecycle:()=>lifecycle,bridge:()=>attached,id:()=>`op_${++sequence}`,now:()=>1700000000000+clock});
    controller.connect();t.after(()=>controller.destroy());
    const list = () => controller.action('companionList');
    const preview = async () => {if(!state.companion.list)await list();return controller.action('companionPreview',consent);};
    const link = async () => {await preview();return controller.action('companionSave');};
    const item=()=>({key,bookId:'book',scope:'scope',avatar:'Char.png',persona:'Persona.png'});
    return {state,sourceState,record,hashes,defaults,bridge,controller,list,preview,link,item,binding,
        clock(value){clock=value;},records,
        addBook(id,title,slices){sourceState.coread.books.push({id,title});records[`scope::${id}`]={bookId:id,slices};return {key:`scope::${id}`,bookId:id,scope:'scope',avatar:'Char.png',persona:'Persona.png'};},
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
    assert.equal(f.archiveReads,2);assert.equal(f.writes,1);
    const stored=f.state.document.companion;assert.equal(stored.version,2);assert.equal(stored.account,'st-user:fixture');assert.equal(stored.books.length,1);
    const {account,...readerFields}=preview, anchor={floor:8,hash:f.hashes[7]};
    assert.deepEqual(stored.books[0],{...readerFields,seq:1,updatedAt:1700000000000,entries:preview.entries.map(item=>({...item,anchor,seq:1}))});
    assert.deepEqual(stored.books[0].entries.map(item=>[item.id,item.kind,item.layer]),[['fiction','book','book'],['discussion','dialog','shared']]);
    assert.match(f.state.companion.status,/已关联。之后读了新内容，关闭阅读器时会问你要不要更新。/);assert.equal(f.state.companion.preview,null);
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

const H=char=>char.repeat(64);
const v1=()=>({version:1,confirmed:true,account:'st-user:fixture',key,bookId:'book',scope:'scope',persona:'Persona.png',avatar:'Char.png',title:'合成书',charName:'书友',userName:'读者',confirmedReadTo:100,hash:H('a'),
    entries:[{id:'fiction',kind:'book',text:'小说中的甲去了月球。',readTo:80,hash:H('b'),sourceLabel:'书中情节（阅读背景）'},
        {id:'discussion',kind:'dialog',text:'用户与书友讨论了甲的离别。',readTo:90,hash:H('c'),sourceLabel:'伴读交流（共同经历）'}]});
const snap=(patch={},entries=null)=>({account:'st-user:fixture',key,bookId:'book',scope:'scope',persona:'Persona.png',avatar:'Char.png',title:'合成书',charName:'书友',userName:'读者',
    confirmedReadTo:100,readLabel:'第3章 · 40%',terms:['合成书'],hash:H('d'),
    entries:entries||[{id:'fiction',kind:'book',text:'小说中的甲去了月球。',readTo:80,keywords:['月球'],hash:H('b')},{id:'discussion',kind:'dialog',text:'用户与书友讨论了甲的离别。',readTo:90,hash:H('c')}],...patch});

test('a stored single-book snapshot still validates unchanged and reads as a one-book list',()=>{
    const value=v1();assert.deepEqual(validateCompanion(clone(value)),value);
    for(const patch of [{account:'anonymous'},{key:'different::book'},{entries:[]},{confirmed:false},{entries:[{...value.entries[0],readTo:101}]}])assert.throws(()=>validateCompanion({...value,...patch}));
    const coerced=clone(value);coerced.entries[0].sourceLabel='这是用户和书友的真实经历';
    assert.equal(validateCompanion(coerced).entries[0].sourceLabel,'书中情节（阅读背景）');
    const upgraded=upgradeCompanion(value);
    assert.deepEqual(upgraded,{version:2,account:'st-user:fixture',books:[{key,bookId:'book',scope:'scope',persona:'Persona.png',avatar:'Char.png',title:'合成书',charName:'书友',userName:'读者',
        confirmedReadTo:100,readLabel:'',terms:['合成书'],hash:H('a'),seq:1,updatedAt:0,entries:[
            {id:'fiction',kind:'book',layer:'book',text:'小说中的甲去了月球。',readTo:80,keywords:[],hash:H('b'),anchor:null,seq:1},
            {id:'discussion',kind:'dialog',layer:'shared',text:'用户与书友讨论了甲的离别。',readTo:90,keywords:[],hash:H('c'),anchor:null,seq:1}]}]});
    assert.deepEqual(validateCompanion(upgraded),upgraded,'the upgraded form is itself a valid stored value');
    assert.deepEqual(value,v1(),'reading never rewrites the stored value');
    assert.deepEqual(companionBooks(null),[]);assert.deepEqual(companionBooks({version:3}),[]);
    const entries=companionEntries(value), message=memoryMessage(entries).content;
    assert.ok(entries.every(entry=>entry.source===null&&entry.kind==='manual'));
    assert.match(message,/共读书中内容 ·《合成书》· 只限已读部分 · 这是书友和读者一起读过的书里的情节，不是亲身经历；只有他们两人读过/);
    assert.match(message,/共读交流 ·《合成书》· 已读部分/);assert.match(message,/秘密|角色知情/);
    assert.match(message,/标注「共读书中内容」的条目是两人一起读的书/);
});

test('multi-book contract: the layer is derived, identities are exact, and per-book and overall limits hold',()=>{
    const one=mergeCompanionBook(null,snap(),{anchor:{floor:3,hash:H('e')},now:5});
    assert.equal(one.version,2);assert.equal(one.books[0].seq,1);assert.equal(one.books[0].updatedAt,5);
    const forged=clone(one);forged.books[0].entries[0].layer='shared';forged.books[0].entries[1].layer='book';forged.books[0].entries[1].keywords=['不该保留'];
    assert.deepEqual(validateCompanion(forged).books[0].entries.map(e=>[e.kind,e.layer,e.keywords]),[['book','book',['月球']],['dialog','shared',[]]]);
    const bad=patch=>{const value=clone(one);patch(value);return ()=>validateCompanion(value);};
    assert.throws(bad(v=>{v.account='anonymous';}));assert.throws(bad(v=>{v.books[0].key='other::book';}));
    assert.throws(bad(v=>{v.books=[];}));assert.throws(bad(v=>{v.books.push(clone(v.books[0]));}),/归属/);
    assert.throws(bad(v=>{v.books[0].entries[0].readTo=101;}),/超过/);
    assert.throws(bad(v=>{v.books[0].entries[0].anchor={floor:0,hash:H('e')};}));assert.throws(bad(v=>{v.books[0].entries[0].anchor={floor:1,hash:'x'};}));
    assert.throws(bad(v=>{v.books[0].entries[0].seq=2;}));assert.throws(bad(v=>{v.books[0].seq=0;}));
    assert.throws(bad(v=>{v.books[0].readLabel='长'.repeat(61);}));assert.throws(bad(v=>{v.books[0].terms=['一'];}));
    assert.throws(bad(v=>{v.books[0].terms=Array.from({length:41},(_,i)=>`词条${i}`);}));
    assert.throws(bad(v=>{v.books[0].entries[0].keywords=Array.from({length:13},(_,i)=>`k${i}`);}));
    assert.throws(bad(v=>{v.books[0].entries[0].id='note:1';}));assert.throws(bad(v=>{v.books[0].entries[1].kind='note';}));
    assert.throws(bad(v=>{v.books[0].entries.push({id:'note:1',kind:'note',text:'长'.repeat(201),readTo:1,hash:H('f'),anchor:null,seq:1});}));
    const many=(count,size)=>Array.from({length:count},(_,i)=>({id:`s${i}`,kind:'dialog',text:'字'.repeat(size),readTo:1,hash:H('b')}));
    assert.equal(mergeCompanionBook(null,snap({},many(200,10))).books[0].entries.length,200);
    assert.throws(()=>mergeCompanionBook(null,snap({},many(201,10))),/过多/);
    assert.throws(()=>mergeCompanionBook(null,snap({},many(3,70000))),/过多/);
    assert.throws(()=>validateBookSnapshot(snap({},[])),/没有可关联/);
    assert.throws(()=>validateBookSnapshot(snap({},[{id:'note:1',kind:'note',text:'读者自带的记事',readTo:1,hash:H('b')}])),'only Yimu writes notes');
    let value=null;const other=(i,entries=null)=>snap({key:`scope::b${i}`,bookId:`b${i}`,title:`第${i}本书`,terms:[]},entries);
    for(let i=0;i<12;i++)value=mergeCompanionBook(value,other(i));
    assert.equal(value.books.length,12);assert.throws(()=>mergeCompanionBook(value,other(12)),/最多关联 12 本书/);
    assert.equal(mergeCompanionBook(value,other(3)).books.length,12,'updating a linked book is not a thirteenth book');
    let heavy=null;for(let i=0;i<3;i++)heavy=mergeCompanionBook(heavy,other(i,many(2,99000)));
    assert.throws(()=>mergeCompanionBook(heavy,other(3,many(1,7000))),/过多/);
    assert.throws(()=>mergeCompanionBook(one,snap({account:'st-user:other'})),/归属/);
});

test('updating a book keeps the floor and number of what was already shared, places new slices at the current floor and drops vanished ones',()=>{
    const first=mergeCompanionBook(null,snap(),{anchor:{floor:3,hash:H('e')},now:5,note:{text:'  一起读到月球那段  ',hash:H('1')}});
    assert.deepEqual(first.books[0].entries.map(e=>[e.id,e.anchor?.floor,e.seq]),[['fiction',3,1],['discussion',3,1],['note:1',3,1]]);
    assert.equal(first.books[0].entries[2].text,'一起读到月球那段');assert.equal(first.books[0].entries[2].layer,'shared');
    const next=snap({confirmedReadTo:150,readLabel:'第5章 · 60%',hash:H('9')},[
        {id:'fiction',kind:'book',text:'修订后的月球情节。',readTo:80,keywords:['月球'],hash:H('7')},
        {id:'later',kind:'dialog',text:'两人聊到结局。',readTo:140,hash:H('8')}]);
    const second=mergeCompanionBook(first,next,{anchor:{floor:9,hash:H('6')},now:8}), book=second.books[0];
    assert.equal(book.seq,2);assert.equal(book.updatedAt,8);assert.equal(book.readLabel,'第5章 · 60%');assert.equal(book.confirmedReadTo,150);
    assert.deepEqual(book.entries.map(e=>[e.id,e.anchor?.floor,e.seq]),[['fiction',3,1],['later',9,2],['note:1',3,1]]);
    assert.equal(book.entries[0].text,'修订后的月球情节。');assert.equal(book.entries[0].hash,H('7'));
    const blank=mergeCompanionBook(null,snap()), again=mergeCompanionBook(blank,snap(),{anchor:{floor:4,hash:H('e')}});
    assert.deepEqual(again.books[0].entries.map(e=>e.anchor),[null,null],'linked in an empty chat: unlocated, and an update does not invent a floor');
    let value=null;for(let i=0;i<22;i++)value=mergeCompanionBook(value,snap(),{note:{text:`记事${i}`,hash:H('1')}});
    const notes=value.books[0].entries.filter(e=>e.kind==='note');
    assert.equal(notes.length,COMPANION_LIMITS.notes);assert.deepEqual([notes[0].id,notes.at(-1).id],['note:3','note:22']);
    assert.ok(mergeCompanionBook(value,snap({confirmedReadTo:95})).books[0].entries.every(e=>e.readTo<=95));
});

test('unlinking one book leaves the others; removing the last one clears the link',()=>{
    let value=mergeCompanionBook(null,snap(),{anchor:{floor:2,hash:H('e')}});
    value=mergeCompanionBook(value,snap({key:'scope::other',bookId:'other',title:'另一本书',terms:['另一本书']}),{anchor:{floor:5,hash:H('e')}});
    assert.deepEqual(value.books.map(b=>b.key),[key,'scope::other']);
    const left=removeCompanionBook(value,key);assert.deepEqual(left.books,[value.books[1]]);
    assert.equal(removeCompanionBook(left,'scope::other'),null);assert.deepEqual(removeCompanionBook(left,'unknown'),left);
    assert.equal(removeCompanionBook(v1(),key),null);
    const ids=companionEntries(value).map(e=>e.id);assert.equal(new Set(ids).size,4);assert.ok(ids.every(id=>/^companion_[a-f0-9]{8}_[a-f0-9]{16}$/.test(id)));
    assert.deepEqual(companionEntries(clone(value)).map(e=>e.id),ids,'injected ids depend on the book and the entry, not on position');
    assert.deepEqual(companionEntries(removeCompanionBook(value,key)).map(e=>e.id),ids.slice(2));
});

test('linked reading memories never cover or replace story floors, and book content stays out until the book is mentioned',async t=>{
    const f=await fixture(t);await f.link();
    const plan=await buildPlan(f.state.document,f.defaults,f.state.snapshot);
    assert.deepEqual(plan.entries.map(e=>e.companion.sourceId),['discussion']);assert.deepEqual(plan.coveredRanges,[]);
    assert.ok(plan.entries.every(entry=>entry.source===null&&entry.companion));
    f.state.snapshot.messages.at(-1).mes='你还记得《合成书》里的事吗';
    const asked=await buildPlan(f.state.document,f.defaults,f.state.snapshot);
    assert.deepEqual(asked.entries.map(e=>e.companion.sourceId),['discussion','fiction']);assert.deepEqual(asked.coveredRanges,[]);
    assert.match(asked.prompt,/共读书中内容 ·《合成书》/);
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

test('the removed mainline purpose is refused on both sides and reads nothing',async t=>{
    const f=await fixture(t);await f.link();f.state.document.entries=[entry('manual','不得反向暴露的故事原文')];
    const before=f.apiReads;
    assert.deepEqual(await f.bridge.consume(f.item(),'mainline'),{active:false,text:'',consumedSliceIds:[]});
    let consumer;f.attached({version:2,list:async()=>({}),readSnapshot:async()=>({}),setConsumer:fn=>{consumer=fn;},clearConsumer(){},setLink(){},clearLink(){}});
    const context={version:2,account:'st-user:fixture',...f.item(),story:clone(f.state.snapshot.binding)};
    assert.equal((await consumer({...context,purpose:'mainline'})).active,false);assert.equal(f.apiReads,before);
    assert.equal((await consumer({...context,purpose:'companion'})).active,true);
});

test('the companion\'s own question decides which story memory comes first; without one the order is unchanged',async t=>{
    const f=await fixture(t);await f.link();f.state.document.settings={companionShareCustom:true};
    f.state.document.entries=[entry('lighthouse','lighthouse keeper storm'),entry('orchard','orchard harvest cider')];
    const order=text=>['lighthouse keeper','orchard harvest'].sort((a,b)=>text.indexOf(a)-text.indexOf(b));
    const plain=(await f.bridge.consume(f.item())).text, base=order(plain);
    assert.ok(base.every(word=>plain.includes(word)));
    for(const query of ['',null,'   '])assert.equal((await f.bridge.consume(f.item(),'companion',{query})).text,plain);
    const asked=(await f.bridge.consume(f.item(),'companion',{query:`tell me about the ${base[1]}`})).text;
    assert.deepEqual(order(asked),[base[1],base[0]]);
    assert.deepEqual(order((await f.bridge.consume(f.item(),'companion',{query:`tell me about the ${base[0]}`})).text),base);
    assert.doesNotMatch(asked,/tell me about/,'the query steers selection and is never echoed back');
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

test('a mismatched server binding or moved document cannot activate reverse use',async t=>{
    const f=await fixture(t);await f.link();
    for(const patch of [{binding:{...f.state.snapshot.binding,file:'different'}},{movedTo:{...f.state.snapshot.binding,file:'new-name'}}]) {
        f.serverReader(async()=>({document:{...clone(f.state.document),...patch},defaults:f.defaults,sourceAvailable:true}));
        assert.equal((await f.bridge.consume(f.item())).active,false);
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

test('the entry is 关联伴读; each linked book lists its counts, position and its own 更新关联 and 解除关联',async t=>{
    const f=await viewFixture(t), settle=()=>new Promise(resolve=>setTimeout(resolve,20));
    assert.ok(f.button('关联伴读'));assert.equal(f.button('更新关联'),undefined);assert.equal(f.button('选择伴读记忆'),undefined);
    f.button('关联伴读').click();await tick();assert.deepEqual(f.calls.at(-1),{type:'companionList',payload:undefined});
    await f.link();f.render();await settle();
    const text=()=>f.view.element.textContent;
    assert.match(text(),/《合成书》 · 读到 第3章 · 40%/);assert.match(text(),/共读经历 1 条 · 书中内容 1 条 · 记事 0 条/);
    assert.match(text(),/上次更新 \d+月\d+日 · 记在第 #7 层之后/);assert.doesNotMatch(text(),/锚点楼层已改动|后续阅读不会自动扩大范围|读取并预览摘要/);
    assert.ok(f.button('更新关联'));assert.ok(f.button('解除关联'));assert.ok(f.button('关联伴读'));assert.equal(f.button('解除此聊天关联'),undefined);
    f.button('更新关联').click();await tick();assert.deepEqual(f.calls.at(-1),{type:'companionList',payload:{key}});
    f.button('解除关联').click();await tick();assert.deepEqual(f.calls.at(-1),{type:'companionClear',payload:{key}});
    f.state.snapshot.messages[7]={...f.state.snapshot.messages[7],mes:'后来改过的第八层'};f.render();await settle();
    assert.match(text(),/记在第 #7 层之后 · 锚点楼层已改动/);
    f.state.snapshot.messages.length=3;f.render();await settle();assert.match(text(),/锚点楼层已改动/);
    for(const item of f.state.document.companion.books[0].entries)item.anchor=null;f.render();
    assert.match(text(),/尚未定位/);assert.doesNotMatch(text(),/锚点楼层已改动/);
    f.state.document.companion=v1();f.render();
    assert.match(text(),/《合成书》共读经历 1 条 · 书中内容 1 条 · 记事 0 条尚未定位/,'an old single snapshot shows as one book without a label or date');
});

test('更新关联 opens the picker on that book with its last confirmed position',async t=>{
    const f=await viewFixture(t);const second=f.addBook('second','第二本书',[{id:'s-dialog',summary:'两人争论第二本书的开头。',provenance:{source:'dialog',sources:['dialog'],bookId:'second',bucket:'scope::second',readTo:10,dialogFrom:0,dialogTo:0,dialogMessageIds:['m0']}}]);
    await f.bridge.linkUpdate(second,{confirmedReadTo:50});
    await f.controller.action('companionList',{key:'scope::second'});f.render();
    assert.equal(f.nodes('select')[0].value,'scope::second');assert.equal(f.input('number').value,'50','no live position for a closed book: start from what was confirmed');
    await f.controller.action('companionList');f.render();assert.equal(f.nodes('select')[0].value,key);assert.equal(f.input('number').value,'100');
});
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
    assert.match(f.view.element.textContent,/书中内容（提到这本书时才带入）/);assert.match(f.view.element.textContent,/共读经历/);
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

test('the reader can ask, link and update through Yimu only for the story chat that is open',async t=>{
    const f=await fixture(t), item=f.item();
    assert.deepEqual(await f.bridge.linkStatus(item),{linked:false,confirmedReadTo:null,entryHashes:{},readLabel:'',updatedAt:0});
    await f.bridge.linkUpdate(item,{confirmedReadTo:100,readLabel:'第3章 · 40%',note:'一起读到离别'});
    const book=f.state.document.companion.books[0];
    assert.deepEqual(book.entries.map(e=>[e.id,e.kind,e.anchor.floor,e.seq]),[['fiction','book',8,1],['discussion','dialog',8,1],['note:1','note',8,1]]);
    assert.match(book.entries[2].hash,/^[a-f0-9]{64}$/);assert.equal(book.entries[2].text,'一起读到离别');assert.equal(book.readLabel,'第3章 · 40%');
    const status=await f.bridge.linkStatus(item);
    assert.equal(status.linked,true);assert.equal(status.confirmedReadTo,100);assert.equal(status.readLabel,'第3章 · 40%');assert.equal(status.updatedAt,1700000000000);
    assert.deepEqual(Object.keys(status.entryHashes),['fiction','discussion'],'notes are Yimu\'s own and never compared with reader slices');
    f.state.snapshot.messages.push({name:'甲',is_user:false,mes:'合成第9层。',send_date:'synthetic-8'});
    f.record.slices.push({id:'later',summary:'两人聊到结局。',provenance:{source:'dialog',sources:['dialog'],bookId:'book',bucket:key,readTo:95,dialogFrom:2,dialogTo:3,dialogMessageIds:['d2','d3']}});
    f.clock(60000);await f.bridge.linkUpdate(item,{confirmedReadTo:100});
    const updated=f.state.document.companion.books[0];assert.equal(updated.seq,2);assert.equal(updated.updatedAt,1700000060000);
    assert.deepEqual(updated.entries.map(e=>[e.id,e.anchor.floor,e.seq]),[['fiction',8,1],['discussion',8,1],['later',9,2],['note:1',8,1]]);
    f.sourceState.story={...f.sourceState.story,file:'other'};
    assert.equal(await f.bridge.linkStatus(item),null,'another story chat is open: neither linked nor offered');
    const writes=f.writes;await assert.rejects(()=>f.bridge.linkUpdate(item,{confirmedReadTo:100}),/故事/);assert.equal(f.writes,writes);
    f.sourceState.story=clone(f.binding);
    f.writer(async()=>({document:clone(f.state.document)}));await assert.rejects(()=>f.bridge.linkUpdate(item,{confirmedReadTo:100}),/尚未确认/);f.writer(null);
    assert.deepEqual(await f.bridge.unlink(item),{linked:false});assert.equal(f.state.document.companion,null);
});

test('several books link to one story; each answers only for itself and unlinking one leaves the other',async t=>{
    const f=await fixture(t), first=f.item();
    const second=f.addBook('second','第二本书',[{id:'s-dialog',summary:'两人争论第二本书的开头。',provenance:{source:'dialog',sources:['dialog'],bookId:'second',bucket:'scope::second',readTo:10,dialogFrom:0,dialogTo:0,dialogMessageIds:['m0']}}]);
    await f.bridge.linkUpdate(first,{confirmedReadTo:100});await f.bridge.linkUpdate(second,{confirmedReadTo:50});
    assert.deepEqual(f.state.document.companion.books.map(b=>[b.key,b.title]),[[key,'合成书'],['scope::second','第二本书']]);
    f.state.document.settings={companionShareCustom:true};f.state.document.entries=[entry('manual','只属于故事的明确人工记忆')];
    f.sourceState.currentKey='scope::second';
    const reverse=await f.bridge.consume(second);assert.equal(reverse.active,true);assert.deepEqual(reverse.consumedSliceIds,['s-dialog']);
    assert.match(reverse.text,/明确人工记忆/);assert.doesNotMatch(reverse.text,/争论第二本书|月球|离别/,'no reading memory is echoed back to the reader');
    f.sourceState.currentKey=key;assert.deepEqual((await f.bridge.consume(first)).consumedSliceIds,['fiction','discussion']);
    await f.controller.action('companionClear',{key});
    assert.deepEqual(f.state.document.companion.books.map(b=>b.key),['scope::second']);assert.match(f.state.companion.status,/已解除这本书的关联/);
    assert.equal((await f.bridge.consume(first)).active,false);assert.equal((await f.bridge.linkStatus(first)).linked,false);
    assert.equal((await f.bridge.linkStatus(second)).linked,true);
    await f.controller.action('companionClear',{key:'scope::second'});assert.equal(f.state.document.companion,null);
});

test('a story still holding the old single snapshot keeps working and becomes a book list on its next update',async t=>{
    const f=await fixture(t);f.state.document.companion=v1();
    const plan=await buildPlan(f.state.document,f.defaults,f.state.snapshot);assert.deepEqual(plan.entries.map(e=>e.companion.sourceId),['discussion']);
    f.state.document.entries=[entry('manual','故事记忆')];f.state.document.settings={companionShareCustom:true};
    assert.equal((await f.bridge.consume(f.item())).active,true);
    const status=await f.bridge.linkStatus(f.item());assert.equal(status.linked,true);assert.deepEqual(status.entryHashes,{fiction:H('b'),discussion:H('c')});
    await f.bridge.linkUpdate(f.item(),{confirmedReadTo:100});
    const book=f.state.document.companion.books[0];assert.equal(f.state.document.companion.version,2);assert.equal(book.seq,2);
    assert.deepEqual(book.entries.map(e=>[e.id,e.anchor,e.seq]),[['fiction',null,1],['discussion',null,1]]);
});

test('an older Qianmu bridge is not attached, so neither side offers a half-working link',async t=>{
    const f=await fixture(t);let consumers=0;
    f.attached({version:1,list:async()=>({}),readSnapshot:async()=>({}),setConsumer(){consumers++;},clearConsumer(){}});
    assert.equal(consumers,0);await assert.rejects(()=>f.controller.action('companionList'),/请先启用/);
    f.attached({version:2,list:async()=>({}),readSnapshot:async()=>({}),setConsumer(){consumers++;},clearConsumer(){}});
    assert.equal(consumers,0,'a version-2 object without link support is not a usable bridge either');
    assert.equal(f.bridge.linkAvailable(),false,'detaching withdrew the link handlers from the real bridge');
});
