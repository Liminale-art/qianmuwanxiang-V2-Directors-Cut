import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildGalleryNarrative,createGalleryNarrativeSession,GALLERY_UNPLACED} from '../qianmu-gallery-narrative.js';
import {captureGalleryNarrativeInputs,sameGalleryNarrativeInputs,GALLERY_NARRATIVE_REUSE_LIMITS} from '../qianmu-gallery-narrative-inputs.js';
import {createStoryboardMessageReference,createStoryboardParagraphAnchor,storyboardMessageIdentityInputs} from '../qianmu-storyboard.js';
import {hashText} from '../qianmu-storyboard-utils.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import vm from 'node:vm';

function fixture(count=2,reuse=true){
  const f={owner:{},chatKey:'fixture',epoch:1,plans:[],calls:0,mode:'ok',onParse:null,
    messages:Array.from({length:count},(_,i)=>({mes:`opening ${i}\ncoast ${i}`,name:'CHAR',send_date:'date-'+i,swipe_id:0})),records:[]};
  f.paragraphs=value=>{f.calls++;f.onParse?.();if(f.mode==='throw')throw Error('temporary parser');if(f.mode==='null')return null;
    if(f.mode==='wrong')return {rows:[]};if(f.mode==='many')return Array(241).fill('row');return value.split('\n');};
  f.add=(floor=0)=>{const message=f.messages[floor],record={id:'r'+f.records.length,chatKey:f.chatKey,messageHash:hashText(message.mes),swipeId:message.swipe_id,
    messageRef:createStoryboardMessageReference({message,floor,chatKey:f.chatKey,now:1}),
    paragraphAnchor:createStoryboardParagraphAnchor({messageText:message.mes,paragraphText:message.mes.split('\n')[0],paragraphIndex:0,swipeId:message.swipe_id,chatKey:f.chatKey,createdAt:1})};f.records.push(record);return record;};
  f.session=createGalleryNarrativeSession({reuseUnchanged:reuse});f.sync=()=>f.session.update(f);return f;
}
function assertFresh(f){
  const expected=buildGalleryNarrative(f);
  assert.equal(f.session.sourceCount,expected.floors.length);assert.equal(f.session.view().unplaced,expected.unplaced.size);
  for(const record of f.records)assert.deepEqual(f.session.sourceFor(record),expected.sources.get(String(record.id)));
}

test('shared pre-hash message normalization preserves the 17 committed v312 identity fixtures exactly',()=>{
  const cases=JSON.parse(readFileSync(new URL('./fixtures/gallery-message-identities-v312.json',import.meta.url),'utf8'));
  assert.equal(cases.length,17);for(const row of cases)assert.deepEqual(createStoryboardMessageReference(row.input),row.expected);
  const stamp=new Date('2026-01-01T00:00:00Z'),message={mes:'text',send_date:stamp};
  assert.equal(storyboardMessageIdentityInputs(message).baseSendDate,stamp.toISOString());
  stamp.setUTCDate(2);assert.equal(storyboardMessageIdentityInputs(message).baseSendDate,'2026-01-02T00:00:00.000Z');
});

test('opted-in session reuses unchanged projections while unrelated artwork edits do not parse prose again',()=>{
  const f=fixture(),record=f.add();f.add(1);f.sync();assert.equal(f.calls,2);
  for(let i=0;i<20;i++){record.tags=['changed-'+i];record.prompt='new image prompt';record.url='/changed.png';f.plans=[{id:String(i)}];f.sync();}
  assert.equal(f.calls,2);assertFresh(f);
  const plain=fixture(1,false);plain.add();plain.sync();plain.sync();assert.equal(plain.calls,2,'unknown parsers keep the default non-reusing behavior');
});

test('new array containers with equal scalar inputs reuse, without reading image payloads or keys',()=>{
  const f=fixture(),record=f.add();f.sync();
  for(const key of ['snapshot','snapshotRef','snapshotServerRef','url','prompt','negative','payload','apiKey'])Object.defineProperty(record,key,{get(){assert.fail('heavy/private field read: '+key);}});
  f.messages=[...f.messages];f.records=[...f.records];f.sync();assert.equal(f.calls,1);
  assert.ok(sameGalleryNarrativeInputs(captureGalleryNarrativeInputs(f),captureGalleryNarrativeInputs(f)));
});

