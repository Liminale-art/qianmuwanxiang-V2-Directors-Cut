import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {configureStAccountStorage,createConfiguredStAccountStorage} from '../qianmu-st-account-storage.js';
import {createTextCollectionOriginalStore,textCollectionOriginalDescriptor} from '../qianmu-text-collection-original.js';
import {createTextCollectionSession} from '../qianmu-text-collection-session.js';
import {createTextCollection,restoreTextCollectionCopy} from '../qianmu-text-collection.js';

const origin='https://st.fixture.invalid',namespace='st-user:collection-integration';
const account='st-user:'+createHash('sha256').update(namespace.slice(8)).digest('hex');
const json=(value,status=200)=>new Response(typeof value==='string'?value:JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const record=(id='collection-0001',text='厨房的一刻\r\n值得纪念😀')=>createTextCollection({id,mode:'full',createdAt:10,
    source:{account,chatId:'original-chat',messageId:4,replyId:'original-reply',charName:'当时 CHAR',userName:'当时 USER',text}});

// Actual session -> native client -> native storage -> HTTP contract. Only the
// HTTP server is an in-memory fixture; no ST production, disk or external calls.
// Independent clients demonstrate sequential cross-client visibility, NOT CAS
// or linearizable simultaneous writes between independent devices.
function fixture(t,{legacyStatus=404,legacySnapshot=null}={}){
    const files=new Map(),calls=[];let liveNamespace=namespace,dropNextHeadAck=false;
    const fetch=async(url,request={})=>{
        const parsed=new URL(url,origin);assert.equal(parsed.origin,origin);calls.push({path:parsed.pathname,request});
        const path=parsed.pathname;
        assert.equal(request.credentials,'same-origin');assert.equal(request.cache,'no-store');assert.equal(request.redirect,'error');
        assert.equal(request.headers['X-CSRF-Token'],'fixture-csrf');assert.equal(request.headers.Authorization,undefined);
        if(path==='/api/plugins/qianmu-tts/text-collections/snapshot'){
            assert.equal(request.method,'POST');assert.equal(JSON.parse(request.body).expectedAccount,account);
            return legacySnapshot?json({ok:true,version:1,expectedAccount:account,libraryRevision:legacySnapshot.libraryRevision,backup:legacySnapshot}):json({},legacyStatus);
        }
        if(path==='/api/files/upload'){
            assert.equal(request.method,'POST');const payload=JSON.parse(request.body);
            assert.match(payload.name,/^qianmu-v2-[a-f0-9]{64}-[a-z0-9-]+\.json$/);
            const body=Buffer.from(payload.data,'base64').toString('utf8');files.set(payload.name,body);
            if(dropNextHeadAck&&JSON.parse(body).schema==='qianmu.st-account-head.v1'){dropNextHeadAck=false;throw Error('fixture: accepted head, lost HTTP receipt');}
            return json({path:`/user/files/${payload.name}`});
        }
        assert.match(path,/^\/user\/files\/qianmu-v2-[a-z0-9-]+\.json$/,'native integration must never use a plugin write or unrelated endpoint');
        assert.equal(request.method,'GET');const body=files.get(path.split('/').at(-1));return body===undefined?json({},404):json(body);
    };
    t.mock.method(globalThis,'fetch',fetch);
    const config={resolveNamespace:async()=>liveNamespace,isCurrent:()=>true,headers:()=>({'X-CSRF-Token':'fixture-csrf',Authorization:'never-forward'}),fetchImpl:fetch,origin,cryptoImpl:webcrypto};
    configureStAccountStorage(config);
    const sessions=[];
    const open=async()=>{const session=await createTextCollectionSession({resolveNamespace:config.resolveNamespace,isCurrent:config.isCurrent,headers:config.headers,cryptoImpl:webcrypto});sessions.push(session);return session;};
    t.after(()=>sessions.forEach(session=>session.close()));
    return {files,calls,open,reconfigure:()=>configureStAccountStorage(config),get uploads(){return calls.filter(call=>call.path==='/api/files/upload').length;},
        loseHeadAck(){dropNextHeadAck=true;},setAccount(value){liveNamespace=value;}};
}

test('reconfiguring native storage rejects a cached read from the old client lifetime',async t=>{
    const f=fixture(t),session=await f.open();await session.prepareCreate(record()).submit();await session.list({cursor:null,limit:50});
    f.reconfigure();const count=f.calls.length;
    await assert.rejects(session.list({cursor:null,limit:50},{preferCache:true}),{code:'text_collection_sync_account'});assert.equal(f.calls.length,count);
    const next=await f.open();assert.equal((await next.list({cursor:null,limit:50})).total,1);
});

test('floor star reads do not invalidate shared list/detail cache or redownload verified originals on reopen',async t=>{
    const f=fixture(t),first=await f.open(),original=record();await first.prepareCreate(original).submit();
    await first.get(original.id);const before=f.calls.length;
    const sources=await first.sources();assert.deepEqual(sources,{expectedAccount:account,items:[{id:original.id,revision:1,account,chatId:'original-chat',messageId:4}]});
    assert.doesNotMatch(JSON.stringify(sources),/厨房|当时 CHAR|original-reply/);
    assert.equal(f.calls.length,before,'painting stars must use verified browsing data, not backup export');first.close();
    const second=await f.open();assert.equal((await second.list({cursor:null,limit:50},{preferCache:true})).total,1);
    assert.deepEqual(await second.sources(),sources);assert.deepEqual((await second.get(original.id)).record,original);
    assert.equal(f.calls.length,before,'reopening after star refresh causes no file requests');
    await second.sources({revalidate:true});const checked=f.calls.length;assert.ok(checked>before,'explicit focus refresh still checks remote files');
    assert.deepEqual((await second.get(original.id)).record,original);assert.equal(f.calls.length,checked,'revalidation does not clear unchanged originals');
    await second.prepareDelete(original.id,1).submit();assert.deepEqual((await second.sources()).items,[]);
    f.setAccount('st-user:other');await assert.rejects(second.sources());
});

test('configured real session uses native ST files without an installed backend and new clients can read, edit and delete',async t=>{
    const f=fixture(t),first=await f.open();assert.equal(first.expectedAccount,account);
    assert.equal((await first.list()).total,0,'legacy 404 is not an installation requirement');
    const initial=[...f.files.values()].map(body=>JSON.parse(body)).find(body=>body.schema==='qianmu.st-account-document.v1'&&body.slot==='collections');
    assert.equal(initial.value.version,2,'actual native initialization uses the compact format without a migration or user setting');
    const original=record(),created=await first.prepareCreate(original).submit();assert.equal(created.revision,1);first.close();
    const second=await f.open();assert.deepEqual((await second.get(original.id)).record,original);
    const page=await second.list({cursor:null,limit:50});assert.equal(page.total,1);assert.equal(page.items[0].charName,'当时 CHAR');
    const edited=await second.prepareEdit(original.id,1,'第二端修改😀').submit();assert.equal(edited.revision,2);second.close();
    const third=await f.open();assert.equal((await third.get(original.id)).record.text,'第二端修改😀');
    await third.prepareDelete(original.id,2).submit();assert.equal((await third.get(original.id)).record,null);
    assert.equal((await third.list()).total,0);assert.equal((await third.inventory()).deletedCount,1);
    assert.equal(f.calls.filter(call=>call.path.includes('/api/plugins/')).length,1,'the old backend is only probed once for migration');
    assert.ok(f.files.size>=5,'immutable old bodies remain as recovery history, not discarded by collection deletion');
});

test('accepted native head with lost acknowledgement retries the same operation without duplicate entry, revision or upload',async t=>{
    const f=fixture(t),session=await f.open();await session.list();
    const original=record(),operation=session.prepareCreate(original);f.loseHeadAck();
    await assert.rejects(operation.submit(),error=>error.writeState==='unconfirmed');
    const writes=f.uploads,other=await f.open();assert.equal((await other.list()).total,1);assert.deepEqual((await other.get(original.id)).record,original);
    const retry=await operation.submit();assert.equal(retry.mutationId,operation.request.mutationId);assert.equal(retry.id,original.id);assert.equal(retry.revision,1);assert.equal(retry.libraryRevision,1);
    assert.equal(f.uploads,writes,'the confirmed receipt is reconciled by reading its persisted identity, never re-uploaded');
    assert.equal((await other.snapshot()).backup.records.length,1);
});

test('legacy 401, 403, 405, 501 and 503 are not empty migrations and cannot overwrite absent native heads',async t=>{
    for(const legacyStatus of [401,403,405,501,503]){
        const f=fixture(t,{legacyStatus}),session=await f.open();
        await assert.rejects(session.list(),error=>String(error.code).startsWith('text_collection_sync_'));
        assert.equal(f.uploads,0,`HTTP ${legacyStatus} must not initialize an empty replacement`);assert.equal(f.files.size,0);session.close();
    }
});

test('legacy records migrate intact through the real HTTP reader and account changes prevent new writes',async t=>{
    const original=record(),backup={type:'qianmu-text-collections',version:1,sourceAccount:account,exportedAt:20,libraryRevision:1,records:[original]};
    const f=fixture(t,{legacySnapshot:backup}),session=await f.open();assert.deepEqual((await session.get(original.id)).record,original);
    assert.deepEqual((await session.snapshot()).backup.records,[original]);assert.equal(f.calls.filter(call=>call.path.includes('/api/plugins/')).length,1);
    const operation=session.prepareEdit(original.id,1,'不得写给另一账户'),before=f.uploads;f.setAccount('st-user:someone-else');
    await assert.rejects(operation.submit(),{code:'text_collection_sync_account'});assert.equal(f.uploads,before);
    assert.ok([...f.files.values()].some(body=>body.includes('厨房的一刻')));assert.ok([...f.files.values()].every(body=>!body.includes('不得写给另一账户')));
});

const entry=record=>({id:record.id,revision:record.revision,updatedAt:record.updatedAt,deleted:false,record});
async function originalStore(t){
    const f=fixture(t),storage=await createConfiguredStAccountStorage();t.after(()=>storage.close());
    return {...f,storage,originals:createTextCollectionOriginalStore({storage,expectedAccount:account})};
}

test('complete collection original and lightweight descriptor use actual native HTTP storage without migrating the library',async t=>{
    const f=await originalStore(t),original=entry(record('collection-long','原文😀\r\n'.repeat(26000))),saved=await f.originals.preserve(original);
    assert.equal(f.files.size,1);assert.equal(f.calls.filter(call=>call.path==='/api/files/upload').length,1);
    assert.equal(f.calls.some(call=>call.path.includes('/api/plugins/')),false);
    assert.ok(JSON.stringify(saved).length<1200);assert.equal(Object.hasOwn(saved,'record'),false);assert.equal(Object.hasOwn(saved,'text'),false);
    assert.equal(saved.textBytes,Buffer.byteLength(original.record.text));assert.equal(saved.summary.charName,'当时 CHAR');
    f.storage.close();const other=await createConfiguredStAccountStorage();t.after(()=>other.close());
    const independent=createTextCollectionOriginalStore({storage:other,expectedAccount:account}),count=f.calls.length;
    assert.deepEqual(await independent.read(saved),original);assert.equal(f.calls.length,count+1);assert.equal((await other.read('collections')).exists,false);
});

test('an original descriptor retains restored ownership separately from the captured source account',async t=>{
    const f=await originalStore(t),old=record(),foreign={...old,source:{...old.source,account:'st-user:'+'f'.repeat(64)}};
    const restored=entry(restoreTextCollectionCopy(foreign,{id:'restored-copy',ownerAccount:account,restoredAt:20})),saved=await f.originals.preserve(restored);
    assert.deepEqual(await f.originals.read(saved),restored);assert.equal(saved.summary.charName,old.source.charName);
    assert.equal((await f.originals.read(saved)).record.source.account,foreign.source.account);
});

test('single collection original preservation leaves the existing library and all original bodies untouched',async t=>{
    const f=await originalStore(t),session=await f.open(),old=record();await session.prepareCreate(old).submit();
    const library=await f.storage.read('collections'),before=new Map(f.files),saved=await f.originals.preserve(entry(old));
    for(const [name,body]of before)assert.equal(f.files.get(name),body);
    assert.deepEqual(await f.storage.read('collections'),library);assert.deepEqual((await session.get(old.id)).record,old);
    assert.deepEqual(await f.originals.read(saved),entry(old));
});

test('collection descriptors reject modified preview, names, date, body length and id when reading the exact original',async t=>{
    const f=await originalStore(t),saved=await f.originals.preserve(entry(record()));
    for(const change of [v=>v.summary.preview='wrong preview',v=>v.summary.charName='wrong person',v=>v.summary.createdAt--,
      v=>v.recordBytes++,v=>v.textBytes++,v=>{v.id=v.summary.id='different-id';}]){
      const changed=structuredClone(saved);change(changed);await assert.rejects(f.originals.read(changed),{code:'text_collection_sync_original'});
    }
    const shuffled=structuredClone(saved);shuffled.summary=Object.fromEntries(Object.entries(shuffled.summary).reverse());
    assert.deepEqual(await f.originals.read(shuffled),entry(record()),'JSON key ordering is not a content change');
});

test('invalid originals, tombstones and mismatched account data are rejected before any upload',async t=>{
    const f=await originalStore(t),good=entry(record());
    for(const bad of [{...good,deleted:true,revision:2,record:null},{...good,extra:true},
      {...good,record:{...good.record,future:'not recognized by the existing record contract'}},
      {...good,record:{...good.record,source:{...good.record.source,account:'st-user:'+'f'.repeat(64)}}}]){
      const count=f.calls.length;await assert.rejects(f.originals.preserve(bad));assert.equal(f.calls.length,count);
    }assert.equal(f.files.size,0);
});

test('invalid collection references cannot read other document slots or foreign account versions',async t=>{
    const f=await originalStore(t),saved=await f.originals.preserve(entry(record()));
    for(const change of [v=>v.original.slot='notes',v=>v.original.scope='f'.repeat(64),v=>v.original.bytes=0,v=>v.extra=true]){
      const bad=structuredClone(saved);change(bad);const count=f.calls.length;await assert.rejects(f.originals.read(bad));assert.equal(f.calls.length,count);
    }
    assert.deepEqual(textCollectionOriginalDescriptor(saved,{expectedAccount:account,scope:f.storage.scope}),saved);
});

test('verified native bodies still require collection-envelope account, entry and version matching',async t=>{
    const f=await originalStore(t),original=entry(record()),saved=await f.originals.preserve(original);
    for(const value of [{version:2,expectedAccount:account,entry:original},{version:1,expectedAccount:'st-user:'+'f'.repeat(64),entry:original},
      {version:1,expectedAccount:account,entry:original,extra:'unrecognized'}]){
      const receipt=await f.storage.preserveImmutable('collection-record',value);
      await assert.rejects(f.originals.read({...saved,original:receipt.reference}),{code:'text_collection_sync_original'});
    }
});

test('collection original persistence cannot accept a receipt for a different complete record',async t=>{
    const f=await originalStore(t),other=await f.storage.preserveImmutable('collection-record',{version:1,expectedAccount:account,entry:entry(record('other-record','different'))});
    const mismatched=createTextCollectionOriginalStore({storage:{scope:f.storage.scope,preserveImmutable:async()=>other,readImmutable:async()=>other},expectedAccount:account});
    await assert.rejects(mismatched.preserve(entry(record())),{code:'text_collection_sync_original'});
});

test('deleted originals and account switches remain errors rather than empty collection content',async t=>{
    const f=await originalStore(t),saved=await f.originals.preserve(entry(record())),name=[...f.files.keys()][0];
    f.files.delete(name);await assert.rejects(f.originals.read(saved),{code:'st_account_storage_missing'});assert.equal(f.files.size,0);
    f.setAccount('st-user:other-account');const count=f.calls.length;
    await assert.rejects(f.originals.preserve(entry(record())),{code:'st_account_storage_account'});assert.equal(f.calls.length,count);
});
