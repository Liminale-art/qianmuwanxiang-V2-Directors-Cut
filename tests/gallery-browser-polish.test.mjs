import test from 'node:test';
import assert from 'node:assert/strict';
import {galleryBrowserProjection,galleryRecordSourceCharacter,galleryRecordMatchesQuery,renderGalleryImageCard,renderGalleryCollectionPath} from '../qianmu-gallery-collections-view.js';
import {renderGalleryBulkCollections} from '../qianmu-gallery-taxonomy.js';
import {renderGalleryKeywordFilters} from '../qianmu-gallery-keywords-view.js';

test('source-character collections derive only saved assistant metadata, never read recipes or rewrite memberships',()=>{
  const records=[{id:'a',messageRef:{name:'Alice',role:'assistant'},collectionIds:['manual']},{id:'b',messageRef:{name:'Alice',role:'assistant'}},{id:'c',messageRef:{name:'User',role:'user'}},{id:'d',sourceCharacterName:'Bob'}];
  const before=JSON.stringify(records);for(const row of records)Object.defineProperty(row,'snapshot',{get(){assert.fail('ordinary gallery must not read recipes');}});
  const result=galleryBrowserProjection(records,[{id:'manual',name:'Manual'}]);
  assert.equal(result.collections.length,3);assert.equal(result.collections[0].name,'Alice');assert.equal(result.collections[1].name,'Bob');
  assert.deepEqual(result.memberships(records[0]),['manual','source-char:Alice']);assert.deepEqual(result.memberships(records[2]),[]);
  assert.equal(JSON.stringify(records),before);assert.equal(galleryRecordSourceCharacter(records[2]),'');
  assert.equal(galleryRecordSourceCharacter(records[2],{name:'Verified source'}),'Verified source');
  assert.doesNotMatch(renderGalleryCollectionPath(result.collections[0]),/rename|delete/);
});
test('derived character collection ids cannot collide with manual collection ids',()=>{
  const result=galleryBrowserProjection([{id:'x',sourceCharacterName:'Alice'}],[{id:'source-char:Alice',name:'Manual'}]);
  assert.equal(new Set(result.collections.map(row=>row.id)).size,2);
});
test('collection-name search uses the render-local name index instead of scanning every collection for every image',()=>{
  const record={id:'r',collectionIds:['last']},names=new Map([['last','The final collection']]);let lookups=0;const lookup={get(id){lookups++;return names.get(id);}};
  assert.equal(galleryRecordMatchesQuery(record,'final',{collectionNames:lookup,collections:{filter(){assert.fail('whole collection scan');}}}),true);assert.equal(lookups,1);
});
test('unified search covers saved cast, source CHAR, exact source paragraph, model, tags and collection names',()=>{
  const record={id:'r',messageRef:{role:'assistant',name:'Source CHAR'},shotSpec:{characters:[{name:'Alice'},{name:'Bob'}]},tags:['日常'],model:'Model 9',collectionIds:['c'],prompt:'sunny room'};
  const options={collections:[{id:'c',name:'Holiday'}],location:{floor:26,paragraphText:'The bird flew away.'},production:{track:'main_camera'}};
  for(const term of ['source char','ALICE','Bob','日常','Model 9','Holiday','sunny room','bird','第27层','正文主线'])assert.equal(galleryRecordMatchesQuery(record,term,options),true,term);
  assert.equal(galleryRecordMatchesQuery(record,'not here',options),false);
});
test('cards contain only image, source name/source type, model corner and one tag row; no prompt floor or actions',()=>{
  const html=renderGalleryImageCard({id:'g',variants:[{id:'r',source:'comfy',model:'comfy-workflow',floor:26,prompt:'do not display this prompt',tags:['日常','独处','室内','夜色','宁静']} ]},{url:'/image.png',sourceCharacter:'Source CHAR',production:{track:'main_camera'}});
  assert.match(html,/Source CHAR · 正文主线/);assert.match(html,/ComfyUI/);assert.doesNotMatch(html,/第 26|do not display|comfy-workflow|gallery-actions|gallery-inspect|<p>/);
  assert.equal((html.match(/sd-storyboard-gallery-card-tags/g)||[]).length,1);assert.equal((html.match(/<em>/g)||[]).length,5);
});
test('compact keyword and bulk controls hide counts and expose distinct accessible icon actions',()=>{
  const keywords=renderGalleryKeywordFilters([],['日常'],['日常','独处'],{compact:true});assert.doesNotMatch(keywords,/已选 \d/);assert.match(keywords,/data-choice-compact="true"/);
  const bulk=renderGalleryBulkCollections([{id:'c',name:'Manual'}],{compact:true});assert.doesNotMatch(bulk,/请选择目标|已选 \d|当前：/);assert.match(bulk,/aria-label="加入合集"/);assert.match(bulk,/aria-label="移出自建合集"/);
});
