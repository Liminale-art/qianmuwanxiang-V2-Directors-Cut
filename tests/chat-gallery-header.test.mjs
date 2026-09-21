import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createChatGalleryHeaderCapture,CHAT_GALLERY_HEADER_LIMITS as LIMIT} from '../qianmu-chat-gallery-header.js';
import {createChatCharacterReceiptService} from '../qianmu-chat-character-receipt-service.js';
import {chatGalleryReceiptText,CHAT_GALLERY_RECEIPT_LIMITS} from '../qianmu-chat-gallery-receipt.js';
import {recipeClientFixture} from './helpers/recipe-client-fixture.mjs';

const hash=text=>createHash('sha256').update(text).digest('hex');
const rows=()=>[{id:'image',createdAt:1,url:'/user/images/example.png',future:{z:[null,false,0,-1.2e3,'汉字🌙\\"\r\n'],a:{}}}];
const header=records=>({chat_metadata:{story_director_liminale:{storyboardImages:records},other:{keep:'not returned'}}});
const wanted=records=>{const {text,...summary}=chatGalleryReceiptText(records);return {...summary,sha256:hash(text)};};
const input=()=>({version:1,expectedAccount:'st-user:'+hash('alice'),target:{kind:'character',avatar:'Alice.png',chatId:'chat'}});
function parse(text,size=17,options={}){
  const capture=createChatGalleryHeaderCapture(options);
  for(let at=0;at<text.length;at+=size)capture.write(text.slice(at,at+size));
  return capture.finish();
}
const rejects=(task,code='content')=>assert.rejects(task,{code:'chat_character_receipt_'+code});

test('streamed gallery preserves exact legacy sorted-key SHA256 and excludes unrelated metadata',()=>{
  const records=rows(),text=JSON.stringify(header(records));
  for(const size of [1,2,3,7,16,127,16384]){
    assert.deepEqual(parse(text,size),{gallery:wanted(records),records:[]});
    assert.deepEqual(parse(text,size,{recordId:'image'}),{gallery:wanted(records),records});
  }
  assert.deepEqual(parse('\uFEFF'+text+'\r'),{gallery:wanted(records),records:[]});
});

test('unknown nested fields, JSON escapes and whitespace do not drift from the old canonicalizer',()=>{
  // Deterministic generated JSON, with reordered properties and awkward chunk boundaries.
  for(let i=0;i<100;i++){
    const records=Array.from({length:i%7},(_,j)=>({id:'r'+j,createdAt:j,unknown:{
      escaped:'\\"\b\f\n\r\t\u0000🌙\ud800',number:(i-50)/7,boolean:i%2===0,array:[{},[],null,{b:j,a:'字'.repeat(i)}]}}));
    const value=header(records);value['chat_metadata'].other=[true,false,null,1e-5];
    assert.deepEqual(parse(JSON.stringify(value,null,i%3),1+i%31).gallery,wanted(records));
  }
  const text='{"chat_metadata":{"story_director_liminale":{"storyboardImages":[{"id":"im\\u0061ge","n":-0,"x":1E+02,"s":"\\/"}]}}}';
  assert.deepEqual(parse(text,1).gallery,wanted(JSON.parse(text).chat_metadata.story_director_liminale.storyboardImages));
});

test('absent and empty galleries remain distinct; a field with the same name at another path is ignored',()=>{
  for(const value of [{chat_metadata:{}},{chat_metadata:{story_director_liminale:{}}},{storyboardImages:rows(),chat_metadata:{other:{storyboardImages:rows()}}}])
    assert.deepEqual(parse(JSON.stringify(value)),{gallery:null,records:[]});
  assert.deepEqual(parse(JSON.stringify(header([]))),{gallery:wanted([]),records:[]});
});

test('every incomplete prefix and malformed trailing JSON fail even after a complete selected record',()=>{
  const text=JSON.stringify(header(rows()));
  for(let end=0;end<text.length;end++)assert.throws(()=>parse(text.slice(0,end),3),{code:'chat_character_receipt_content'});
  for(const suffix of ['x','{}',',','null','\uFEFF'])assert.throws(()=>parse(text+suffix),{code:'chat_character_receipt_content'});
  const brokenTail=text.slice(0,-1)+',"other":[true,]}';assert.throws(()=>parse(brokenTail,1,{recordId:'image'}));
});