for(const [label,change] of Object.entries({
  text:f=>f.messages[0].mes+=' revised',name:f=>f.messages[0].name='New CHAR',role:f=>f.messages[0].is_user=true,
  system:f=>f.messages[0].is_system=true,swipe:f=>f.messages[0].swipe_id=1,date:f=>f.messages[0].send_date='new date',
  generation:f=>f.messages[0].extra={gen_id:'new generation'},
  firstSwipeDate:f=>f.messages[0].swipe_info=[{send_date:'first changed'}],
  firstSwipeGeneration:f=>f.messages[0].swipe_info=[{extra:{gen_id:'first changed'}}],
  insert:f=>f.messages.unshift({mes:'new earlier',send_date:'new',name:'CHAR'}),
  remove:f=>f.messages.splice(0,1),duplicateMessage:f=>f.messages.push(structuredClone(f.messages[0])),
  duplicateRecord:f=>f.records.push(structuredClone(f.records[0])),recordIdentity:f=>f.records[0].id='changed',
  recordOwner:f=>f.records[0].chatKey='foreign',rawHash:f=>f.records[0].messageHash='wrong',recordSwipe:f=>f.records[0].swipeId=2,
  referenceAbsent:f=>f.records[0].messageRef=null,referenceOwner:f=>f.records[0].messageRef.chatKey='foreign',
  referenceKey:f=>f.records[0].messageRef.messageKey='wrong',revisionId:f=>f.records[0].messageRef.revisionId='wrong',
  revisionHash:f=>f.records[0].messageRef.revisionHash='wrong',referenceSwipe:f=>f.records[0].messageRef.swipeId='0',
  review:f=>f.records[0].restoreLinkReview={},anchorOwner:f=>f.records[0].paragraphAnchor.chatKey='foreign',
  paragraphIndex:f=>f.records[0].paragraphAnchor.paragraphIndex=1,paragraphHash:f=>f.records[0].paragraphAnchor.paragraphHash='wrong',
  paragraphText:f=>f.records[0].paragraphAnchor.paragraphText='other',paragraphMessageHash:f=>f.records[0].paragraphAnchor.messageHash='wrong',
  paragraphSwipe:f=>f.records[0].paragraphAnchor.swipeId=1,
}))test(`in-place ${label} changes invalidate reuse and agree with a fresh full projection`,()=>{
  const f=fixture();f.add();f.add(1);f.sync();change(f);f.sync();assertFresh(f);
});

test('active and base swipe fields, fallback base text, mutable Dates and raw display names are captured',()=>{
  const f=fixture(),message=f.messages[0];
  Object.assign(message,{swipe_id:1,swipes:['first','second'],swipe_info:[{send_date:new Date('2026-01-01'),extra:{gen_id:'base'}},{send_date:'active',extra:{gen_id:'active'}}]});
  for(const mutate of [()=>message.swipe_info[0].send_date.setUTCDate(2),()=>message.swipe_info[1].send_date='later',
    ()=>message.swipe_info[1].extra.gen_id='later-id',()=>message.swipes[0]='changed base',()=>message.name=' CHAR']){
    const before=captureGalleryNarrativeInputs(f);mutate();assert.equal(sameGalleryNarrativeInputs(before,captureGalleryNarrativeInputs(f)),false);
  }
  delete message.send_date;delete message.swipe_info;message.gen_started='first start';
  const before=captureGalleryNarrativeInputs(f);message.gen_started='next start';assert.equal(sameGalleryNarrativeInputs(before,captureGalleryNarrativeInputs(f)),false);
});

test('changed parser identity rebuilds and transient invalid parser results are never remembered',()=>{
  const f=fixture(),record=f.add();f.sync();f.session.selectRecord(record);f.paragraphs=()=>['different paragraph'];f.sync();assert.equal(f.session.selected.stale,true);
  for(const mode of ['throw','null','wrong','many']){
    const e=fixture();e.add();e.mode=mode;e.sync();assert.equal(e.session.view().partial,0);
    assert.equal(e.session.sourceFor(e.records[0]).paragraphKey,'');e.mode='ok';e.sync();assert.equal(e.calls,2);assert.ok(e.session.sourceFor(e.records[0]).paragraphKey);
  }
});

test('parser-side input mutation cannot be installed as an unchanged cached projection',()=>{
  // Whitespace changes the displayed name without changing its normalized identity.
  // A different identity would correctly become unplaced, with no parser call.
  const f=fixture();f.add();f.onParse=()=>{f.messages[0].name=' CHAR ';};f.sync();
  f.onParse=null;f.sync();assert.equal(f.calls,2);assert.equal(f.session.view().rows[0].name,' CHAR ');
});

