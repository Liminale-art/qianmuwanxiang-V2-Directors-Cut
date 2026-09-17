import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { buildOriginalImageZip as zip, ORIGINAL_IMAGE_EXPORT_BYTES } from '../qianmu-original-image-zip.js';
import { exportGalleryOriginals as run } from '../qianmu-gallery-original-export.js';
import { galleryDirectoryTarget } from '../qianmu-gallery-directory.js';

export async function readStoredZip(blob) {
    const data = Buffer.from(await blob.arrayBuffer()), result = new Map(); let at = 0;
    while (data.readUInt32LE(at) === 0x04034b50) {
        assert.equal(data.readUInt16LE(at + 6), 0x800); assert.equal(data.readUInt16LE(at + 8), 0);
        const size = data.readUInt32LE(at + 18), nameSize = data.readUInt16LE(at + 26), extra = data.readUInt16LE(at + 28);
        assert.equal(size, data.readUInt32LE(at + 22)); const name = data.subarray(at + 30, at + 30 + nameSize).toString('utf8');
        const start = at + 30 + nameSize + extra, bytes = data.subarray(start, start + size);
        assert.equal(crc32(bytes), data.readUInt32LE(at + 14)); assert.ok(!result.has(name)); result.set(name, bytes);
        at = start + size;
    }
    const centralStart = at;
    for (const [name, bytes] of result) {
        assert.equal(data.readUInt32LE(at), 0x02014b50); const n = data.readUInt16LE(at + 28), extra = data.readUInt16LE(at + 30), comment = data.readUInt16LE(at + 32);
        assert.equal(data.subarray(at + 46, at + 46 + n).toString('utf8'), name); assert.equal(data.readUInt32LE(at + 16), crc32(bytes));
        assert.equal(data.readUInt32LE(data.readUInt32LE(at + 42)), 0x04034b50); at += 46 + n + extra + comment;
    }
    assert.equal(data.readUInt32LE(at), 0x06054b50); assert.equal(data.readUInt16LE(at + 10), result.size);
    assert.equal(data.readUInt32LE(at + 12), at - centralStart); assert.equal(data.readUInt32LE(at + 16), centralStart); assert.equal(data.length, at + 22);
    return result;
}
test('stored ZIP has consistent standard headers, offsets and independent native CRC32 with byte-exact files', async () => {
    const entries = [{ name: 'source.json', blob: new Blob(['{"scope":"仅所选原图"}']) }, { name: 'images/001.png', blob: new Blob(['123456789']) }, { name: 'README.txt', blob: new Blob(['说明']) }];
    const blob = await zip(entries), files = await readStoredZip(blob);
    assert.equal(files.get('images/001.png').toString(), '123456789'); assert.equal(crc32(files.get('images/001.png')), 0xcbf43926);
    if (process.platform === 'win32') {
        // Windows bsdtar needs a seekable ZIP input; a stdin pipe can report a null error.
        const directory = mkdtempSync(join(tmpdir(), 'qianmu-zip-test-')), file = join(directory, 'originals.zip');
        try {
            writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
            assert.deepEqual(execFileSync('tar.exe', ['-tf', file], { encoding: 'utf8' }).trim().split(/\r?\n/), entries.map(row => row.name));
            assert.deepEqual(execFileSync('tar.exe', ['-xOf', file, 'images/001.png']), files.get('images/001.png'));
        } finally { rmSync(directory, { recursive: true, force: true }); }
    }
});
test('ZIP rejects arbitrary paths, duplicate names, holes and oversized aggregates before reading data', async () => {
    const row = { name: 'source.json', blob: new Blob(['x']) };
    for (const entries of [[], new Array(1), [row,row], [{...row,name:'../secret'}], [{...row,name:'/source.json'}], [{...row,name:'payload.js'}], Array(103).fill(row)]) await assert.rejects(zip(entries));
    class Oversized extends Blob { get size() { return ORIGINAL_IMAGE_EXPORT_BYTES; } slice() { assert.fail('read before bounds'); } }
    await assert.rejects(zip([{name:'source.json',blob:new Oversized(['x'])}]), /128 MiB/);
});
test('ZIP checksum processing yields between bounded chunks and honors cancellation', async () => {
    let turns = 0, cancelled = false;
    const blob = new Blob([new Uint8Array(1100000)]);
    await zip([{name:'images/001.png',blob}], {yieldTask: async()=>{turns++;}}); assert.equal(turns, 3);
    await assert.rejects(zip([{name:'images/001.png',blob}], {guard:async()=>{if(cancelled)throw Error('cancelled');},yieldTask:async()=>{cancelled=true;}}), /cancelled/);
});