test('skipped values still obey JSON grammar, including keys, commas, numbers, literals and escapes',()=>{
  const bad=['','undefined','01','+1','-.1','1.','1e','1e999','NaN','tru','truex','nul','"bad\\x"','"bad\n"',
    '[,]','[1,]','[1 2]','{"a":}','{"a":1,}','{"a" 1}','{a:1}','{"a":1 "b":2}','[}',']','"unterminated'];
  for(const raw of bad)assert.throws(()=>parse('{"chat_metadata":{},"skipped":'+raw+'}',2),undefined,raw);
  for(const raw of ['true','false','null','0','-0','-0.5','1e-8','1E+02','"\\u0061"','"\\b\\f\\r\\n\\t\\/\\\\\\\""','[]','{}'])
    assert.equal(parse('{"chat_metadata":{},"skipped":'+raw+'}',1).gallery,null,raw);
});

test('duplicate and escaped-equivalent keys cannot redirect the selected source or hide malformed tails',()=>{
  for(const raw of [
    '{"chat_metadata":{},"chat_metadata":{}}',
    '{"chat_metadata":{},"chat_metad\\u0061ta":{}}',
    '{"chat_metadata":{},"skipped":{"a":1,"a":2}}',
    '{"chat_metadata":{"story_director_liminale":{"storyboardImages":[],"storyboardImages":[]}}}',
    '{"chat_metadata":{"story_director_liminale":{"storyboardImages":[{"id":"a","id":"b"}]}}}',
  ])assert.throws(()=>parse(raw,1),/重复字段/);
});

test('required containers cannot be scalars and a body record cannot masquerade as the header',()=>{
  for(const value of [null,[],1,{}, {chat_metadata:null},{chat_metadata:[]},{chat_metadata:{},mes:'body'},
    {chat_metadata:{story_director_liminale:null}},{chat_metadata:{story_director_liminale:[]}},header(null),header({}),header([null]),header([[]]),header([1])])
    assert.throws(()=>parse(JSON.stringify(value)));
});

test('selection retains only requested records and detects duplicates rather than picking a winner',()=>{
  const records=Array.from({length:100},(_,i)=>({id:i%4===0?'same':'r'+i,createdAt:i,unknown:{keep:true}}));
  const result=parse(JSON.stringify(header(records)),33,{recordId:'same'});
  assert.deepEqual(result.gallery,wanted(records));assert.deepEqual(result.records,records.filter(row=>row.id==='same').slice(0,2));
  assert.equal(parse(JSON.stringify(header(records)),5,{recordId:'missing'}).records.length,0);
});

test('existing gallery bytes, records and structural budgets remain enforced without truncation',()=>{
  for(const records of [[{large:'字'.repeat(CHAT_GALLERY_RECEIPT_LIMITS.bytes/3)}],Array.from({length:10001},()=>({})),
    [{a:Array.from({length:CHAT_GALLERY_RECEIPT_LIMITS.nodes},()=>0)}]])assert.throws(()=>parse(JSON.stringify(header(records)),16384));
  const text=JSON.stringify(header(Array.from({length:400},(_,i)=>({id:'r'+i,text:'x'.repeat(6000)}))));
  assert.ok(parse(text,16384).gallery.bytes>CHAT_GALLERY_RECEIPT_LIMITS.bytes);
});

test('skipped fields have independent depth, node, key and scalar limits',()=>{
  for(const raw of ['['.repeat(LIMIT.depth+1)+'0'+']'.repeat(LIMIT.depth+1),
    '{"'+'a'.repeat(LIMIT.keyLength)+'":1}', '1'.repeat(LIMIT.numberCharacters+1),
    '['+'0,'.repeat(LIMIT.nodes)+'0]'])assert.throws(()=>parse('{"chat_metadata":{},"skip":'+raw+'}',16384));
});

