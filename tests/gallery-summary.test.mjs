import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {summarizeGalleryRecords} from '../qianmu-gallery-summary.js';
import {renderGalleryInspector} from '../qianmu-gallery-inspector.js';
import {galleryMembershipIds} from '../qianmu-gallery-membership.js';
import {renderGalleryBulkCollections} from '../qianmu-gallery-taxonomy.js';
import {galleryCollectionEntries,galleryBrowserWindow,renderGalleryCollectionTile,renderGalleryCollectionPath,renderGalleryImageCard} from '../qianmu-gallery-collections-view.js';
import {renderGalleryKeywordFilters} from '../qianmu-gallery-keywords-view.js';
import {galleryTagsMatch} from '../qianmu-gallery-keywords.js';
import {createGalleryNarrativeSession} from '../qianmu-gallery-narrative.js';
import {galleryDisplayWindow,renderGalleryWindowControls} from '../qianmu-gallery-window.js';
import {uniqueClean, htmlEscape} from '../qianmu-storyboard-utils.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const ids = row => uniqueClean([...(Array.isArray(row.collectionIds)?row.collectionIds:[]),row.collectionId]).slice(0,30);
const sample = () => [{id:'a',tags:['日常',' 蓝色 ','日常','<b>'],collectionIds:['one','two','one'],collectionId:'two'},
  {id:'b',tags:['海岸',5,false,''],collectionId:'one'}, {id:'a',tags:['海岸'],collectionIds:['three']}, {id:'c'}];

test('render-local summary matches old metadata totals, exact tag filters and first-record lookup',()=>{
  const rows=sample(),before=JSON.stringify(rows),summary=summarizeGalleryRecords(rows,ids);
  for(const id of ['one','two','three','missing'])assert.equal(summary.collectionCount(id),rows.filter(row=>ids(row).includes(id)).length);
  for(const tag of ['日常',' 蓝色 ','蓝色','海岸',5,'missing'])assert.equal(summary.hasTag(tag),rows.some(row=>row.tags?.includes(tag)));
  assert.deepEqual(summary.knownTags,uniqueClean(rows.flatMap(row=>row.tags||[])).sort((a,b)=>a.localeCompare(b)));
  assert.deepEqual(summary.keywords,[...new Set(rows.flatMap(row=>row.tags||[]))].filter(word=>typeof word==='string'&&word).sort((a,b)=>a.localeCompare(b)));
  assert.equal(summary.record('a'),rows[0]);assert.equal(summary.record('missing'),null);assert.equal(JSON.stringify(rows),before);
});

test('summary never touches recipes, prompts, original images or other heavy record payloads',()=>{
  const row={id:'one',tags:['海岸'],collectionId:'one'};
  for(const key of ['snapshot','snapshotRef','snapshotServerRef','prompt','finalPrompt','url','payload'])Object.defineProperty(row,key,{get(){assert.fail('unexpected heavy access: '+key);}});
  const summary=summarizeGalleryRecords([row],ids);assert.equal(summary.record('one'),row);assert.equal(summary.collectionCount('one'),1);
});

test('legacy string-valued tags retain their existing includes behavior without rewriting originals',()=>{
  const row={id:'legacy',tags:'海岸 日常'},summary=summarizeGalleryRecords([row],ids);
  assert.equal(summary.hasTag('海岸'),true);assert.equal(summary.hasTag('missing'),false);
  assert.deepEqual(summary.keywords,['海岸 日常']);assert.equal(row.tags,'海岸 日常');
});

test('collection counting is once per record instead of once per collection per record',()=>{
  const rows=Array.from({length:5001},(_,i)=>({id:String(i),tags:['tag-'+i%12],collectionIds:['all','group-'+i%50]}));
  let reads=0;const summary=summarizeGalleryRecords(rows,row=>{reads++;return ids(row);});
  for(let round=0;round<10;round++)for(let i=0;i<50;i++)assert.ok(summary.collectionCount('group-'+i)>=100);
  assert.equal(reads,rows.length);assert.equal(summary.collectionCount('all'),rows.length);assert.equal(summary.keywords.length,12);
});

test('next render sees in-place edits, deletion and replacement chats without keeping a cross-render cache',()=>{
  const rows=sample();summarizeGalleryRecords(rows,ids);
  rows[0].collectionIds=[];rows[0].collectionId='edited';rows[0].tags=['changed'];rows.splice(1);
  const next=summarizeGalleryRecords(rows,ids);assert.equal(next.collectionCount('one'),0);assert.equal(next.collectionCount('edited'),1);
  assert.equal(next.hasTag('海岸'),false);assert.equal(next.hasTag('changed'),true);
  const foreign={id:'a',tags:['another chat']};assert.equal(summarizeGalleryRecords([foreign],ids).record('a'),foreign);
});

