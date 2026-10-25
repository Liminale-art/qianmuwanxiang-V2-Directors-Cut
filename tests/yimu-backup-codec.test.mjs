import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';
import {encodeBackup, decodeBackup, BACKUP_LIMITS} from '../yimu/backup-codec.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const collect = async stream => {const chunks=[]; for await(const chunk of stream)chunks.push(chunk);return Buffer.concat(chunks);};
const header = (files=[]) => ({format:'yimu-backup',version:1,document:{entries:[]},sources:files.length
    ?files.map((bytes,i)=>({id:`source_${i}`,attached:true,bytes:bytes.length,sha256:hash(bytes)}))
    :[{id:'source_0',attached:false}]});
const encode = (files=[], meta=header(files)) => collect(encodeBackup({header:meta,sources:files.map((bytes,i)=>({id:`source_${i}`,stream:[bytes]}))}));
const mutate = async (fn, files=[Buffer.from('原文\n')]) => {
    const bytes=await encode(files), frames=gunzipSync(bytes).toString('utf8').trimEnd().split('\n').map(JSON.parse);
    fn(frames);return gzipSync(frames.map(frame=>JSON.stringify(frame)).join('\n')+'\n');
};
const reject = input => assert.rejects(decodeBackup([input]), error=>error.code==='yimu_backup_format');

test('memory-only own package is compressed and complete without reading originals',async()=>{
    const bytes=await encode(), calls=[];
    const result=await decodeBackup([bytes],{onHeader:h=>calls.push(h),onFileStart:()=>assert.fail('no originals')});
    assert.deepEqual(result.header,header());assert.equal(calls.length,1);assert.deepEqual(result.sourceReceipts,[]);
    assert.equal(result.compressedBytes,bytes.length);assert.ok(result.expandedBytes>0);
    assert.match(result.packageDigest,/^[a-f0-9]{64}$/);
});
test('bounded chunks keep originals byte-identical, including UTF-8, CRLF and empty files',async()=>{
    const files=[Buffer.from('{"name":"秦铎"}\r\n{"mes":"正文😀"}\r\n'),Buffer.alloc(0),Buffer.alloc(BACKUP_LIMITS.chunkBytes*4+17,111)];
    const bytes=await encode(files), output=new Map(), order=[];
    async function* network(){for(let i=0;i<bytes.length;i+=7)yield bytes.subarray(i,i+7);}
    const result=await decodeBackup(network(),{
        onFileStart:id=>{order.push(id);output.set(id,[]);},
        async onFileChunk(id,data){assert.ok(data.length<=BACKUP_LIMITS.chunkBytes);await Promise.resolve();output.get(id).push(data);},
        onFileEnd:item=>assert.equal(item.sha256,hash(Buffer.concat(output.get(item.id)))),
    });
    assert.deepEqual(order,['source_0','source_1','source_2']);
    files.forEach((file,i)=>assert.deepEqual(Buffer.concat(output.get(`source_${i}`)),file));
    assert.equal(result.sourceReceipts.length,3);
});
test('package digest is independent of gzip recompression, but binds the manifest',async()=>{
    const bytes=await encode([Buffer.from('abc')]);
    assert.equal((await decodeBackup([bytes])).packageDigest,(await decodeBackup([gzipSync(gunzipSync(bytes),{level:1})])).packageDigest);
});
test('export stops if an original changes or selected sources are absent/out of order',async()=>{
    await assert.rejects(encode([Buffer.from('changed')],header([Buffer.from('original')])));
    await assert.rejects(collect(encodeBackup({header:header([Buffer.from('missing')]),sources:[]})));
    await assert.rejects(collect(encodeBackup({header:header([Buffer.from('a')]),sources:[{id:'source_8',stream:[Buffer.from('a')]}]})));
});
test('foreign formats, malformed gzip, truncated body and corrupt gzip trailer are rejected',async()=>{
    await reject(Buffer.from('PK third-party zip'));
    await reject(gzipSync('{"format":"other"}\n'));
    const bytes=await encode([Buffer.from('abc')]);await reject(bytes.subarray(0,bytes.length-5));
    const corrupted=Buffer.from(bytes);corrupted[corrupted.length-5]^=1;await reject(corrupted);
    await reject(await mutate(frames=>{frames[0].header.version=99;}));
});
test('strict frame validation rejects gaps, duplication, extra keys and noncanonical base64',async()=>{
    for(const change of [
        frames=>{frames[1].offset=1;},
        frames=>frames.splice(2,0,frames[1]),
        frames=>{frames[1].path='../outside';},
        frames=>{frames[1].id='../../outside';},
        frames=>{frames[1].data='YQ=';},
        frames=>{frames[1].data='YR==';},
        frames=>{frames[1].data='';},
        frames=>{frames[2].bytes++;},
        frames=>{frames[2].sha256='f'.repeat(64);},
        frames=>{frames[3].files=[];},
        frames=>{frames[3].headerSha256='f'.repeat(64);},
        frames=>frames.pop(),
        frames=>frames.push({type:'end'}),
    ])await reject(await mutate(change));
});
test('bad source manifest rejects duplicates, undeclared files and missing selected files',async()=>{
    for(const change of [
        frames=>frames[0].header.sources.push(frames[0].header.sources[0]),
        frames=>{frames[0].header.sources[0].attached=false;},
        frames=>frames.splice(1,2),
        frames=>{frames[0].header.sources[0].attached='true';},
    ])await reject(await mutate(change));
});

