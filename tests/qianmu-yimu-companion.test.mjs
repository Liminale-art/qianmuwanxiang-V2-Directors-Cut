import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createYimuCompanionBridge, YIMU_COMPANION_KEY, YIMU_COMPANION_READY} from '../qianmu-yimu-companion.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const key = 'companion-scope::book';
const consent = {key, confirmed: true, confirmedLocalOwnership: true, confirmedReadTo: 100};
const dialog = (id = 'dialog', readTo = 80) => ({id, summary: '用户与书友约好下周一起讨论结局。', keywords: ['private keyword'],
    provenance: {source:'dialog', sources:['dialog'], bookId:'book', bucket:key, readTo, dialogFrom:0, dialogTo:1, dialogMessageIds:['d1','d2']}});
const book = (id = 'book', readTo = 90) => ({id, summary:'书中人物在车站分别。', coveredTo:readTo,
    provenance:{source:'book', sources:['book'], bookId:'book', bucket:key, readTo, charFrom:0, charTo:readTo, chapterFrom:0, chapterTo:0}});
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return {promise, resolve}; };

test('optional link bounds account lookup too and never invokes a consumer after timeout',async()=>{
    const pending=deferred();let called=0;
    const state={available:true,owner:{},coread:{books:[],companionSessions:[]}};
    const bridge=createYimuCompanionBridge({getState:()=>state,resolveAccount:()=>pending.promise,listKeys:async()=>[],readRecord:async()=>null,hash});
    bridge.api.setConsumer(async()=>{called++;return {active:true,text:'late'};});
    const start=Date.now();assert.equal((await bridge.consume({key})).active,false);assert.ok(Date.now()-start<1500);
    pending.resolve('st-user:fixture');await new Promise(resolve=>setImmediate(resolve));assert.equal(called,0);
});
function fixture() {
    const owner = {}, coread = {books:[{id:'book',title:'合成书',progress:99}], companionSessions:[{scope:'companion-scope',avatar:'Char.png',userAvatar:'Persona.png'}], memory:{summaryApiKey:'never expose'}};
    const state = {available:true,owner,coread,characters:[{avatar:'Char.png',name:'书友'}],personas:[{key:'Persona.png',name:'读者'}],
        boundaries:{book:{readTo:100}},story:{avatar:'Char.png',file:'story',integrity:'proof'},currentKey:key};
    let account = 'st-user:fixture', record = {bookId:'book',slices:[dialog(),book()]}, keys = [key], reads = 0, scans = 0, reader = null;
    Object.defineProperty(record, 'messages', {get() { throw Error('whole dialogue must never be traversed'); }});
    const bridge = createYimuCompanionBridge({getState:()=>state,resolveAccount:async()=>account,hash,
        listKeys:async()=>{scans++; return [...keys];},readRecord:async()=>{reads++; return reader ? reader() : record;}});
    return {bridge,state,coread,get record(){return record;},set record(value){record=value;},get reads(){return reads;},get scans(){return scans;},
        account(value){account=value;},keys(value){keys=value;},reader(value){reader=value;}};
}

test('listing exposes metadata only, with exact identity and no inferred reading confirmation', async()=>{
    const f=fixture(), result=await f.bridge.api.list();
    assert.equal(f.reads,0);assert.equal(f.scans,1);assert.equal(result.account,'st-user:fixture');
    assert.deepEqual(result.items,[{key,bookId:'book',scope:'companion-scope',persona:'Persona.png',avatar:'Char.png',title:'合成书',charName:'书友',userName:'读者',readTo:100,ownership:'unverified'}]);
    assert.doesNotMatch(JSON.stringify(result),/summaryApiKey|never expose|约好|车站/);
    f.state.boundaries={}; assert.equal((await f.bridge.api.list()).items[0].readTo,null,'99% chapter progress cannot invent exact character offset');
});

test('catalog requires both an owned setting identity and an actually stored archive key',async()=>{
    const f=fixture();f.keys([key,'foreign::book','companion-scope::foreign']);
    assert.equal((await f.bridge.api.list()).items.length,1);
    f.coread.companionSessions[0].userAvatar=undefined;assert.deepEqual((await f.bridge.api.list()).items,[]);
    f.coread.companionSessions[0].userAvatar='Persona.png';f.state.personas=[];assert.deepEqual((await f.bridge.api.list()).items,[]);
    assert.equal(f.reads,0);
});

test('ambiguous scope ownership is never chosen by array order',async()=>{
    const f=fixture();f.coread.companionSessions.push({scope:'companion-scope',avatar:'Other.png',userAvatar:'Persona.png'});
    assert.deepEqual((await f.bridge.api.list()).items,[]);assert.equal(f.reads,0);
});

for (const change of [{confirmed:false},{confirmedReadTo:null},{confirmedReadTo:-1},{confirmedReadTo:1.5},{confirmedLocalOwnership:false}]) {
    test(`snapshot requires explicit reading and local ownership consent ${JSON.stringify(change)}`,async()=>{
        const f=fixture();await assert.rejects(()=>f.bridge.api.readSnapshot({...consent,...change}),/确认/);assert.equal(f.reads,0);assert.equal(f.scans,0);
    });
}