test('precomputed keyword view preserves escaping and selection and does not rescan records',()=>{
  const rows=sample(),selected=['日常','<b>'],summary=summarizeGalleryRecords(rows,ids),expected=renderGalleryKeywordFilters(rows,selected);
  const forbidden={flatMap(){assert.fail('precomputed keywords must not read the full gallery again');}};
  assert.equal(renderGalleryKeywordFilters(forbidden,selected,summary.keywords),expected);
  assert.equal(renderGalleryKeywordFilters(forbidden,[],[]),'');assert.ok(expected.includes('&lt;b&gt;'));
});

function rendererFixture(count=5001,collectionCount=0){
  const rows=Array.from({length:count},(_,i)=>({id:String(i),createdAt:i,tags:['tag-'+i%12],collectionIds:['group-'+i%50],source:'novel',prompt:'original '+i,url:'/image-'+i+'.png'}));
  const collections=Array.from({length:collectionCount},(_,i)=>({id:'group-'+i,name:'Group '+i}));
  const state={gallerySearch:'',galleryTrack:'all',galleryTagFilters:[]};let reads=0,collectionReads=0;
  const c=vm.createContext({summarizeGalleryRecords,renderGalleryInspector,renderGalleryBulkCollections,galleryCollectionEntries,galleryBrowserWindow,renderGalleryCollectionTile,renderGalleryCollectionPath,renderGalleryImageCard,galleryDisplayWindow,renderGalleryWindowControls,renderGalleryKeywordFilters,galleryTagsMatch,uniqueClean,htmlEscape,
    storyboardGalleryKind:'stills',storyboardGalleryOpenCollectionId:'',storyboardGalleryInspectorRecordId:'',storyboardGallerySelectMode:false,
    storyboardGallerySelection:new Set(),storyboardGalleryVisibleCount:40,storyboardGalleryRecords:()=>{reads++;return rows;},
    storyboardGalleryCollections:()=>collections,
    storyboardItemCollectionIds:row=>{collectionReads++;return ids(row);},storyboardState:()=>state,
    galleryMembershipIds:row=>{collectionReads++;return galleryMembershipIds(row);},
    ctx:()=>({chatMetadata:state,chat:[]}),getChatKey:()=> 'fixture',storyboardAdmissionEpoch:1,storyboardLinkReviewParagraphs:()=>[],
    storyboardGalleryNarrative:createGalleryNarrativeSession(),storyboardGalleryGroupId:row=>row.id,
    storyboardProductionDeliveryPolicy:()=>({track:'main_camera',sourceLabel:'正文'}),STORYBOARD_SOURCES:{novel:{label:'NAI'}},
    storyboardMediaSidebarMarkup:()=>assert.fail('ordinary gallery must not render the old sidebar'),
    renderStoryboardGalleryKindSwitch:()=>'',renderGalleryNarrative:()=>'',storyboardSafeUrl:value=>value,
    storyboardRecordStatus:()=>'',formatDateTime:String,snip:(value,n)=>String(value).slice(0,n),storyboardMediaTagEditorMarkup:()=>''});
  vm.runInContext(['storyboardUpdateGalleryNarrative','storyboardFilteredGalleryRecords','storyboardGalleryGroups','renderStoryboardGallery'].map(section).join('\n'),c);
  return {rows,collections,state,c,get reads(){return reads;},get collectionReads(){return collectionReads;}};
}

test('actual gallery render shares metadata counters while retaining the independent narrative projection',()=>{
  const e=rendererFixture(5001,50),before=JSON.stringify(e.rows),html=e.c.renderStoryboardGallery(e.state);
  assert.equal(e.reads,2,'one metadata capture plus the existing narrative source');assert.equal(e.collectionReads,5001);
  assert.equal((html.match(/data-storyboard-record=/g)||[]).length,30);assert.equal((html.match(/data-gallery-collection=/g)||[]).length,10);assert.equal((html.match(/data-gallery-tag-filter=/g)||[]).length,12);
  assert.ok(html.indexOf('data-storyboard-record="5000"')<html.indexOf('data-storyboard-record="4999"'));
  assert.equal(JSON.stringify(e.rows),before);
});