test('returned source, selection and directory collections cannot poison reused internal membership',()=>{
  const f=fixture(),record=f.add();f.sync();
  f.session.sourceFor(record).floorKey='poison';const view=f.session.view();view.rows[0].ids.clear();view.rows[0].paragraphs.clear();
  f.session.selectRecord(record);f.session.selected.ids.clear();f.session.view().selected.ids.clear();f.session.view().rows[0].ids.clear();
  f.sync();assert.equal(f.calls,1);assert.deepEqual(f.session.filter(f.records),[record]);assert.ok(f.session.sourceFor(record).paragraphKey);
});

test('failed rebuild discards old source results and leaves an explicit stale selection',()=>{
  for(const unplaced of [false,true]){
    const f=fixture(),record=f.add();if(unplaced)record.restoreLinkReview={};f.sync();
    if(unplaced)f.session.choose(GALLERY_UNPLACED);else f.session.selectRecord(record);
    f.messages[0].send_date=new Date(NaN);assert.throws(()=>f.sync());
    assert.equal(f.session.sourceCount,0);assert.equal(f.session.sourceFor(record),undefined);assert.equal(f.session.selected.stale,true);
    assert.deepEqual(f.session.filter(f.records),[]);assert.equal(f.session.choose('any'),false);
  }
});

test('owner/chat/epoch and explicit cleanup release remembered projection and navigation',()=>{
  for(const key of ['owner','chatKey','epoch']){
    const f=fixture(),record=f.add();f.sync();f.session.selectRecord(record);
    f[key]=key==='owner'?{}:key==='epoch'?2:'new chat';f.sync();assert.equal(f.session.selected,null);assertFresh(f);
  }
  const f=fixture();f.add();f.sync();f.session.reset();assert.equal(f.session.sourceCount,0);f.sync();assert.equal(f.calls,2);
});

test('reuse limits and unsupported scalar shapes bypass optimization without truncating the source',()=>{
  const f=fixture();f.add();f.messages=Array.from({length:GALLERY_NARRATIVE_REUSE_LIMITS.messages+1},()=>({is_user:true,mes:'ignored USER'}));
  f.messages[0]={mes:'opening 0\ncoast 0',name:'CHAR',send_date:'date-0',swipe_id:0};
  const last=f.messages.length-1;f.messages[last]={mes:'last beyond reuse limit',name:'CHAR',send_date:'last-date',swipe_id:0};f.add(last);
  assert.equal(captureGalleryNarrativeInputs(f),null);f.sync();f.sync();assert.equal(f.calls,4);assert.equal(f.session.sourceCount,2);
  assert.ok(f.session.sourceFor(f.records.at(-1)),'the floor beyond the reuse limit is still processed');
  const tooMany=Array.from({length:GALLERY_NARRATIVE_REUSE_LIMITS.records+1},(_,i)=>({id:String(i)}));
  assert.equal(captureGalleryNarrativeInputs({...f,messages:[],records:tooMany}),null);assert.equal(tooMany.length,50001);
  const session=createGalleryNarrativeSession({reuseUnchanged:true});session.update({messages:[],records:tooMany});
  assert.equal(session.view().unplaced,50001);session.choose(GALLERY_UNPLACED);assert.equal(session.selected.ids.has('50000'),true);
  assert.equal(captureGalleryNarrativeInputs({messages:null,records:[]}),null);
  assert.equal(captureGalleryNarrativeInputs({messages:[],records:[{id:'x',messageRef:{revisionId:{}}}]}),null);
});

test('actual gallery update uses the opted-in session and unchanged high-floor input avoids parsing again',()=>{
  const f=fixture(500);for(let i=0;i<500;i++)f.add(i);
  const context=vm.createContext({storyboardGalleryNarrative:f.session,ctx:()=>({chatMetadata:f.owner,chat:f.messages}),getChatKey:()=>f.chatKey,
    storyboardAdmissionEpoch:f.epoch,storyboardGalleryRecords:()=>f.records,storyboardState:()=>({shotPlans:f.plans}),storyboardLinkReviewParagraphs:f.paragraphs});
  vm.runInContext(section('storyboardUpdateGalleryNarrative'),context);
  for(let i=0;i<10;i++)context.storyboardUpdateGalleryNarrative();assert.equal(f.calls,500);
  const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');assert.match(source,/const storyboardGalleryNarrative = createGalleryNarrativeSession\(\{reuseUnchanged:true\}\)/);
});
