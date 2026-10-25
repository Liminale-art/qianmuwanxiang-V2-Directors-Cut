import test from 'node:test';
import assert from 'node:assert/strict';
import {portableDocument,collectBackupSources,validateBackupHeader,restoreBackupDocument,BACKUP_FORMAT,BACKUP_VERSION,BACKUP_MAX_SOURCES} from '../yimu/backup-contract.mjs';
import {SCHEMA,createDocument,validateDocument,applyOperation} from '../yimu/contract.mjs';
import {buildPlan,nextBatch} from '../yimu/core.mjs';
import {sourceLabel} from '../yimu/source-scope.mjs';

const clone=value=>structuredClone(value),hash='a'.repeat(64);
const binding=(name='current')=>({avatar:'Synthetic.png',file:name,integrity:`proof_${name}`});
const range=(start=1,end=start)=>({start,end,hashes:Array(end-start+1).fill(hash)});
const summary=(id='fine',patch={})=>({id,revision:2,kind:'summary',text:'原有含义与知情边界保持。',source:range(),status:'active',edited:false,history:[],conflicts:[],candidate:null,...patch});
const previous=(value)=>{const {history,conflicts,candidate,...rest}=value;return rest;};
function document(){const doc=createDocument(binding());doc.enabled=true;doc.initialRange={start:1,end:9,total:9};doc.entries=[summary()];return doc;}
function companion(patch={}){return {version:1,confirmed:true,account:'st-user:source',key:'scope::book',bookId:'book',scope:'scope',persona:'Persona.png',avatar:'Char.png',title:'书',charName:'角色',userName:'用户',confirmedReadTo:10,hash,entries:[{id:'book',kind:'book',text:'书中情节不是亲历。',readTo:10,hash,sourceLabel:'书中情节（阅读背景）'}],...patch};}
function header(doc=document()){
    return {format:BACKUP_FORMAT,version:BACKUP_VERSION,packageId:'package_synthetic',createdAt:'2026-10-25T12:00:00.000Z',document:portableDocument(doc),
        sources:collectBackupSources(doc).map(source=>({id:source.id,binding:source.binding,available:true,attached:false,bytes:128,floorCount:9,sha256:hash,fingerprint:hash}))};
}

test('portable whitelist preserves memory meaning and management history without receipts, credentials or response-only proofs',()=>{
    const doc=document();doc.settings={recent:8,preference:'保留约定',profileId:'private_profile',model:'private_model',apiKey:'secret_setting'};
    doc.operations=['private_receipt'];doc.receipts={private_receipt:'private_body'};doc.secret='secret_root';
    doc.creation={token:'secret_creation'};doc.movedTo={token:'secret_move'};
    const item=doc.entries[0];item.origin={binding:{...binding('ancestor'),secret:'secret_binding'},offset:12,secret:'secret_origin'};
    item.source.secret='secret_range';item.originVerified=true;item.quoteText='response-only raw';item.apiKey='secret_entry';
    item.history=[previous(summary('fine',{revision:1,text:'旧版人工文本',edited:true,apiKey:'secret_history'}))];
    item.conflicts=[{id:'conflict',reason:'另一设备修改',text:'未确认修改',edited:true,apiKey:'secret_conflict'}];
    item.candidate={id:'candidate',text:'待选整理',kind:'summary',source:{...range(),secret:'secret_candidate'},status:'active',token:'secret_token'};
    const before=clone(doc),portable=portableDocument(doc),output=JSON.stringify(portable);
    assert.deepEqual(doc,before);assert.equal(portable.enabled,true);assert.equal(portable.entries[0].text,item.text);
    assert.equal(portable.entries[0].history[0].text,'旧版人工文本');assert.equal(portable.entries[0].conflicts[0].reason,'另一设备修改');assert.equal(portable.entries[0].candidate.text,'待选整理');
    assert.deepEqual(portable.settings,{recent:8,preference:'保留约定'});
    assert.doesNotMatch(output,/secret_|private_|response-only|originVerified|receipts|operations|creation|movedTo|profileId|model/);
    assert.equal(portable.schema,SCHEMA);assert.deepEqual(portableDocument(portable),portable);
});