test('capture is single-use and a failed write cannot later return a partial receipt',()=>{
  const a=createChatGalleryHeaderCapture();a.write(JSON.stringify(header(rows())));a.finish();assert.throws(()=>a.finish());assert.throws(()=>a.write(' '));
  const b=createChatGalleryHeaderCapture();assert.throws(()=>b.write('{"chat_metadata":{},"x":!'));assert.throws(()=>b.finish());
  let allowed=true;const c=createChatGalleryHeaderCapture({guard:()=>{if(!allowed)throw Error('cancel');}});c.write('{');allowed=false;assert.throws(()=>c.write('}'),/cancel/);
});

async function serviceFixture(t,io=fs){
  const f=await recipeClientFixture(t),service=createChatCharacterReceiptService({dataRoot:f.root,io});
  t.after(()=>service.close());return {...f,receipt:service};
}

test('actual saved header over 2 MiB verifies without scanning or returning the body; character boundary is unchanged',async t=>{
  let reads=0,maxRead=0,total=0;const io={...fs,open:async(...args)=>{const file=await fs.open(...args);return {
    stat:(...a)=>file.stat(...a),close:()=>file.close(),read:async(...a)=>{maxRead=Math.max(maxRead,a[2]);reads++;const result=await file.read(...a);total+=result.bytesRead;return result;},
  };}};
  const f=await serviceFixture(t,io),value=header(rows());value.chat_metadata.padding='字'.repeat(800000);
  const text=JSON.stringify(value),body='body must not be parsed'.repeat(100000);
  await fs.writeFile(f.file,'\uFEFF'+text+'\r\n'+body);const before=hash(await fs.readFile(f.file));
  const result=await f.receipt.inspectGallery(f.req,input());assert.deepEqual(result.gallery,wanted(rows()));
  assert.ok(reads>1);assert.ok(maxRead<=16384);assert.ok(total<=Buffer.byteLength(text)+16384+4);
  assert.doesNotMatch(JSON.stringify(result),/padding|prompt|url|other|字/);
  assert.equal(hash(await fs.readFile(f.file)),before);
  await rejects(f.receipt.inspect(f.req,input()),'size');
});

test('large skipped metadata does not block selected record, details or exact original recipe',async t=>{
  const f=await serviceFixture(t);f.context.chatMetadata.padding='x'.repeat(3*1024*1024);await f.save();
  const selection={recordId:'image',createdAt:1,gallerySha256:wanted(f.rows).sha256},request={...input(),selection};
  assert.equal((await f.receipt.readGalleryRecord(f.req,request)).record.id,'image');
  assert.equal((await f.receipt.readGalleryDetails(f.req,request)).record.id,'image');
  const original=await f.receipt.readGalleryRecipeSource(f.req,request);assert.deepEqual(original.snapshot,f.rows[0].snapshot);
  const client=f.client();t.after(()=>client.close());const preserved=await client.preserve(f.rows[0]);assert.equal(preserved.proof,'durable-recipe');
  assert.deepEqual((await client.read(f.rows[0])).snapshot,f.rows[0].snapshot);
});

test('malformed skipped tail, duplicate source key, invalid UTF8 and partial final multibyte all reject on disk',async t=>{
  const f=await serviceFixture(t),text=JSON.stringify(header(rows()));
  for(const content of [Buffer.from(text.slice(0,-1)+',"x":[1,]}\n'),Buffer.from(text.slice(0,-1)+',"chat_metadata":{}}\n'),
    Buffer.concat([Buffer.from(text.slice(0,-1)+',"skip":"'),Buffer.from([0xff]),Buffer.from('"}\n')]),
    Buffer.concat([Buffer.from(text),Buffer.from([0xe4,0xb8])])]){
    await fs.writeFile(f.file,content);await rejects(f.receipt.inspectGallery(f.req,input()));assert.deepEqual(await fs.readFile(f.file),content);
  }
});

test('header-only files and CRLF are accepted, second-line malformed bodies remain uninspected',async t=>{
  const f=await serviceFixture(t),text=JSON.stringify(header(rows()));
  for(const suffix of ['','\r','\nnot JSON','\r\n{broken body']){
    await fs.writeFile(f.file,text+suffix);assert.deepEqual((await f.receipt.inspectGallery(f.req,input())).gallery,wanted(rows()));
  }
});

