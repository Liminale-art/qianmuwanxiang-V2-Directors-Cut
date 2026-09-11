import test from 'node:test';
import assert from 'node:assert/strict';
import {createCoreadPanelFixture,panelEscape} from './helpers/coread-panel-fixture.mjs';
import {coreadNoteMatches} from '../qianmu-reader-panel-view.js';

test('search uses note content rather than surrounding buttons dates or chapter labels',()=>{
  const note={kind:'highlight',chapterIndex:0,at:1,text:'A tree',annotation:'Thought',tags:['Green']};
  for(const search of ['第1节','笔记','复制','1970','#Green'])assert.equal(coreadNoteMatches(note,search),false,search);
  for(const search of ['Tree',' thought ','GREEN'])assert.equal(coreadNoteMatches(note,search),true,search);
  assert.equal(coreadNoteMatches(null),false);assert.equal(coreadNoteMatches({...note,kind:'bookmark'}),false);
});

const notes=()=>[
  {id:'old',kind:'highlight',chapterIndex:0,text:'Lake',annotation:'',at:10,tags:['Blue']},
  {id:'note',kind:'highlight',chapterIndex:2,text:'Tree',annotation:'A thought',at:40,tags:['Green']},
  {id:'fav',kind:'highlight',chapterIndex:1,text:'Flower',annotation:'  ',at:20,favorite:true,tags:[]},
  {id:'tie',kind:'highlight',chapterIndex:3,text:'Sky',annotation:'',at:40,tags:[]},
  {id:'mark',kind:'bookmark',chapterIndex:8,text:'bookmark only',at:99},
];
const cards=html=>[...html.matchAll(/<article class="sd-reader-note-item" data-note="([^"]*)"[^>]*>/g)].map(m=>({id:m[1],hidden:/ hidden>/.test(m[0])}));
const shown=html=>cards(html).filter(row=>!row.hidden).map(row=>row.id);

test('reader note view preserves favorite-first and stable newest order without mutating stored notes',()=>{
  const c=createCoreadPanelFixture(),meta={notes:notes()},before=JSON.stringify(meta);
  assert.deepEqual(shown(c.renderReaderNotes(meta)),['fav','note','tie','old']);assert.equal(JSON.stringify(meta),before);
  const html=c.renderReaderNotes(meta);assert.equal((html.match(/class="sd-reader-note-tools" hidden/g)||[]).length,4);
  assert.match(html,/data-note="note"[^>]*data-ch="2"[^>]*data-kind="note"/);
  assert.match(html,/data-note="fav"[^>]*data-kind="excerpt"[^>]*data-favorite="1"/);
});

test('note type and case-insensitive text annotation or tag search intersect while hidden rows remain available',()=>{
  const c=createCoreadPanelFixture(),meta={notes:notes()};
  const filters={all:['fav','note','tie','old'],excerpt:['fav','tie','old'],note:['note'],favorite:['fav'],unknown:['fav','note','tie','old']};
  const searches={'':['fav','note','tie','old'],' blue ':['old'],THOUGHT:['note'],flower:['fav'],missing:[]};
  for(const [filter,ids] of Object.entries(filters))for(const [search,hits] of Object.entries(searches)){
    c.readerView={noteFilter:filter,noteSearch:search};const html=c.renderReaderNotes(meta),expected=ids.filter(id=>hits.includes(id));
    assert.deepEqual(shown(html),expected);assert.equal(cards(html).length,4);
    assert.equal(html.includes('sd-reader-notes-none" hidden'),expected.length>0);
    assert.ok(html.includes('value="'+panelEscape(search)+'"'));
  }
});

test('empty notes are distinct from no matches; tag preview and search retain the existing eight-tag bound',()=>{
  const c=createCoreadPanelFixture();assert.match(c.renderReaderNotes({notes:[{kind:'bookmark'}]}),/还没有笔记/);
  assert.doesNotMatch(c.renderReaderNotes({}),/sd-reader-notes-toolbar/);
  const tags=['',...Array.from({length:9},(_,i)=>'tag'+i)],meta={notes:[{id:'many',kind:'highlight',chapterIndex:0,text:'x',tags}]};
  assert.equal((c.renderReaderNotes(meta).match(/<span>#tag/g)||[]).length,8);
  c.readerView.noteSearch='tag8';assert.deepEqual(shown(c.renderReaderNotes(meta)),[]);
  c.readerView=null;assert.deepEqual(shown(c.renderReaderNotes(meta)),['many']);
});

test('note and bookmark user text stays escaped and chapter targets remain the original numeric indexes',()=>{
  const c=createCoreadPanelFixture(),value='<img src=x onerror="bad">&';
  const meta={notes:[{id:value,kind:'highlight',chapterIndex:4,text:value,annotation:value,tags:[value]}]};
  const html=c.renderReaderNotes(meta);assert.doesNotMatch(html,/<img/);assert.ok(html.includes('data-note="'+panelEscape(value)+'"'));
  assert.ok(html.includes('<span>#'+panelEscape(value)+'</span>'));assert.match(html,/data-ch="4"[^>]*>第5节/);
  meta.notes[0].kind='bookmark';const mark=c.renderReaderMarks(meta);assert.doesNotMatch(mark,/<img/);assert.ok(mark.includes(panelEscape(value)));
});

test('bookmark view preserves reverse insertion order independently of note dates or favorite flags',()=>{
  const c=createCoreadPanelFixture(),meta={notes:[...notes(),{id:'last',kind:'bookmark',chapterIndex:1,text:'',at:1}]},before=JSON.stringify(meta);
  const html=c.renderReaderMarks(meta);assert.deepEqual([...html.matchAll(/class="sd-reader-note-item" data-note="([^"]+)"/g)].map(m=>m[1]),['last','mark']);
  assert.equal((html.match(/sd-reader-note-text/g)||[]).length,1);assert.equal(JSON.stringify(meta),before);assert.match(c.renderReaderMarks({}),/还没有书签/);
});

test('voice drawer includes only current voiced friend messages in reverse order without stale or blank dialogue',()=>{
  const c=createCoreadPanelFixture();assert.match(c.renderReaderVoiceClips(),/声音抽屉是空的/);
  c.readerDialog.messages=[{id:'one',role:'friend',voiced:true,text:'<voice>',ts:1},{id:'user',role:'user',voiced:true,text:'hidden user'},
    {id:'blank',role:'friend',voiced:true,text:' '},{id:'silent',role:'friend',text:'unvoiced'},
    {id:'two',role:'friend',voiced:true,text:'latest',ts:0}];
  const before=JSON.stringify(c.readerDialog),html=c.renderReaderVoiceClips();
  assert.deepEqual([...html.matchAll(/class="sd-reader-voice-item" data-msg="([^"]+)"/g)].map(m=>m[1]),['two','one']);
  assert.doesNotMatch(html,/hidden user|unvoiced|<voice>/);assert.match(html,/&lt;voice&gt;/);
  assert.equal(JSON.stringify(c.readerDialog),before);c.readerDialog.messages.pop();assert.doesNotMatch(c.renderReaderVoiceClips(),/data-msg="two"/);
});
