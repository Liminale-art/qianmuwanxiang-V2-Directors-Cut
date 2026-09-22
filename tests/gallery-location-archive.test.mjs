import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {galleryPreparedAssetsFixture as fixture} from './helpers/gallery-prepared-assets-fixture.mjs';
import {createGalleryArchiveBrowser} from '../qianmu-gallery-archive-browser.js';
import {createGalleryOriginalClient} from '../qianmu-gallery-original-client.js';
import {createGalleryLocation} from '../qianmu-gallery-location.js';
import {createStoryboardMessageReference,createStoryboardParagraphAnchor} from '../qianmu-storyboard.js';
import {hashText} from '../qianmu-storyboard-utils.js';
import {attachGalleryContinuity} from './helpers/gallery-continuity-fixture.mjs';

test('preserved original through the real archive browser locates its source without restoring gallery, recipe or files',async t=>{
  const f=await fixture(t,{count:1,decorateRecord(record,context){const message=context.chat[0];
    Object.assign(record,{chatKey:'chat',floor:0,swipeId:0,messageHash:hashText(message.mes),
      messageRef:createStoryboardMessageReference({message,chatKey:'chat',floor:0,now:1}),
      paragraphAnchor:createStoryboardParagraphAnchor({messageText:message.mes,paragraphText:message.mes,paragraphIndex:0,chatKey:'chat',swipeId:0})});
  }});
  const browser=f.own(createGalleryArchiveBrowser({...f.options,createArchive:()=>f.archive,
    createDiscovery:()=>({list:async()=>({entries:[{key:'a'.repeat(64),value:f.selection}],nextCursor:null}),close(){}}),
    createOriginal:options=>createGalleryOriginalClient({...options,fetchImpl:f.options.fetchImpl}),
    decodeOriginal:async(blob,{guard})=>{await guard();return {blob,width:1,height:1};},loadImage:()=>assert.fail('must read the preserved original')
  }));
  const list=await browser.list();await browser.open(list.entries[0].key);const page=await browser.page();
  const preview=await browser.preview(page.rows[0].recordId);assert.equal(preview.originalVerified,true);assert.equal(preview.canPrune,false);
  const metadata=JSON.stringify(f.context.chatMetadata),native=f.transport.calls.length,backend=f.calls.length;
  const lease=await createGalleryLocation({...f.options,record:preview.record,scope:preview.source,paragraphs:text=>[text]});t.after(()=>lease.close());
  assert.equal(lease.assertCurrent().floor,0);assert.equal(lease.assertCurrent().paragraphIndex,0);assert.deepEqual(f.store.storyboardImages,[]);
  assert.equal(f.transport.calls.length,native);assert.equal(f.calls.length,backend);assert.equal(JSON.stringify(f.context.chatMetadata),metadata);assert.deepEqual(await readFile(f.file),f.originalFile);
  f.context.chat[0].mes+=' changed';assert.throws(()=>lease.assertCurrent());
});
test('actual archived supplement can locate a continued original without restoring or writing any source fields',async t=>{
  const f=await fixture(t,{count:1,clearArchivedFields:['storyboardContinuations','storyboardFloorTakeReceipts'],prepareStore:async input=>{
    const {record}=await attachGalleryContinuity(input);Object.assign(input.rows[0],record);
  }});
  const browser=f.own(createGalleryArchiveBrowser({...f.options,createArchive:()=>f.archive,
    createDiscovery:()=>({list:async()=>({entries:[{key:'b'.repeat(64),value:f.selection}],nextCursor:null}),close(){}}),
    createOriginal:options=>createGalleryOriginalClient({...options,fetchImpl:f.options.fetchImpl}),
    decodeOriginal:async(blob,{guard})=>{await guard();return {blob,width:1,height:1};}
  }));
  const list=await browser.list();await browser.open(list.entries[0].key);const page=await browser.page();const preview=await browser.preview(page.rows[0].recordId);
  const before=JSON.stringify(f.context.chatMetadata),files=[...f.transport.files.entries()],native=f.transport.calls.length,backend=f.calls.length;let reads=0;
  const lease=await createGalleryLocation({...f.options,record:preview.record,scope:preview.source,paragraphs:text=>text.split('\n\n'),loadContinuity:async()=>{
    reads++;const value=await browser.supplement();assert.equal(value.receipt.version,2);assert.ok(value.receipt.order.includes(preview.record.id));
    return {scope:preview.source,links:value.receipt.saved.storyboardContinuations};
  }});t.after(()=>lease.close());assert.equal(lease.assertCurrent().kind,'continuation');await lease.verify();assert.equal(reads,1);
  assert.ok(f.transport.calls.length>native);assert.ok(f.transport.calls.slice(native).every(call=>call.options.method!=='POST'));assert.equal(f.calls.length,backend);
  assert.equal(JSON.stringify(f.context.chatMetadata),before);assert.deepEqual([...f.transport.files.entries()],files);assert.deepEqual(await readFile(f.file),f.originalFile);
  assert.equal(Object.hasOwn(f.store,'storyboardContinuations'),false);assert.deepEqual(f.store.storyboardImages,[]);
});
