import test from 'node:test';
import assert from 'node:assert/strict';
import {textCollectionParagraphs,textCollectionParagraphSelection} from '../qianmu-text-collection-paragraphs.js';
import {createTextCollection,textCollectionRecord} from '../qianmu-text-collection.js';
const text=' 第一段😀 \r\n\r\n不要收藏的段落\r最后一段\n';
test('paragraph offsets preserve source characters, Unicode and mixed line endings',()=>{
 const paragraphs=textCollectionParagraphs(text);assert.equal(paragraphs.length,3);
 assert.deepEqual(paragraphs.map(p=>p.text),[' 第一段😀 ','不要收藏的段落','最后一段']);
 for(const p of paragraphs)assert.equal(text.slice(p.start,p.end),p.text);
 assert.equal(textCollectionParagraphSelection(text,[0,1]).text,text.slice(0,paragraphs[1].end));
});
test('nonadjacent multi-select never collects the unselected gap and explicitly uses edited capture provenance',()=>{
 const picked=textCollectionParagraphSelection(text,[2,0,2]);assert.equal(picked.text,' 第一段😀 \n\n最后一段');assert.equal(picked.disjoint,true);
 const record=createTextCollection({id:'chosen',source:{account:'st-user:'+'a'.repeat(64),chatId:'chat',messageId:0,replyId:'reply',charName:'CHAR',userName:'USER',text},mode:'selection',start:picked.start,end:picked.end,text:picked.text,createdAt:1});
 assert.equal(record.schemaVersion,3);assert.equal(record.captureEdited,true);assert.equal(record.range.start,0);assert.equal(record.range.end,text.length-1);
 assert.doesNotMatch(JSON.stringify(record),/不要收藏/);assert.deepEqual(textCollectionRecord(record),record);
});
test('single selection stays original schema and invalid selection is rejected rather than selecting everything',()=>{
 const p=textCollectionParagraphSelection(text,[1]);assert.equal(p.text,'不要收藏的段落');assert.equal(p.disjoint,false);
 for(const indices of [[],[-1],[3],[.5],['0'],null])assert.throws(()=>textCollectionParagraphSelection(text,indices));
});
