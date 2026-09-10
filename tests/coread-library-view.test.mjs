import test from 'node:test';
import assert from 'node:assert/strict';
import {createLibraryFixture} from './helpers/coread-library-fixture.mjs';

const book=(id,extra={})=>({id,title:'Title '+id,author:'Author',chapterCount:8,charCount:1234,progress:15,addedAt:1,...extra});
test('book cards retain mode-specific controls, progress bounds and collection removal without rewriting metadata',()=>{
  const {c}=createLibraryFixture();
  for(const mode of ['grid','list'])for(const collection of ['','collection'])for(const progress of [undefined,-10,120,12.5]){
    const b=book('one',{progress}),before=JSON.stringify(b),html=c.renderLibraryBookItem(b,mode,collection);
    assert.match(html,/sd-reader-card-edit/);assert.equal(html.includes('sd-reader-card-del'),mode==='list');
    assert.equal(html.includes('sd-reader-book-check'),mode==='list');assert.equal(html.includes('sd-reader-collection-remove-book'),!!collection);
    assert.ok(html.includes('>'+Math.max(0,Math.min(100,progress||0))+'%</span>'));
    assert.ok(html.includes('8章 · '+Number(1234).toLocaleString()+'字'));assert.equal(JSON.stringify(b),before);
  }
});

test('cover markup stays lazy and carries a book locator only; placeholders remain under failed or absent images',()=>{
  const {c}=createLibraryFixture();
  for(const hasCover of [false,true]){
    const html=c.renderLibraryBookItem(book('id<&',{title:'<title>',author:'<author>',hasCover}),'grid');
    assert.match(html,/sd-reader-cover-ph/);assert.equal(html.includes('loading="lazy"'),hasCover);assert.doesNotMatch(html,/<title>|<author>|\bsrc=/);
    assert.ok(html.includes('id&lt;&amp;'));assert.match(html,/&lt;title&gt;/);
  }
  assert.doesNotMatch(c.renderLibraryBookItem(book('one',{hasCover:true}),'list'),/<img/);
});

test('comic page statistics retain pageCount then chapterCount fallback independently of book character count',()=>{
  const {c}=createLibraryFixture();for(const mode of ['grid','list'])for(const [pageCount,chapterCount,wanted]of [[12,3,12],[0,3,3],[undefined,0,0]]){
    const html=c.renderLibraryBookItem(book('comic',{mode:'comic',pageCount,chapterCount}),mode);
    assert.ok(html.includes(wanted+'页 · 漫画'));assert.doesNotMatch(html,/章 · .*字/);
  }
});

test('collection preview resolves current metadata, ignores missing books and limits visual tiles to four',()=>{
  const {c,data}=createLibraryFixture();data.books=Array.from({length:6},(_,i)=>book('b'+i,{title:'BOOK '+i,hasCover:true}));
  const collection={id:'c<&',name:'Name <&',bookIds:['missing',...data.books.map(b=>b.id)]},before=JSON.stringify(collection),calls=[];
  const lookup=c.coreadBookMeta;c.coreadBookMeta=id=>{calls.push(id);return lookup(id);};
  const grid=c.renderLibraryCollectionItem(collection,'grid');assert.deepEqual(calls,collection.bookIds);
  assert.equal((grid.match(/class="sd-reader-collection-tile"/g)||[]).length,4);assert.equal((grid.match(/loading="lazy"/g)||[]).length,4);
  assert.match(grid,/6 本书/);assert.match(grid,/data-search="name &lt;&amp; book 0 author/);assert.doesNotMatch(grid,/data-cover="b4"|\bsrc=/);
  const list=c.renderLibraryCollectionItem(collection,'list');assert.match(list,/sd-reader-collection-dissolve/);assert.doesNotMatch(list,/<img/);
  assert.equal(JSON.stringify(collection),before);
});

test('collection placeholders preserve four cells even with no cover or missing members',()=>{
  const {c,data}=createLibraryFixture();data.books=[book('a',{title:'',hasCover:false})];
  const html=c.renderLibraryCollectionItem({id:'c',name:'Empty',bookIds:['missing','a']},'grid');
  assert.equal((html.match(/sd-reader-collection-tile-empty/g)||[]).length,3);assert.match(html,/tile-ph">书</);assert.match(html,/1 本书/);
});

test('library ownership and tag filtering remain outside card rendering and do not duplicate collection books at root',()=>{
  const {c,data}=createLibraryFixture();data.books=[book('a',{tags:['blue']}),book('b',{tags:['green']}),book('loose',{tags:['blue'],addedAt:5})];
  data.collections=[{id:'ca',name:'Alpha',bookIds:['a']},{id:'cb',name:'Beta',bookIds:['b']}];
  let html=c.renderLibraryView();assert.ok(html.includes('sd-reader-card" data-book="loose"'));assert.ok(!html.includes('sd-reader-card" data-book="a"'));
  assert.match(html,/data-collection="ca"/);assert.match(html,/data-collection="cb"/);
  data.libTags=['blue'];html=c.renderLibraryView();assert.match(html,/data-collection="ca"/);assert.doesNotMatch(html,/data-collection="cb"/);
  data.libCollectionId='ca';html=c.renderLibraryView();assert.match(html,/sd-reader-collection-head/);assert.match(html,/sd-reader-collection-back/);
  assert.ok(html.includes('sd-reader-card" data-book="a"'));assert.ok(!html.includes('sd-reader-card" data-book="loose"'));
  assert.match(html,/sd-reader-collection-remove-book/);assert.doesNotMatch(html,/class="sd-reader-collection-card"/);
});

test('full library preserves list batch controls, native import and distinct empty states',()=>{
  const {c,data}=createLibraryFixture();let html=c.renderLibraryView();assert.match(html,/书架还是空的/);assert.match(html,/支持 EPUB、MOBI、TXT 与 CBZ/);
  assert.match(html,/<input type="file" class="sd-reader-import-input sd-reader-native-file" accept="fixture-books-only">/);assert.doesNotMatch(html,/sd-reader-batch-delete/);
  data.libViewMode='list';html=c.renderLibraryView();assert.match(html,/sd-reader-collection-create[^]*sd-reader-batch-collect[^]*sd-reader-batch-delete/);
  assert.match(html,/sd-reader-batch-collect" title="归入合集" disabled/);
  data.libTags=['unmatched'];html=c.renderLibraryView();assert.match(html,/没有符合当前标签的书籍/);assert.doesNotMatch(html,/支持 EPUB/);
  data.libTags=[];data.collections=[{id:'empty',name:'Empty',bookIds:[]}];data.libCollectionId='empty';html=c.renderLibraryView();assert.match(html,/这个合集还是空的/);assert.doesNotMatch(html,/支持 EPUB/);
});