test('actual filter calls outside rendering retain default source, search, collection and intersection behavior',()=>{
  const e=rendererFixture(5);e.state.gallerySearch='original 3';
  assert.deepEqual(Array.from(e.c.storyboardFilteredGalleryRecords(e.state),row=>row.id),['3']);assert.equal(e.reads,2);
  e.state.gallerySearch='';e.c.storyboardGalleryOpenCollectionId='group-2';e.state.galleryTagFilters=['tag-2'];
  assert.deepEqual(Array.from(e.c.storyboardFilteredGalleryRecords(e.state),row=>row.id),['2']);
  e.state.galleryTagFilters.push('tag-3');assert.equal(e.c.storyboardFilteredGalleryRecords(e.state).length,0);
});

test('actual next gallery render sees changed tags and removes a missing inspected record',()=>{
  const e=rendererFixture(5);e.c.storyboardGalleryInspectorRecordId='4';e.state.galleryTagFilters=['tag-4'];
  e.rows.pop();const html=e.c.renderStoryboardGallery(e.state);
  assert.equal(e.c.storyboardGalleryInspectorRecordId,'');assert.equal(e.state.galleryTagFilters.length,0);
  assert.equal((html.match(/data-storyboard-record=/g)||[]).length,4);
  e.rows[0].tags=['fresh'];assert.ok(e.c.renderStoryboardGallery(e.state).includes('data-gallery-tag-filter="fresh"'));
});

test('actual gallery render pages through every group while retaining off-page selection and original records',()=>{
  const e=rendererFixture(81),before=JSON.stringify(e.rows),seen=[];e.c.storyboardGallerySelection.add('80');
  for(const cursor of [40,80,120]){
    e.c.storyboardGalleryVisibleCount=cursor;const html=e.c.renderStoryboardGallery(e.state),ids=[...html.matchAll(/data-storyboard-record="([^"]+)"/g)].map(match=>match[1]);
    assert.ok(ids.length<=40);seen.push(...ids);assert.equal(e.c.storyboardGallerySelection.has('80'),true);
  }
  assert.deepEqual(seen,[...e.rows].reverse().map(row=>row.id));assert.equal(JSON.stringify(e.rows),before);
  e.c.storyboardGalleryVisibleCount=80;assert.ok(e.c.renderStoryboardGallery(e.state).includes('41–80 / 81 组'));
});

test('actual rendering clamps a deleted last page and retains inspection and saved page across an ordinary rerender',()=>{
  const e=rendererFixture(81);e.c.storyboardGalleryVisibleCount=120;e.c.renderStoryboardGallery(e.state);
  e.rows.splice(0,41);const html=e.c.renderStoryboardGallery(e.state);assert.equal(e.c.storyboardGalleryVisibleCount,40);
  assert.equal((html.match(/data-storyboard-record=/g)||[]).length,40);
  const another=rendererFixture(100);another.c.storyboardGalleryVisibleCount=80;another.c.storyboardGalleryInspectorRecordId='2';
  const first=another.c.renderStoryboardGallery(another.state);assert.equal(another.c.storyboardGalleryVisibleCount,80);assert.ok(first.includes('画面详情'));
  another.c.renderStoryboardGallery(another.state);assert.equal(another.c.storyboardGalleryVisibleCount,80);assert.equal(another.c.storyboardGalleryInspectorRecordId,'2');
});

test('ordinary browsing has no empty inspector, and selecting one record replaces the browser with a detail view',()=>{
  const e=rendererFixture(100);e.c.storyboardGalleryVisibleCount=80;
  const list=e.c.renderStoryboardGallery(e.state);assert.doesNotMatch(list,/data-gallery-detail=|画面详情|sd-media-inspector/);
  e.c.storyboardGalleryInspectorRecordId='42';const before=JSON.stringify(e.rows),detail=e.c.renderStoryboardGallery(e.state);
  assert.match(detail,/data-gallery-detail="42"/);assert.match(detail,/data-gallery-detail-back/);
  assert.equal((detail.match(/<img /g)||[]).length,1);assert.doesNotMatch(detail,/data-storyboard-record=|sd-gallery-window-controls/);
  assert.equal(e.c.storyboardGalleryVisibleCount,80);assert.equal(JSON.stringify(e.rows),before);
  e.c.storyboardGalleryInspectorRecordId='';assert.match(e.c.renderStoryboardGallery(e.state),/41–80 \/ 100 组/);
});