test('all nested source references and lineage are collected once in deterministic package-local order',()=>{
    const doc=document();doc.lineage={sourceBinding:binding('lineage'),cutoff:15,offset:10,bridgeCount:5,bridgeHashes:Array(5).fill(hash)};
    const item=doc.entries[0];item.origin={binding:binding('ancestor'),offset:0};
    item.history=[previous(summary('fine',{revision:1,origin:{binding:binding('past'),offset:0}}))];
    item.conflicts=[{id:'conflict',text:'旧源冲突',origin:{binding:binding('conflict'),offset:0}}];
    item.candidate={id:'candidate',text:'新源候选',kind:'summary',source:range(),origin:{binding:binding('ancestor'),offset:0}};
    assert.deepEqual(collectBackupSources(doc),[
        {id:'source_0',binding:binding()},
        {id:'source_1',binding:binding('lineage')},
        {id:'source_2',binding:binding('ancestor')},
        {id:'source_3',binding:binding('past')},
        {id:'source_4',binding:binding('conflict')},
    ]);
});

test('only unresolved references never grant lookup permission; a genuinely resolved reference can identify the same source',()=>{
    const doc=document();doc.entries[0].origin={binding:binding('ancestor'),offset:0,unresolved:true};
    assert.equal(collectBackupSources(doc)[1].unresolved,true);
    doc.entries.push(summary('second',{origin:{binding:binding('ancestor'),offset:0}}));
    assert.equal(collectBackupSources(doc)[1].unresolved,undefined);
    const portable=portableDocument(doc);assert.equal(portable.entries[0].origin.unresolved,true);
});

test('companion snapshots retain their original account and nature only as inert read-only archives',async()=>{
    const doc=document();doc.companion=companion();doc.archivedCompanion=[companion(),companion({hash:'b'.repeat(64),account:'st-user:previous'})];
    const portable=portableDocument(doc);assert.equal(portable.companion,undefined);assert.equal(portable.archivedCompanion.length,2);
    const result=restoreBackupDocument(portable,{binding:binding('restored'),mappings:{source_0:binding('restored')}});
    assert.equal(result.document.companion,undefined);assert.deepEqual(result.document.archivedCompanion,portable.archivedCompanion);
    result.document.enabled=true;result.document.entries=[];
    const plan=await buildPlan(result.document,null,{binding:binding('restored'),messages:[]});
    assert.deepEqual(plan.entries,[]);assert.ok(result.document.archivedCompanion.every(item=>item.account!=='st-user:current'));
});