function fixture(extra = {}) {
    const namespace = 'st-user:fixture', source = {ownerKey:'char:角色.png',chatKey:'同名聊天'}, rows = [1,2].map(n=>({namespace,...source,recordId:`id${n}`,createdAt:n,kind:'still',tags:['标签']}));
    let inspected = 0, loaded = 0, closed = 0;
    const seen = [], saved = [], progress = [], frames = rows.map(row=>({id:row.recordId,createdAt:row.createdAt,tags:row.tags,url:`/user/images/${row.recordId}.png`,prompt:'DO_NOT_EXPORT',apiKey:'DO_NOT_EXPORT'}));
    const options = {namespace,rows,target:galleryDirectoryTarget,headers:()=>({}),guard:async()=>{},onProgress:value=>progress.push(value),
        createHistoricalClient: opts=>({async inspect(){assert.deepEqual(opts.target,{kind:'character',avatar:'角色.png',chatId:'同名聊天'});inspected++;return {state:'present',gallery:{sha256:'a'.repeat(64)}};},close(){closed++;}}),
        createRecordClient:()=>({async read(selection){seen.push(selection);return {record:frames.find(row=>row.id===selection.recordId)};},close(){closed++;}}),
        loadImage:async url=>{loaded++;return {blob:new Blob([url+' ORIGINAL BYTES'],{type:'image/png'})};},save:(blob,name)=>saved.push({blob,name}),...extra};
    return {namespace,source,rows,frames,options,seen,saved,progress,get inspected(){return inspected;},get loaded(){return loaded;},get closed(){return closed;}};
}
test('selected historical originals form one readable ZIP with accurate source manifest, not current-chat configuration', async()=>{
    const f=fixture(), before=structuredClone(f.rows), result=await run(f.options);assert.equal(result.count,2);assert.equal(f.saved.length,1);assert.equal(f.loaded,2);assert.equal(f.inspected,2);assert.equal(f.closed,2);
    const files=await readStoredZip(f.saved[0].blob), manifest=JSON.parse(files.get('source.json'));
    assert.equal(manifest.scope,'selected-catalog-stills');assert.deepEqual(manifest.source,f.source);assert.deepEqual(manifest.images.map(row=>row.recordId),['id1','id2']);
    assert.doesNotMatch(files.get('source.json').toString(), /DO_NOT_EXPORT|url|apiKey|prompt|st-user/);
    assert.equal(files.get('images/001.png').toString(),'/user/images/id1.png ORIGINAL BYTES');assert.equal(files.get('images/002.png').toString(),'/user/images/id2.png ORIGINAL BYTES');
    assert.match(files.get('README.txt').toString(),/非全部聊天备份/);assert.match(f.saved[0].name,/^qianmu-originals-selected-2-[0-9]+\.zip$/);
    assert.deepEqual(f.rows,before);assert.deepEqual(f.progress.map(value=>value.phase),['reading','reading','packing']);assert.ok(f.seen.every(value=>value.gallerySha256==='a'.repeat(64)));
});
test('foreign account, mixed source, duplicate, motion and accidental empty selections are refused before source reads',async()=>{
    const f=fixture();for(const rows of [[],new Array(1),[f.rows[0],f.rows[0]],[{...f.rows[0],namespace:'st-user:other'}],[{...f.rows[0],kind:'motion'}],[f.rows[0],{...f.rows[1],ownerKey:'char:other.png'}],[f.rows[0],{...f.rows[1],chatKey:'other'}],Array(101).fill(f.rows[0])])await assert.rejects(run({...f.options,rows}));
    assert.equal(f.loaded,0);assert.equal(f.inspected,0);assert.equal(f.saved.length,0);
});
test('missing selected record/image or changed final gallery aborts the entire archive without a partial download',async()=>{
    for(const mode of ['missing-record','missing-image','changed-final','wrong-record']){
        const f=fixture();let reads=0,inspects=0;
        if(mode==='missing-record'||mode==='wrong-record')f.options.createRecordClient=()=>({read:async()=>{if(mode==='missing-record')throw Error('missing record');return {record:f.frames[1]};},close(){}});
        if(mode==='missing-image')f.options.loadImage=async()=>{if(++reads===2)throw Error('missing image');return {blob:new Blob(['first'],{type:'image/png'})};};
        if(mode==='changed-final')f.options.createHistoricalClient=()=>({inspect:async()=>({state:'present',gallery:{sha256:(++inspects===1?'a':'b').repeat(64)}}),close(){}});
        await assert.rejects(run(f.options));assert.equal(f.saved.length,0);
    }
});
test('original-media aggregate limit fails rather than truncating images or manufacturing a smaller complete package',async()=>{
    class Large extends Blob {get size(){return 24*1048576;}}
    const f=fixture();f.options.rows=Array.from({length:6},(_,n)=>({...f.rows[0],recordId:`id${n}`,createdAt:n}));
    f.options.createRecordClient=()=>({read:async selection=>({record:{id:selection.recordId,createdAt:selection.createdAt,url:'/user/images/a.png',tags:[]}}),close(){}});
    f.options.loadImage=async()=>({blob:new Large(['x'],{type:'image/png'})});
    await assert.rejects(run(f.options),/128 MiB/);assert.equal(f.saved.length,0);
});
test('user cancellation, parent close and overall timeout end promptly and suppress late non-abortable media responses',async()=>{
    for(const reason of ['user','parent','timeout']){
        let started,release;const ready=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve),controller=new AbortController();
        const f=fixture({loadImage:async()=>{started();await gate;return {blob:new Blob(['late'],{type:'image/png'})};},timeoutMs:reason==='timeout'?100:10000,...(reason==='parent'?{parentSignal:controller.signal}:{signal:controller.signal})});
        const pending=run(f.options);await ready;if(reason!=='timeout')controller.abort();await assert.rejects(pending,/取消|超时/);release();await new Promise(resolve=>setTimeout(resolve,10));
        assert.equal(f.saved.length,0);assert.equal(f.closed,2);
    }
});
test('account failure and browser handoff failure are not reported as successful exports',async()=>{
    let checks=0;const f=fixture({guard:async()=>{if(++checks>4)throw Error('account changed');}});await assert.rejects(run(f.options),/account changed/);assert.equal(f.saved.length,0);
    const blocked=fixture({save:()=>{throw Error('blocked');}});await assert.rejects(run(blocked.options),/blocked/);assert.equal(blocked.closed,2);
});