test('unknown or cross-account archive is rejected without exposing summaries',async()=>{
    const f=fixture();await assert.rejects(()=>f.bridge.api.readSnapshot({...consent,key:'other::book'}),/范围/);assert.equal(f.reads,0);
    f.record.companionOwner={account:'st-user:another'};await assert.rejects(()=>f.bridge.api.readSnapshot(consent),/其他账户/);
});

test('snapshot contains only saved allowed summaries, with separate fiction and shared-experience labels',async()=>{
    const f=fixture(), result=await f.bridge.api.readSnapshot(consent);
    assert.equal(result.evidence,'user-confirmed-snapshot');assert.equal(result.entries.length,2);
    assert.equal(result.entries[0].sourceLabel,'伴读交流（共同经历）');assert.equal(result.entries[1].sourceLabel,'书中情节（阅读背景）');
    assert.match(result.hash,/^[a-f0-9]{64}$/);assert.ok(result.entries.every(e=>e.hash.length===64));
    assert.doesNotMatch(JSON.stringify(result),/keywords|messages|summaryApiKey|ownership/);
    assert.deepEqual(result.omitted,{future:0,unknown:0,mixed:0});assert.equal(f.reads,1);
});

test('raw missing provenance, mixed, future, wrong bucket and malformed coverage never acquire a fallback read boundary',async()=>{
    const f=fixture(), noIds=dialog('no-ids'), conflict=book('conflict');delete noIds.provenance.dialogMessageIds;conflict.coveredTo=150;
    f.record.slices=[dialog('okay'),book('future',101),{id:'legacy',summary:'must not normalize'},
        {...dialog('mixed'),provenance:{...dialog().provenance,source:'mixed',sources:['dialog','book']}},
        {...dialog('wrong'),provenance:{...dialog().provenance,bucket:'other'}},noIds,conflict];
    const result=await f.bridge.api.readSnapshot(consent);
    assert.deepEqual(result.entries.map(e=>e.id),['okay']);assert.deepEqual(result.omitted,{future:1,unknown:4,mixed:1});
});

test('hash recheck detects manual source edits without changing either saved source or prior snapshot',async()=>{
    const f=fixture(), original=await f.bridge.api.readSnapshot(consent), before=clone(original);
    await f.bridge.api.readSnapshot({...consent,expectedHash:original.hash});
    f.record.slices[0].summary='用户后来手动修正过的含义';
    await assert.rejects(()=>f.bridge.api.readSnapshot({...consent,expectedHash:original.hash}),/已变化/);
    assert.deepEqual(original,before);assert.equal(f.record.slices[0].summary,'用户后来手动修正过的含义');
});

for(const change of ['account','owner','persona','unmount']) test(`late saved-archive read is discarded after ${change} changes`,async()=>{
    const f=fixture(), pending=deferred();f.reader(()=>pending.promise);const run=f.bridge.api.readSnapshot(consent);
    while(!f.reads) await new Promise(resolve=>setImmediate(resolve));
    if(change==='account')f.account('st-user:changed');if(change==='owner')f.state.owner={};
    if(change==='persona')f.coread.companionSessions[0].userAvatar='another';if(change==='unmount')f.bridge.unmount();
    pending.resolve(f.record);await assert.rejects(()=>run,/变化/);
});

test('consumer is optional, scoped to the current exact story and never reads the companion store',async()=>{
    const f=fixture(), item=(await f.bridge.api.list()).items[0], calls=[];
    assert.equal((await f.bridge.consume(item)).active,false);
    const clear=f.bridge.api.setConsumer(async context=>{calls.push(context);return {active:true,text:'当前故事的有效记忆',consumedSliceIds:['dialog']};});
    const result=await f.bridge.consume(item);assert.equal(result.text,'当前故事的有效记忆');assert.equal(calls[0].purpose,'companion');
    assert.deepEqual(calls[0].story,f.state.story);assert.equal(f.reads,0);
    assert.equal((await f.bridge.consume({...item,persona:'other'})).active,false);
    clear();assert.equal((await f.bridge.consume(item)).active,false);
});

for(const change of ['story','account','reader','consumer','identity']) test(`late consumer result is discarded after ${change} changes`,async()=>{
    const f=fixture(), item=(await f.bridge.api.list()).items[0], pending=deferred(), entered=deferred();
    f.bridge.api.setConsumer(async()=>{entered.resolve();return pending.promise;});const run=f.bridge.consume(item);await entered.promise;
    if(change==='story')f.state.story={...f.state.story,integrity:'other'};if(change==='account')f.account('st-user:other');
    if(change==='reader')f.state.currentKey='other::book';if(change==='consumer')f.bridge.api.setConsumer(async()=>({active:false}));
    if(change==='identity')f.coread.companionSessions[0].avatar='Other.png';
    pending.resolve({active:true,text:'must not leak',consumedSliceIds:['dialog']});assert.equal((await run).active,false);
});