test('header accepts only its own format and strips unrelated fields at every metadata boundary',()=>{
    const value=header();value.apiKey='secret';value.sources[0].path='../../secret';value.sources[0].binding.token='secret';
    const parsed=validateBackupHeader(value);assert.equal(parsed.format,BACKUP_FORMAT);assert.doesNotMatch(JSON.stringify(parsed),/secret|\.\.\//);
    assert.deepEqual(validateBackupHeader(parsed),parsed);
});

for(const patch of [
    {format:'third-party-summary'},{version:2},{packageId:'../escape'},{createdAt:'2026-02-30T12:00:00Z'},
    {createdAt:'2026-10-25'},{sources:[]},
])test(`header rejects malformed envelope ${JSON.stringify(patch)}`,()=>assert.throws(()=>validateBackupHeader({...header(),...patch})));

test('header rejects source duplication, omissions, undeclared source identity and unverifiable claims',()=>{
    const valid=header(),source=valid.sources[0];
    for(const patch of [
        {id:'source_01'},{binding:binding('foreign')},{available:false},{attached:true,available:false,bytes:0,floorCount:0,sha256:undefined,fingerprint:undefined},
        {bytes:-1},{bytes:Number.MAX_SAFE_INTEGER+1},{floorCount:1.5},{sha256:'bad'},{fingerprint:undefined},{bytes:0},
    ])assert.throws(()=>validateBackupHeader({...valid,sources:[{...source,...patch}]}));
    const doc=document();doc.entries[0].origin={binding:binding('foreign'),offset:0};const value=header(doc);
    value.sources[1]={...value.sources[0]};assert.throws(()=>validateBackupHeader(value),/重复/);
    const missing={...valid,sources:[{id:'source_0',binding:binding(),available:false,attached:false,bytes:0,floorCount:0}]};
    assert.equal(validateBackupHeader(missing).sources[0].available,false);
});

test('unknown document schema and more than 256 distinct source identities are rejected',()=>{
    assert.throws(()=>portableDocument({...document(),schema:SCHEMA+1}),/版本/);
    const doc=document();doc.entries=[];
    for(let i=0;i<BACKUP_MAX_SOURCES;i++)doc.entries.push(summary(`fine_${i}`,{origin:{binding:binding(`foreign_${i}`),offset:0}}));
    assert.throws(()=>collectBackupSources(doc),/来源过多/);
});

test('bad historical/candidate/conflict source data is rejected before undo or accept can expose it',()=>{
    for(const place of ['history','conflicts','candidate']){
        for(const change of [
            {source:{start:1,end:2,hashes:[hash]}},
            {origin:{binding:binding('../escape'),offset:0}},
            {kind:'manual',source:range()},
            {kind:'excerpt',text:'原文补充',source:range(),parent:{id:'fine',revision:1},quote:{start:0,end:2000}},
            {status:'injected'},
        ]){
            const doc=document(),value={...previous(summary('old')),...change};
            if(place==='candidate')doc.entries[0].candidate=value;else doc.entries[0][place]=[value];
            assert.throws(()=>portableDocument(doc),`${place} ${JSON.stringify(change)}`);
        }
    }
});

test('unknown nested patch fields are stripped rather than replayed into operational state',()=>{
    const doc=document();doc.entries[0].candidate={id:'candidate',text:'保留候选',enabled:true,history:[{token:'secret'}],operations:['secret'],originVerified:true};
    doc.entries[0].conflicts=[{id:'conflict',reason:'保留原因',text:'保留冲突',receipts:{secret:true},previous:{source:{start:999}}}];
    const output=portableDocument(doc);assert.deepEqual(output.entries[0].candidate,{id:'candidate',text:'保留候选'});
    assert.deepEqual(output.entries[0].conflicts,[{id:'conflict',reason:'保留原因',text:'保留冲突'}]);
});

test('history cannot rename an entry or replace it with another current/future revision through undo',()=>{
    for(const patch of [{id:'another'},{revision:2},{revision:3}]){
        const doc=document();doc.entries[0].history=[previous(summary('fine',{revision:1,...patch}))];
        assert.throws(()=>portableDocument(doc),/历史版本归属/);
    }
});

test('restore requires an explicitly verified primary mapping and never creates a misleading empty chat',()=>{
    assert.throws(()=>restoreBackupDocument(document(),{binding:binding('restored')}),/仅保留为导入档案/);
    assert.throws(()=>restoreBackupDocument(document(),{binding:binding('restored'),mappings:{source_0:binding('different')}}),/主来源/);
});

test('restore starts disabled with fresh operation identity but preserves content, histories and exclusions',()=>{
    const doc=document();doc.revision=8;doc.epoch=9;doc.configRevision=4;doc.settings={recent:8,profileId:'private',model:'private'};
    doc.entries[0].history=[previous(summary('fine',{revision:1,edited:true,text:'旧人工修订'}))];
    doc.entries.push(summary('deleted',{status:'deleted'}),summary('excluded',{status:'excluded'}));
    const before=clone(doc),target=binding('restored');
    const {document:restored,warnings}=restoreBackupDocument(doc,{binding:target,mappings:{source_0:target}});
    assert.deepEqual(doc,before);assert.deepEqual(warnings,[]);assert.equal(restored.enabled,false);assert.deepEqual(restored.binding,target);
    assert.equal(restored.revision,0);assert.equal(restored.epoch,0);assert.equal(restored.configRevision,0);assert.deepEqual(restored.operations,[]);assert.deepEqual(restored.receipts,{});
    assert.deepEqual(restored.settings,{recent:8});assert.equal(restored.entries[0].history[0].text,'旧人工修订');
    assert.equal(restored.entries[1].status,'deleted');assert.equal(restored.entries[2].status,'excluded');
    assert.equal(restored.entries[0].origin,undefined);assert.deepEqual(validateDocument(restored),restored);
});

test('unmapped foreign sources keep true identity and are denied in current, historical and partial candidate versions',()=>{
    const doc=document(),foreign=binding('ancestor'),target=binding('restored');
    const item=doc.entries[0];item.origin={binding:foreign,offset:20};item.history=[previous(summary('fine',{revision:1,origin:{binding:foreign,offset:20}}))];
    item.candidate={id:'candidate',text:'仍保留候选含义'};item.conflicts=[{id:'conflict',text:'仍保留另一版本',reason:'设备冲突'}];
    const {document:restored,warnings}=restoreBackupDocument(doc,{binding:target,mappings:{source_0:target}});
    assert.equal(warnings.length,1);assert.equal(warnings[0].sourceId,'source_1');
    for(const version of [restored.entries[0],...restored.entries[0].history,...restored.entries[0].conflicts,restored.entries[0].candidate]){
        assert.equal(version.status,'invalid');assert.deepEqual(version.origin,{binding:foreign,offset:20,unresolved:true});
    }
    restored.enabled=true;
    const undone=applyOperation(restored,{id:'undo',type:'entry',entryId:'fine',expectedRevision:2,action:'undo'}).document;
    assert.equal(undone.entries[0].origin.unresolved,true);assert.equal(undone.entries[0].status,'invalid');
    const accepted=applyOperation(restored,{id:'accept',type:'entry',entryId:'fine',expectedRevision:2,action:'acceptCandidate'}).document;
    assert.equal(accepted.entries[0].origin.unresolved,true);assert.equal(accepted.entries[0].status,'invalid');
    const raw=Array.from({length:8},()=>({name:'甲',mes:'后来的另一剧情'}));
    const batch=nextBatch({...restored,initialRange:null},raw,{recent:5,batch:6000,trigger:4000},{force:true});assert.equal(batch,null);
    assert.match(sourceLabel(restored.entries[0]),/ancestor/);
});

test('explicit verified source mapping clears unresolved flags at every revision without changing offsets or text',()=>{
    const doc=document(),foreign=binding('ancestor'),target=binding('restored'),newForeign=binding('restored_ancestor');
    doc.entries[0].origin={binding:foreign,offset:30,unresolved:true};
    doc.entries[0].history=[previous(summary('fine',{revision:1,origin:{binding:foreign,offset:30,unresolved:true}}))];
    doc.entries[0].candidate={id:'candidate',text:'候选',source:range(),kind:'summary',origin:{binding:foreign,offset:30,unresolved:true}};
    const restored=restoreBackupDocument(doc,{binding:target,mappings:{source_0:target,source_1:newForeign}}).document;
    for(const value of [restored.entries[0],...restored.entries[0].history,restored.entries[0].candidate])assert.deepEqual(value.origin,{binding:newForeign,offset:30});
    assert.equal(restored.entries[0].text,doc.entries[0].text);
});

test('lineage remaps only explicitly mapped sources and source variants cannot collapse into one file',()=>{
    const doc=document(),foreign=binding('ancestor'),target=binding('restored'),newForeign=binding('restored_ancestor');
    doc.lineage={sourceBinding:foreign,cutoff:15,offset:10,bridgeCount:5,bridgeHashes:Array(5).fill(hash)};
    doc.entries[0].origin={binding:foreign,offset:0};
    const restored=restoreBackupDocument(doc,{binding:target,mappings:{source_0:target,source_1:newForeign}}).document;
    assert.deepEqual(restored.lineage,{...doc.lineage,sourceBinding:newForeign});
    assert.throws(()=>restoreBackupDocument(doc,{binding:target,mappings:{source_0:target,source_1:target}}),/同一聊天/);
    assert.throws(()=>restoreBackupDocument(doc,{binding:target,mappings:{source_0:target,source_9:newForeign}}),/未知来源/);
});

test('a genuine empty branch can export its ancestor, but an unresolved imported lineage cannot grant lookup permission',()=>{
    const doc=document(),target=binding('restored'),ancestor=binding('ancestor');doc.entries=[];
    doc.lineage={sourceBinding:ancestor,cutoff:9,offset:4,bridgeCount:5,bridgeHashes:Array(5).fill(hash)};
    assert.equal(collectBackupSources(doc)[1].unresolved,undefined);
    const restored=restoreBackupDocument(doc,{binding:target,mappings:{source_0:target}}).document;
    assert.equal(restored.lineage.unresolved,true);assert.equal(collectBackupSources(restored)[1].unresolved,true);
    const mapped=restoreBackupDocument(restored,{binding:binding('again'),mappings:{source_0:binding('again'),source_1:binding('verified_ancestor')}}).document;
    assert.equal(mapped.lineage.unresolved,undefined);assert.equal(collectBackupSources(mapped)[1].unresolved,undefined);
});

test('valid reordered header sources normalize to primary-first without changing source identities',()=>{
    const doc=document();doc.entries[0].origin={binding:binding('ancestor'),offset:0};
    const value=header(doc);value.sources.reverse();
    assert.deepEqual(validateBackupHeader(value).sources.map(source=>source.id),['source_0','source_1']);
});