test('selected detail template reads no other record prompt or recipe; production policy is injected separately',()=>{
  const e=rendererFixture(5);e.c.storyboardGalleryInspectorRecordId='2';e.state.gallerySearch='unchanged';e.state.galleryTagFilters=['tag-1'];
  for(const row of e.rows){Object.defineProperty(row,'snapshot',{get(){assert.fail('recipe must be explicitly requested');}});
    if(row.id!=='2')for(const key of ['prompt','finalPrompt','url'])Object.defineProperty(row,key,{get(){assert.fail('unselected payload '+key);}});}
  assert.match(e.c.renderStoryboardGallery(e.state),/original 2/);assert.equal(e.state.gallerySearch,'unchanged');assert.deepEqual(e.state.galleryTagFilters,['tag-1']);
});

test('actual mixed gallery pages all images and folders without old sidebar or split groups',()=>{
  const e=rendererFixture(81,50),images=[],folders=[];
  for(const cursor of [40,80,120,160]){
    e.c.storyboardGalleryVisibleCount=cursor;const html=e.c.renderStoryboardGallery(e.state);
    const pageImages=[...html.matchAll(/data-storyboard-record="([^"]+)"/g)].map(m=>m[1]);
    const pageFolders=[...html.matchAll(/data-gallery-collection="([^"]+)"/g)].map(m=>m[1]);
    assert.ok(pageImages.length+pageFolders.length<=40);images.push(...pageImages);folders.push(...pageFolders);
    assert.doesNotMatch(html,/sd-media-gallery-library|sd-media-library-sidebar|sd-media-inspector/);
  }
  assert.deepEqual(images,[...e.rows].reverse().map(row=>row.id));assert.equal(new Set(folders).size,50);assert.equal(folders.length,50);
});

test('actual name-only folder search includes whole-count preview, entering a folder removes other folder tiles',()=>{
  const e=rendererFixture(5,2);e.state.gallerySearch='Group 1';let html=e.c.renderStoryboardGallery(e.state);
  assert.match(html,/data-gallery-collection="group-1" data-gallery-collection-clear-search="true"/);assert.match(html,/<small>1 张<\/small>/);
  assert.doesNotMatch(html,/data-storyboard-record=/);
  e.state.gallerySearch='';e.c.storyboardGalleryOpenCollectionId='group-1';html=e.c.renderStoryboardGallery(e.state);
  assert.match(html,/data-gallery-root/);assert.doesNotMatch(html,/sd-gallery-collection-tile/);assert.match(html,/data-storyboard-record="1"/);
  assert.equal((html.match(/data-storyboard-record=/g)||[]).length,1);
});

test('actual empty gallery still displays empty collection and filters cannot silently widen it',()=>{
  const e=rendererFixture(0,1);let html=e.c.renderStoryboardGallery(e.state);
  assert.match(html,/sd-gallery-collection-empty/);assert.match(html,/data-gallery-collection="group-0"/);
  e.state.gallerySearch='Group 0';e.state.galleryTrack='second_camera';html=e.c.renderStoryboardGallery(e.state);
  assert.doesNotMatch(html,/data-gallery-collection=/);
});

test('actual large mixed render reads cover URLs only for visible tiles and model badges only for visible cards',()=>{
  const e=rendererFixture(5001,501);let urls=0,models=0;
  for(const row of e.rows){Object.defineProperty(row,'url',{get(){urls++;return '/image.png';}});Object.defineProperty(row,'model',{get(){models++;return 'recorded-model';}});}
  const html=e.c.renderStoryboardGallery(e.state);assert.equal(urls,40);assert.equal(models,30);
  assert.equal((html.match(/class="sd-gallery-model-label"/g)||[]).length,30);assert.equal(e.collectionReads,5001);
});

test('actual selected gallery renders bounded bulk choices instead of thousands of select options',()=>{
  const e=rendererFixture(5,5001);e.c.storyboardGallerySelectMode=true;const html=e.c.renderStoryboardGallery(e.state);
  assert.match(html,/data-gallery-picker="bulk-collections"/);assert.doesNotMatch(html,/sd-storyboard-gallery-move-target/);
  assert.equal((html.match(/data-choice-id=/g)||[]).length,29,'24 bulk choices plus 5 keywords');
});

test('actual gallery filtering and detail retain collection memberships beyond the old 30 read cap',()=>{
  const e=rendererFixture(1,80);e.rows[0].collectionIds=Array.from({length:41},(_,i)=>'group-'+i);e.c.storyboardGalleryOpenCollectionId='group-40';
  assert.equal(e.c.storyboardFilteredGalleryRecords(e.state).length,1);e.c.storyboardGalleryInspectorRecordId='0';
  const html=e.c.renderStoryboardGallery(e.state);assert.match(html,/已选 41/);assert.equal((html.match(/data-choice-id=/g)||[]).length,24);
});