test('mainline suppression is limited to exact IDs from an active linked bucket and story',async()=>{
    const f=fixture(), pool=[{id:'dialog',__src:key},{id:'book',__src:key},{id:'dialog',__src:'other::book'}];
    const calls=[];f.bridge.api.setConsumer(async context=>{calls.push(context);return {active:true,text:'',consumedSliceIds:['dialog']};});
    const result=await f.bridge.filterMainline(pool);assert.deepEqual(result,[pool[1],pool[2]]);assert.equal(pool.length,3);
    assert.equal(calls[0].purpose,'mainline');assert.equal(f.reads,0);
    f.state.story=null;assert.deepEqual(await f.bridge.filterMainline(pool),pool);
});

test('singleton mount, ready notification and cleanup preserve unrelated owners',()=>{
    const f=fixture(), other=fixture(), events=[], target={Event,dispatchEvent:event=>events.push(event.type)};
    assert.equal(f.bridge.mount(target),true);assert.equal(target[YIMU_COMPANION_KEY],f.bridge.api);assert.deepEqual(events,[YIMU_COMPANION_READY]);
    assert.equal(other.bridge.mount(target),false);other.bridge.unmount();assert.equal(target[YIMU_COMPANION_KEY],f.bridge.api);
    f.bridge.unmount();assert.equal(target[YIMU_COMPANION_KEY],undefined);
});

test('production wiring only projects persisted slices and uses narrow optional consumption hooks',async()=>{
    const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
    assert.match(source,/readRecord: async key[\s\S]*?createReaderPackageReader\(\)\.getReaderChat\(key\)[\s\S]*?bookId:rec\.bookId, slices:rec\.slices, companionOwner:rec\.companionOwner/);
    assert.match(source,/yimuCompanionBridge\.consume\(\{key:coreadDialogBucket\(id\)/);
    assert.match(source,/filterMainline\(await coreadMainlinePool\(\)\)/);
    assert.match(source,/initialized = true;\s*yimuCompanionBridge\.mount\(\)/);
    assert.match(source,/clean\('yimu companion link', \(\) => yimuCompanionBridge\.unmount\(\)\)/);
});

test('host metadata view uses the current settings owner and does not open books or treat role names as a story identity',async()=>{
    const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
    const body=source.slice(source.indexOf('function coreadYimuState()'),source.indexOf('function coreadAssistantConfig()'));
    const settings={enabled:true,coread:{books:[]}},host={characters:[{avatar:'A.png',name:'Same name'}],characterId:0,chatId:'A chat',chatMetadata:{integrity:'proof'},extensionSettings:{fixture:settings}};
    const c=vm.createContext({settings,initialized:true,MODULE_NAME:'fixture',ctx:()=>host,isRuntimeOwner:()=>true,
        coreadPersonaChoices:()=>[{key:'user',name:'USER'}],coreadHostPersona:()=>({key:'user',name:'USER'}),
        readerView:{bookId:'book',companionScope:'scope',chapterIndex:1,scrollRatio:0.5},readerContentCache:{bookId:'book',chapters:[{content:'12345'},{content:'1234567890'}]},
        blobStore:{getBook(){throw Error('must not open a book');}}});
    vm.runInContext(body,c);
    let state=c.coreadYimuState();assert.equal(state.boundaries.book.readTo,10);assert.equal(state.currentKey,'scope::book');assert.equal(state.available,true);
    host.chatMetadata.integrity='';assert.equal(c.coreadYimuState().story,null);
    host.extensionSettings.fixture={enabled:true};assert.equal(c.coreadYimuState().available,false);
    c.readerContentCache=null;assert.equal(Object.keys(c.coreadYimuState().boundaries).length,0);
});

test('native companion generation consumes an optional link but never persists it as a companion slice',async()=>{
    const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
    const body=source.slice(source.indexOf('async function buildCompanionContext('),source.indexOf('// 临时验证钩子（1B-2'));
    const calls=[], c=vm.createContext({coreadCompanion:()=>({chatCtxEnabled:false,presets:[],visiblePercent:15,visibleCharsBefore:6000}),
        coreadCompanionCharacter:()=>({avatar:'A.png',name:'Alice'}),coreadPersona:()=>({key:'user',name:'Reader'}),
        coreadResolveCompanionMacro:async text=>text||'',coreadBookMeta:()=>({title:'Book'}),readerContentCache:{bookId:'book',chapters:[]},
        readerView:{bookId:'book',chapterIndex:0,scrollRatio:0,companionScope:'scope'},computeVisibleWindow:()=>({visibleText:'already visible'}),
        coreadChatCompanionWb:()=>({worldBooks:[]}),cleanContextText:text=>text,coreadMemory:()=>({}),coreadDialogBucket:()=> 'scope::book',
        yimuCompanionBridge:{consume:async request=>{calls.push(request);return {active:true,text:'Bound story memory'};}},
        blobStore:{putReaderChat(){throw Error('a consumed link cannot create companion memories');},getBook(){throw Error('unexpected book read');}}});
    vm.runInContext(body,c);const result=await c.buildCompanionContext('book');
    assert.match(result.systemPrompt,/主动关联的故事记忆/);assert.match(result.systemPrompt,/Bound story memory/);
    assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{key:'scope::book',bookId:'book',scope:'scope',persona:'user',avatar:'A.png'}]);
});
