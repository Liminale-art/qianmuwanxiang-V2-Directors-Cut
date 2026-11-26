import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createYimuCompanionBridge, YIMU_COMPANION_KEY, YIMU_COMPANION_READY, formatReadLabel, offerLinkUpdate, runLink, LINK_TEXT} from '../qianmu-yimu-companion.js';

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
    const bridge = createYimuCompanionBridge({getState:()=>state,resolveAccount:async()=>account,hash,readDictionary:bound=>typeof state.dictionary==='function'?state.dictionary(bound):state.dictionary,
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

test('an unknown archive is rejected without a read, and a stray owner field on the record is not consulted',async()=>{
    const f=fixture();await assert.rejects(()=>f.bridge.api.readSnapshot({...consent,key:'other::book'}),/范围/);assert.equal(f.reads,0);
    f.record.companionOwner={account:'st-user:another'};assert.equal((await f.bridge.api.readSnapshot(consent)).account,'st-user:fixture');
});

test('snapshot is the v2 book form: dialog and book kinds, retrieval words only on book slices, nothing else from the archive',async()=>{
    const f=fixture();f.record.slices[1].keywords=['车站','  告别 ','车站',42,'x'.repeat(41)];f.record.slices[1].synonyms={'阿诚':['诚哥','小诚']};
    const result=await f.bridge.api.readSnapshot(consent);
    assert.equal(result.version,2);assert.equal(result.evidence,'user-confirmed-snapshot');assert.equal(result.entries.length,2);
    assert.deepEqual(result.entries.map(e=>e.kind),['dialog','book']);
    assert.deepEqual(result.entries[0].keywords,[],'a dialogue slice never carries its private keywords');
    assert.deepEqual(result.entries[1].keywords,['车站','告别','阿诚','诚哥','小诚']);
    assert.match(result.hash,/^[a-f0-9]{64}$/);assert.ok(result.entries.every(e=>e.hash.length===64));
    assert.doesNotMatch(JSON.stringify(result),/private keyword|messages|summaryApiKey|ownership|sourceLabel/);
    assert.deepEqual(result.omitted,{future:0,unknown:0,mixed:0});assert.equal(f.reads,1);
    assert.equal(result.readLabel,'');assert.deepEqual(result.terms,['合成书']);
    const plain=fixture(), other=await plain.bridge.api.readSnapshot(consent);
    assert.notEqual(other.entries[1].hash,result.entries[1].hash,'retrieval words are part of what the entry hash covers');
    assert.equal(other.entries[0].hash,result.entries[0].hash);
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

test('the only purpose is the companion reply; the removed mainline purpose never reaches the consumer',async()=>{
    const f=fixture(), item=(await f.bridge.api.list()).items[0], calls=[];
    const clear=f.bridge.api.setConsumer(async context=>{calls.push(context);return {active:true,text:'story',consumedSliceIds:['dialog']};});
    assert.equal(f.bridge.linkAvailable(),false,'the reader entry follows the link handlers, not the reply consumer');
    assert.equal((await f.bridge.consume(item,'mainline')).active,false);assert.equal(calls.length,0);
    assert.equal(f.bridge.filterMainline,undefined);assert.equal(f.bridge.api.version,2);
    clear();assert.equal((await f.bridge.consume(item)).active,false);
});
test('the reply query reaches the consumer as bounded text and is empty when the reader has none',async()=>{
    const f=fixture(), item=(await f.bridge.api.list()).items[0], calls=[];
    f.bridge.api.setConsumer(async context=>{calls.push(context);return {active:true,text:'story'};});
    await f.bridge.consume(item);await f.bridge.consume(item,'companion',{query:'车站那次分别'});
    await f.bridge.consume(item,'companion',{query:'长'.repeat(2500)});await f.bridge.consume(item,'companion',{query:null});
    await f.bridge.consume(item,'companion',{query:42});
    assert.deepEqual(calls.map(call=>call.query),['','车站那次分别','长'.repeat(2000),'','42']);
    assert.equal(f.reads,0);
});

test('singleton mount, ready notification and cleanup preserve unrelated owners',()=>{
    const f=fixture(), other=fixture(), events=[], target={Event,dispatchEvent:event=>events.push(event.type)};
    assert.equal(f.bridge.mount(target),true);assert.equal(target[YIMU_COMPANION_KEY],f.bridge.api);assert.deepEqual(events,[YIMU_COMPANION_READY]);
    assert.equal(other.bridge.mount(target),false);other.bridge.unmount();assert.equal(target[YIMU_COMPANION_KEY],f.bridge.api);
    f.bridge.unmount();assert.equal(target[YIMU_COMPANION_KEY],undefined);
});

test('production wiring only projects persisted slices and uses narrow optional consumption hooks',async()=>{
    const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
    assert.match(source,/readRecord: async key[\s\S]*?createReaderPackageReader\(\)\.getReaderChat\(key\)[\s\S]*?bookId:rec\.bookId, slices:rec\.slices, dictBound:rec\.dictBound\} : null/);
    assert.match(source,/readDictionary: bound => coreadDictFor\(bound\),/);
    assert.match(source,/yimuCompanionBridge\.consume\(\{key:coreadDialogBucket\(id\)/);
    assert.match(source,/yimuCompanionBridge\.consume\(\{key:coreadDialogBucket\(id\)[\s\S]{0,260}?\}, 'companion', \{query:recallQuery\}\)/);
    assert.doesNotMatch(source,/filterMainline|companionOwner/);
    assert.match(source,/initialized = true;\s*yimuCompanionBridge\.mount\(\)/);
    assert.match(source,/clean\('yimu companion link', \(\) => yimuCompanionBridge\.unmount\(\)\)/);
});

test('host metadata view uses the current settings owner and does not open books or treat role names as a story identity',async()=>{
    const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
    const body=source.slice(source.indexOf('function coreadYimuState()'),source.indexOf('function coreadAssistantConfig()'));
    const settings={enabled:true,coread:{books:[]}},host={characters:[{avatar:'A.png',name:'Same name'}],characterId:0,chatId:'A chat',chatMetadata:{integrity:'proof'},extensionSettings:{fixture:settings}};
    const c=vm.createContext({settings,initialized:true,MODULE_NAME:'fixture',ctx:()=>host,isRuntimeOwner:()=>true,
        formatReadLabel,coreadPersonaChoices:()=>[{key:'user',name:'USER'}],coreadHostPersona:()=>({key:'user',name:'USER'}),
        readerView:{bookId:'book',companionScope:'scope',chapterIndex:1,scrollRatio:0.5},readerContentCache:{bookId:'book',chapters:[{content:'12345'},{content:'1234567890'}]},
        blobStore:{getBook(){throw Error('must not open a book');}}});
    vm.runInContext(body,c);
    let state=c.coreadYimuState();assert.equal(state.boundaries.book.readTo,10);assert.equal(state.boundaries.book.label,'第2章 · 67%');assert.equal(state.currentKey,'scope::book');assert.equal(state.available,true);
    host.chatMetadata.integrity='';assert.equal(c.coreadYimuState().story,null);
    host.extensionSettings.fixture={enabled:true};assert.equal(c.coreadYimuState().available,false);
    c.readerContentCache=null;assert.equal(Object.keys(c.coreadYimuState().boundaries).length,0);
});

test('native companion generation consumes an optional link but never persists it as a companion slice',async()=>{
    const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
    const body=source.slice(source.indexOf('async function buildCompanionContext('),source.indexOf('// 临时验证钩子（1B-2'));
    const calls=[], extra=[], c=vm.createContext({coreadCompanion:()=>({chatCtxEnabled:false,presets:[],visiblePercent:15,visibleCharsBefore:6000}),
        coreadCompanionCharacter:()=>({avatar:'A.png',name:'Alice'}),coreadPersona:()=>({key:'user',name:'Reader'}),
        coreadResolveCompanionMacro:async text=>text||'',coreadBookMeta:()=>({title:'Book'}),readerContentCache:{bookId:'book',chapters:[]},
        readerView:{bookId:'book',chapterIndex:0,scrollRatio:0,companionScope:'scope'},computeVisibleWindow:()=>({visibleText:'already visible'}),
        coreadChatCompanionWb:()=>({worldBooks:[]}),cleanContextText:text=>text,coreadMemory:()=>({}),coreadDialogBucket:()=> 'scope::book',
        yimuCompanionBridge:{consume:async(request,...rest)=>{calls.push(request);extra.push(rest);return {active:true,text:'Bound story memory'};}},
        blobStore:{putReaderChat(){throw Error('a consumed link cannot create companion memories');},getBook(){throw Error('unexpected book read');}}});
    vm.runInContext(body,c);const result=await c.buildCompanionContext('book');
    assert.match(result.systemPrompt,/主动关联的故事记忆/);assert.match(result.systemPrompt,/Bound story memory/);
    assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{key:'scope::book',bookId:'book',scope:'scope',persona:'user',avatar:'A.png'}]);
    assert.deepEqual(JSON.parse(JSON.stringify(extra)),[['companion',{query:''}]]);
    await c.buildCompanionContext('book','reader asks about the station');
    assert.deepEqual(JSON.parse(JSON.stringify(extra[1])),['companion',{query:'reader asks about the station'}],'the recall query used for the reader\'s own slices is the one handed to Yimu');
});

test('read label and book terms: explicit label, live label at the same position, percent fallback; dictionary names only when the shared memories use them',async()=>{
    const f=fixture();
    assert.equal((await f.bridge.api.readSnapshot({...consent,readLabel:'第12章 · 37%'})).readLabel,'第12章 · 37%');
    f.state.boundaries.book.label='第3章 · 50%';assert.equal((await f.bridge.api.readSnapshot(consent)).readLabel,'第3章 · 50%');
    assert.equal((await f.bridge.api.readSnapshot({...consent,confirmedReadTo:95})).readLabel,'','a label for another position is not reused');
    f.coread.books[0].charCount=200;assert.equal((await f.bridge.api.readSnapshot({...consent,confirmedReadTo:95})).readLabel,'48%');
    f.state.dictionary={'车站':['站台','驿'],'月球':['月亮'],'结局':[]};
    assert.deepEqual((await f.bridge.api.readSnapshot(consent)).terms,['合成书','车站','站台','结局']);
    const asked=[];f.state.dictionary=bound=>{asked.push(bound);return {};};
    await f.bridge.api.readSnapshot(consent);assert.deepEqual(asked,[undefined],'an archive that never chose lets the reader apply its default');
    f.record={bookId:'book',slices:[dialog(),book()],dictBound:['places',7,'people']};await f.bridge.api.readSnapshot(consent);
    assert.deepEqual(asked[1],['places','people'],'the archive\'s own list is what the dictionary lookup receives');
    f.record={bookId:'book',slices:[dialog(),book()],dictBound:[]};await f.bridge.api.readSnapshot(consent);assert.deepEqual(asked[2],[]);
    f.state.dictionary=()=>{throw Error('no dictionary');};assert.deepEqual((await f.bridge.api.readSnapshot(consent)).terms,['合成书']);
    assert.equal(formatReadLabel({chapterIndex:11,progress:37}),'第12章 · 37%');assert.equal(formatReadLabel({chapterIndex:4,progress:50.4,comic:true}),'第5页 · 50%');
    assert.equal(formatReadLabel({chapterIndex:null,progress:NaN}),'');
});

test('a long book keeps what was read last when the shared memories exceed the link size',async()=>{
    const f=fixture();f.record.slices=Array.from({length:205},(_,i)=>book(`b${i}`,i+1));
    const result=await f.bridge.api.readSnapshot({...consent,confirmedReadTo:300});
    assert.equal(result.entries.length,200);assert.equal(result.omitted.overflow,5);
    assert.deepEqual([result.entries[0].id,result.entries.at(-1).id],['b5','b204']);
    f.record.slices=[book('big',10),book('late',20)];f.record.slices[0].summary='长'.repeat(150000);f.record.slices[1].summary='新'.repeat(100000);
    assert.deepEqual((await f.bridge.api.readSnapshot(consent)).entries.map(e=>e.id),['late']);
});

function linkFixture(){
    const f=fixture(),calls=[];let stored=null,failing=false;
    const handlers={status:context=>{calls.push(['status',context]);return stored?{linked:true,confirmedReadTo:stored.confirmedReadTo,readLabel:stored.readLabel,updatedAt:5,
            entryHashes:Object.fromEntries(stored.entries.map(e=>[e.id,e.hash]))}:{linked:false};},
        update:async(context,payload)=>{calls.push(['update',context,payload]);if(failing)throw Error('offline');stored=payload.snapshot;return {linked:true};},
        unlink:async context=>{calls.push(['unlink',context]);stored=null;return {linked:false};}};
    const selection={key,bookId:'book',scope:'companion-scope',persona:'Persona.png',avatar:'Char.png'};
    return {f,calls,handlers,selection,attach:()=>f.bridge.api.setLink(handlers),fail(value){failing=value;},get stored(){return stored;}};
}

test('link handlers: status, update and unlink reach Yimu only for the exact archive and the open story',async()=>{
    const l=linkFixture(),{f,selection,calls}=l;
    assert.equal(f.bridge.linkAvailable(),false);assert.equal(await f.bridge.linkStatus(selection),null);
    await assert.rejects(()=>f.bridge.linkUpdate(selection,{confirmedReadTo:100}),/不可用/);
    assert.throws(()=>f.bridge.api.setLink({status(){}}),TypeError);
    const clear=l.attach();assert.equal(f.bridge.linkAvailable(),true);
    assert.deepEqual(await f.bridge.linkStatus(selection),{linked:false,confirmedReadTo:null,entryHashes:{},readLabel:'',updatedAt:0});
    assert.deepEqual(calls[0][1],{version:2,account:'st-user:fixture',...selection,title:'合成书',charName:'书友',userName:'读者',story:f.state.story});
    await assert.rejects(()=>f.bridge.linkUpdate(selection,{confirmedReadTo:null}),/确认/);
    const result=await f.bridge.linkUpdate(selection,{confirmedReadTo:100,readLabel:'第2章 · 40%',note:'  一起读到分别  '});
    assert.deepEqual(result,{linked:true,readLabel:'第2章 · 40%',entries:2});
    const sent=calls.at(-1)[2];assert.equal(sent.note,'一起读到分别');assert.equal(sent.confirmed,true);assert.equal(sent.confirmedLocalOwnership,true);
    assert.equal(sent.snapshot.version,2);assert.equal(sent.snapshot.confirmedReadTo,100);assert.deepEqual(sent.snapshot.entries.map(e=>e.id),['dialog','book']);
    const status=await f.bridge.linkStatus(selection);assert.equal(status.linked,true);assert.equal(status.readLabel,'第2章 · 40%');assert.equal(status.updatedAt,5);
    assert.deepEqual(Object.keys(status.entryHashes),['dialog','book']);
    assert.equal(await f.bridge.linkStatus({...selection,persona:'other'}),null);
    await assert.rejects(()=>f.bridge.linkUpdate({...selection,persona:'other'},{confirmedReadTo:100}),/范围/);
    const story=f.state.story;f.state.story=null;
    assert.equal(await f.bridge.linkStatus(selection),null);await assert.rejects(()=>f.bridge.linkUpdate(selection,{confirmedReadTo:100}),/故事/);
    f.state.story=story;f.state.currentKey='';assert.equal((await f.bridge.linkStatus(selection)).linked,true,'a closed reader can still be asked');
    l.fail(true);await assert.rejects(()=>f.bridge.linkUpdate(selection,{confirmedReadTo:100}),/offline/);l.fail(false);
    assert.deepEqual(await f.bridge.unlink(selection),{linked:false});assert.equal((await f.bridge.linkStatus(selection)).linked,false);
    clear();assert.equal(f.bridge.linkAvailable(),false);assert.equal(await f.bridge.linkStatus(selection),null);
    l.attach();f.bridge.unmount();assert.equal(f.bridge.linkAvailable(),false);
});

test('a story switched while the reader builds the snapshot never receives the update',async()=>{
    const l=linkFixture(),{f,selection,calls}=l,pending=deferred();l.attach();f.reader(()=>pending.promise);
    const run=f.bridge.linkUpdate(selection,{confirmedReadTo:100});while(!f.reads)await new Promise(resolve=>setImmediate(resolve));
    f.state.story={...f.state.story,file:'other'};pending.resolve(f.record);
    await assert.rejects(()=>run,/切换/);assert.equal(calls.filter(call=>call[0]==='update').length,0);
});

test('the reader centre button links an unlinked book after one confirmation and updates a linked one',async()=>{
    const l=linkFixture(),{f,selection}=l,asked=[],confirmed=[],notes=[];l.attach();
    const ui={ask:async prompt=>{asked.push(prompt);return '';},confirm:async prompt=>{confirmed.push(prompt);return confirmed.length>1;},notify:(...args)=>notes.push(args)};
    const captured={selection,confirmedReadTo:100,readLabel:'第2章 · 40%'};
    assert.equal(await runLink(f.bridge,captured,ui),'declined');assert.equal(l.stored,null);
    assert.deepEqual(confirmed[0],{title:'关联伴读',okButton:'关联',cancelButton:'取消',body:'把《合成书》读到 第2章 · 40% 的共读记忆关联到当前故事？'});
    assert.equal(await runLink(f.bridge,captured,ui),'linked');assert.equal(l.stored.entries.length,2);
    assert.deepEqual(notes.at(-1),[LINK_TEXT.linked,'success']);assert.equal(asked.length,0);
    assert.equal(await runLink(f.bridge,captured,ui),'updated','a linked book may always be updated from the button');
    assert.equal(asked[0].body,'这次读到 第2章 · 40%。要更新到当前故事吗？');assert.equal(confirmed.length,2);
    f.state.story=null;assert.equal(await runLink(f.bridge,captured,ui),'unavailable');assert.deepEqual(notes.at(-1),[LINK_TEXT.noStory,'info']);
    assert.equal(await runLink(f.bridge,{selection,confirmedReadTo:null},ui),'skipped');
});

test('book terms come from the dictionaries of the archive being linked, not from the one open in the reader, with the reader\'s real lookup',async()=>{
    const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
    const cut=name=>{const start=source.indexOf(`\nfunction ${name}(`)+1,end=source.indexOf('\n}\n',start)+3;assert.ok(start>0&&end>start,name);return source.slice(start,end);};
    const memory={dictBooks:[
        {id:'dict-default',name:'默认词典',pairs:{'结局':['终章']}},
        {id:'places',name:'地名',pairs:{'车站':['站台','驿']}},
        {id:'people',name:'人名',pairs:{'人物':['角色','主角']}},
        {id:'unused',name:'别的书',pairs:{'月球':['月亮']}}]};
    // The reader has a third archive open, bound to a dictionary neither linked archive uses.
    const c=vm.createContext({COREAD_DEFAULT_DICT:'dict-default',coreadMemory:()=>memory,readerDialog:{bucket:'open::book',loaded:true,dictBound:['unused']},
        isPlainObject:value=>value!==null&&typeof value==='object'&&!Array.isArray(value),uniqueClean:list=>[...new Set(list.map(item=>String(item||'').trim()).filter(Boolean))]});
    vm.runInContext(['coreadNormalizeSynonyms','coreadMergeSynonyms','coreadBoundDicts','coreadDictFor','coreadActiveDict'].map(cut).join('\n'),c);
    const keys=['scope-a::book','scope-b::book','scope-c::book','scope-d::book'];
    const slicesFor=bucket=>[dialog(),book()].map(slice=>({...slice,provenance:{...slice.provenance,bucket}}));
    const records={
        'scope-a::book':{bookId:'book',slices:slicesFor('scope-a::book'),dictBound:['places']},
        'scope-b::book':{bookId:'book',slices:slicesFor('scope-b::book'),dictBound:['people','places']},
        'scope-c::book':{bookId:'book',slices:slicesFor('scope-c::book')},                     // saved before the field existed
        'scope-d::book':{bookId:'book',slices:slicesFor('scope-d::book'),dictBound:[]}};       // everything released on purpose
    const state={available:true,owner:{},coread:{books:[{id:'book',title:'合成书'}],companionSessions:keys.map((k,i)=>({scope:k.split('::')[0],avatar:`Char${i}.png`,userAvatar:'Persona.png'}))},
        characters:keys.map((k,i)=>({avatar:`Char${i}.png`,name:`书友${i}`})),personas:[{key:'Persona.png',name:'读者'}],boundaries:{book:{readTo:100}},story:{avatar:'Char0.png',file:'story',integrity:'proof'},currentKey:'open::book'};
    const bridge=createYimuCompanionBridge({getState:()=>state,resolveAccount:async()=>'st-user:fixture',hash,listKeys:async()=>keys,
        readRecord:async k=>{const rec=records[k];return rec?{bookId:rec.bookId,slices:rec.slices,dictBound:rec.dictBound}:null;},readDictionary:bound=>c.coreadDictFor(bound)});
    const terms=async k=>(await bridge.api.readSnapshot({...consent,key:k})).terms;
    assert.deepEqual(await terms('scope-a::book'),['合成书','车站','站台']);
    assert.deepEqual(await terms('scope-b::book'),['合成书','车站','站台','人物','角色','主角']);
    assert.deepEqual(await terms('scope-c::book'),['合成书','结局','终章'],'no choice recorded: the default dictionary only');
    assert.deepEqual(await terms('scope-d::book'),['合成书'],'an emptied list brings no dictionary at all');
    assert.deepEqual(Object.keys(c.coreadActiveDict([])),['月球'],'while the reader itself keeps using the open archive\'s list');
    c.readerDialog={bucket:'',loaded:false};assert.deepEqual(Object.keys(c.coreadActiveDict([])),['结局']);
});

test('stage summaries stay in the reader: Yimu still gets the fine slices, and an archive with stages hashes the same',async()=>{
    const plain=fixture(), base=await plain.bridge.api.readSnapshot(consent);
    const f=fixture();f.record={...f.record,slices:f.record.slices,stages:[{id:'stage-1',stage:true,summary:'这一段的阶段总结。',keywords:['阶段'],status:'active',
        parents:[{id:'dialog',fp:'x'}],provenance:{source:'dialog',sources:['dialog'],bookId:'book',bucket:key,readTo:80,dialogFrom:0,dialogTo:1,dialogMessageIds:['d1','d2']}}]};
    const result=await f.bridge.api.readSnapshot(consent);
    assert.deepEqual(result.entries.map(e=>e.id),['dialog','book']);
    assert.doesNotMatch(JSON.stringify(result),/阶段总结|stage-1/);
    assert.equal(result.hash,base.hash);
});
