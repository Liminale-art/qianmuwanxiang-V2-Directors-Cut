import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {configureStAccountStorage} from '../qianmu-st-account-storage.js';
import {createTextCollectionSession} from '../qianmu-text-collection-session.js';
import {createTextCollection} from '../qianmu-text-collection.js';

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

test('configured real session uses native ST files without an installed backend and new clients can read, edit and delete',async t=>{
    const f=fixture(t),first=await f.open();assert.equal(first.expectedAccount,account);
    assert.equal((await first.list()).total,0,'legacy 404 is not an installation requirement');
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