test('account switch, cancellation, file replacement and same-inode edits cannot acknowledge a streamed header',async t=>{
  for(const action of ['account','cancel','replace','edit']){
    let hooked=false,f;const controller=new AbortController(),io={...fs,open:async(...args)=>{const file=await fs.open(...args);return {
      stat:(...a)=>file.stat(...a),close:()=>file.close(),read:async(...a)=>{const result=await file.read(...a);if(!hooked){hooked=true;
        if(action==='account')f.req.user.profile.handle='bob';
        else if(action==='cancel')controller.abort();
        else if(action==='edit')await fs.appendFile(f.file,'new body');
        else {await fs.rename(f.file,f.file+'.old');await fs.writeFile(f.file,JSON.stringify(header(rows()))+'\n');}
      }return result;},
    };}};
    f=await serviceFixture(t,io);await rejects(f.receipt.inspectGallery(f.req,input(),{signal:controller.signal}),'changed');
  }
});

test('streamed gallery refuses hardlinks and mismatched accounts before reading',async t=>{
  let reads=0;const f=await serviceFixture(t,{...fs,open:async(...args)=>{reads++;return fs.open(...args);}});
  await rejects(f.receipt.inspectGallery(f.req,{...input(),expectedAccount:'st-user:'+hash('bob')}),'account');
  await fs.link(f.file,f.file+'.link');await rejects(f.receipt.inspectGallery(f.req,input()),'path');assert.equal(reads,0);
});

test('streamed read deadline releases handle and never returns a truncated summary',async t=>{
  let now=0,closed=0;const io={...fs,open:async(...args)=>{const file=await fs.open(...args);return {
    stat:(...a)=>file.stat(...a),close:async()=>{closed++;await file.close();},read:async(...a)=>{const result=await file.read(...a);now=LIMIT.durationMs+1;return result;},
  };}};
  const f=await serviceFixture(t,io);t.mock.method(performance,'now',()=>now);
  await rejects(f.receipt.inspectGallery(f.req,input()),'timeout');assert.equal(closed,1);
});

test('one-byte reads preserve split BOM, UTF8 and escapes without accepting a partial source',async t=>{
  const io={...fs,open:async(...args)=>{const file=await fs.open(...args);return {
    stat:(...a)=>file.stat(...a),close:()=>file.close(),read:(buffer,offset,length,position)=>file.read(buffer,offset,Math.min(1,length),position),
  };}};
  const f=await serviceFixture(t,io);await fs.writeFile(f.file,'\uFEFF'+JSON.stringify(header(rows()))+'\r\nnot JSON');
  assert.deepEqual((await f.receipt.inspectGallery(f.req,input())).gallery,wanted(rows()));
});

test('64 MiB scan cap stops a valid but oversized header without following it into the body',async t=>{
  const f=await serviceFixture(t),file=await fs.open(f.file,'w'),block='x'.repeat(256*1024);
  try{
    await file.write('{"chat_metadata":{},"skipped":"');
    for(let at=0;at<LIMIT.bytes;at+=block.length)await file.write(block);
    await file.write('"}\nbody not scanned');
  }finally{await file.close();}
  const before=await fs.stat(f.file);await rejects(f.receipt.inspectGallery(f.req,input()),'size');
  const after=await fs.stat(f.file);assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs);
});

test('service close cancels streamed readers, keeping all four capacity slots until handles settle',async t=>{
  let release,entered,opened=0,closed=0;
  const hold=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
  const io={...fs,open:async(...args)=>{const file=await fs.open(...args);if(++opened===4)entered();return {
    stat:(...a)=>file.stat(...a),close:async()=>{closed++;await file.close();},read:async(...a)=>{await hold;return file.read(...a);},
  };}};
  const f=await serviceFixture(t,io),pending=Array.from({length:4},()=>rejects(f.receipt.inspectGallery(f.req,input()),'changed'));
  await ready;await rejects(f.receipt.inspectGallery(f.req,input()),'busy');const closing=f.receipt.close();
  release();await Promise.all([...pending,closing]);assert.equal(closed,4);
});