test('a dishonest declared source size is rejected before exposing the excess block to staging',async()=>{
    const bytes=await mutate(frames=>{frames[0].header.sources[0].bytes=1;},[Buffer.alloc(BACKUP_LIMITS.chunkBytes,111)]);
    let staged=0,ended=false;
    await assert.rejects(decodeBackup([bytes],{onFileChunk:(_id,data)=>{staged+=data.length;},onFileEnd:()=>{ended=true;}}),/声明大小/);
    assert.equal(staged,0);assert.equal(ended,false);
    await assert.rejects(encode([Buffer.alloc(BACKUP_LIMITS.chunkBytes)],header([Buffer.from('x')])),/已变大/);
});

test('own-format records reject duplicate keys and alternate ambiguous JSON encodings',async()=>{
    const bytes=await encode(),lines=gunzipSync(bytes).toString('utf8').split('\n');
    for(const first of [lines[0].replace('"type":"header"','"type":"other","type":"header"'),
        ' '+lines[0],lines[0].replace('"version":1','"version":1.0')]){
        await reject(gzipSync([first,...lines.slice(1)].join('\n')));
    }
});
test('requires newline termination and rejects trailing plaintext or extra gzip members',async()=>{
    const bytes=await encode();await reject(gzipSync(gunzipSync(bytes).subarray(0,-1)));
    await reject(Buffer.concat([bytes,Buffer.from('not-gzip')]));
    await reject(Buffer.concat([bytes,gzipSync('{}\n')]));
});
test('header validation runs before storage hooks; hook failure aborts package with its factual error',async()=>{
    const bytes=await encode([Buffer.from('abc')]);let written=false;
    const bad=Object.assign(new Error('wrong schema'),{status:400});
    await assert.rejects(decodeBackup([bytes],{validateHeader:()=>{throw bad;},onHeader:()=>{written=true;}}),error=>error===bad);
    assert.equal(written,false);
    const disk=Object.assign(new Error('disk full'),{status:507});
    await assert.rejects(decodeBackup([bytes],{onFileChunk:()=>{throw disk;}}),error=>error===disk);
});

test('complete file callbacks are provisional until the final gzip trailer is checked',async()=>{
    const bytes=await encode([Buffer.alloc(BACKUP_LIMITS.chunkBytes*3,111)]),trailer=Buffer.from(bytes.subarray(-8));trailer[0]^=1;
    let filesEnded=0,finished=false;
    async function* delayedCorruption(){
        yield bytes.subarray(0,-8);
        for(let turn=0;turn<8;turn++)await new Promise(resolve=>setImmediate(resolve));
        yield trailer;
    }
    await assert.rejects(decodeBackup(delayedCorruption(),{onFileEnd:()=>{filesEnded++;}}).then(result=>{finished=true;return result;}),/损坏|中断/);
    assert.equal(filesEnded,1,'a staging file can finish before envelope verification');
    assert.equal(finished,false,'only decode success is completion proof');
});

test('statusless trusted I/O failures are preserved rather than reclassified as an invalid package',async()=>{
    const bytes=await encode([Buffer.from('abc')]);
    for(const hook of ['validateHeader','onHeader','onFileStart','onFileChunk','onFileEnd']){
        const error=Object.assign(new Error('synthetic disk unavailable'),{code:'ENOSPC'});
        await assert.rejects(decodeBackup([bytes],{[hook]:()=>{throw error;}}),caught=>caught===error,hook);
    }
});

test('incoming transport failures retain their identity so a valid interrupted upload may be retried',async()=>{
    const bytes=await encode([Buffer.alloc(BACKUP_LIMITS.chunkBytes*3,111)]);
    const error=Object.assign(new Error('synthetic connection lost'),{code:'ECONNRESET'});
    async function* network(){yield bytes.subarray(0,-8);throw error;}
    await assert.rejects(decodeBackup(network()),caught=>caught===error);
});
