import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {renderStoryboardWorldbookView} from '../qianmu-storyboard-worldbook-view.js';

const htmlEscape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const helpers = {htmlEscape, badge: text => `<span class="sd-badge">${htmlEscape(text)}</span>`, hashText: text => `hash-${text}`, cleanContextText: text => text};
const fixture = patch => ({loading:false,error:'',books:[{name:'人设书',labels:['角色绑定','USER绑定'],selected:true,manual:false,pending:false}],viewName:'人设书',
  entries:[{id:'entry-one',title:'外貌',content:'合成测试内容',checked:true},{id:'entry-two',title:'背景',content:'第二段',checked:false}],editing:false,bound:false,manual:false,
  ownerLabel:'当前角色与 User',...patch});
const render = (patch, state = {collapsedCards:{}}) => renderStoryboardWorldbookView(state, fixture(patch), helpers);
const entries = html => [...html.matchAll(/<input\b[^>]*data-storyboard-world-entry="[^"]*"[^>]*>/g)].map(match => match[0]);
const has = (tag, attribute) => new RegExp(`\\s${attribute}(?:\\s|>)`).test(tag);

test('ordinary selection keeps the original themed card, directory, entry hooks and direct checkbox behavior', () => {
  const html = render(), rows = entries(html);
  for (const name of ['sd-storyboard-worldbook-card','sd-storyboard-refresh-worldbooks','sd-storyboard-worldbook-picker','sd-storyboard-toggle-worldbook','sd-storyboard-world-name','sd-unified-source-entry','sd-storyboard-worldbook-entry-list']) assert.ok(html.includes(name), name);
  assert.equal(rows.length,2); assert.equal(has(rows[0],'checked'),true); assert.equal(has(rows[1],'checked'),false);
  assert.ok(rows.every(row => !has(row,'disabled'))); assert.match(html, /<b>1 项<\/b>/);
  assert.doesNotMatch(html,/sd-storyboard-(?:confirm|skip|cancel|edit)-persona-world/);
  const unselected = entries(render({books:[{name:'人设书',labels:[],selected:false}]}));
  assert.ok(unselected.every(row => has(row,'disabled')));
});

test('confirmed bound references remain inspectable but readonly until the explicit edit action', () => {
  const html = render({bound:true});
  assert.ok(entries(html).every(row => has(row,'disabled')));
  assert.match(html,/sd-storyboard-edit-persona-world">调整人设条目/);
  assert.match(html,/已确认的条目随当前角色与 User发送；新条目不会自动加入/);
  assert.doesNotMatch(html,/sd-storyboard-confirm-persona-world/);
});

test('bound draft enables entry checkboxes even before book enrollment and requires an inline explicit confirmation', () => {
  const html = render({bound:true,editing:true,books:[{name:'人设书',labels:['角色绑定'],selected:false,pending:true}]});
  assert.ok(entries(html).every(row => !has(row,'disabled')));
  for (const action of ['confirm','skip','cancel']) assert.match(html,new RegExp(`sd-storyboard-${action}-persona-world`));
  assert.match(html,/sd-primary sd-storyboard-confirm-persona-world">确认人设条目/);
  assert.match(html,/确认后随当前角色与 User发送；新条目不会自动加入/);
  assert.doesNotMatch(html,/sd-storyboard-edit-persona-world|<dialog|<form/);
  assert.ok(html.indexOf('sd-storyboard-confirm-persona-world') > html.indexOf('sd-storyboard-worldbook-entry-list'));
});

test('bound legacy manual selection stays directly editable and visibly explains conversion ownership', () => {
  for (const editing of [false,true]) {
    const html = render({bound:true,manual:true,editing});
    assert.ok(entries(html).every(row => !has(row,'disabled')));
    assert.match(html,/确认后取消此书的通用手选，改为随当前角色与 User生效/);
    if (!editing) assert.match(html,/sd-storyboard-edit-persona-world">随人设记住选择/);
    else assert.match(html,/确认后随当前角色与 User发送/);
  }
  const unselected = render({bound:true,manual:true,books:[{name:'人设书',selected:false}]});
  assert.ok(entries(unselected).every(row => has(row,'disabled')));
});

test('both binding labels and pending status are visible without silently selecting a book or entries', () => {
  const html = render({bound:true,books:[{name:'人设书',labels:['角色绑定','USER绑定'],selected:false,pending:true}],entries:[{id:'new',title:'新条目',content:'',checked:false}]});
  for (const label of ['角色绑定','USER绑定','待确认']) assert.match(html,new RegExp(`<span class="sd-badge">${label}</span>`));
  assert.match(html,/人设条目待确认，确认前不会随人设发送/);
  assert.match(html,/sd-storyboard-edit-persona-world">选择人设条目/);
  assert.match(html,/<b>0 项<\/b>/); assert.doesNotMatch(html,/\schecked(?:\s|>)/);
  assert.ok(entries(html).every(row => has(row,'disabled')));
});

test('loading, escaped errors, absent books, no viewed book and empty bound drafts remain understandable', () => {
  assert.match(render({loading:true,error:'should not show'}),/正在读取世界书/);
  assert.doesNotMatch(render({loading:true}),/data-storyboard-world-entry=/);
  assert.match(render({error:'<bad>'}),/&lt;bad&gt;/);
  assert.match(render({books:[],viewName:''}),/未读取到世界书/);
  assert.match(render({viewName:''}),/选择一本世界书后查看条目/);
  const empty=render({bound:true,editing:true,entries:[]});
  assert.match(empty,/暂无条目/); assert.match(empty,/sd-storyboard-skip-persona-world">不引用此书/);
  assert.match(empty,/sd-storyboard-confirm-persona-world">确认人设条目/);
});

test('book names, ids, titles, content, labels and owner labels cannot create markup or attributes', () => {
  const attack='"><img src=x onerror=1>&\'';
  const html=render({bound:true,editing:true,manual:true,ownerLabel:attack,viewName:attack,
    books:[{name:attack,labels:[attack],selected:true,pending:true}],entries:[{id:attack,title:attack,content:attack,checked:true}]});
  assert.doesNotMatch(html,/<img|<script|=""/); assert.ok(html.includes(htmlEscape(attack)));
  assert.ok(html.includes(`data-name="${htmlEscape(attack)}"`));
  assert.ok(html.includes(`data-storyboard-world-entry="${htmlEscape(attack)}"`));
  assert.ok(html.includes(`data-storyboard-card="${htmlEscape('worldbook-entry-hash-'+attack)}"`));
  assert.ok(html.includes(`确认后随${htmlEscape(attack)}发送`));
  assert.ok(html.includes(`<pre>${htmlEscape(attack)}</pre>`));
});

test('content cleaning and the existing 2000-character preview limit precede escaping', () => {
  let input;
  const html=renderStoryboardWorldbookView({collapsedCards:{}},fixture({entries:[{id:'long',title:'Long',content:'source',checked:false}]}),
    {...helpers,cleanContextText:value=>{input=value;return '<'.repeat(2001);}});
  assert.equal(input,'source'); assert.match(html,/<pre>/);
  assert.equal((html.match(/&lt;/g)||[]).length,2000);
});

test('the host keeps sole ownership of collapse state, selections and rendering lifecycle', async () => {
  const state={collapsedCards:{worldbook:true,'worldbook-directory':true,'worldbook-entries':true,'worldbook-entry-hash-entry-one':false}};
  const view=fixture({bound:true,editing:true}), before=JSON.stringify([state,view]);
  const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(freeze);}return value;};
  freeze(state);freeze(view);
  const html=renderStoryboardWorldbookView(state,view,helpers);
  assert.equal(renderStoryboardWorldbookView(state,view,helpers),html); assert.equal(JSON.stringify([state,view]),before);
  for (const name of ['worldbook','worldbook-directory','worldbook-entries']) assert.match(html,new RegExp(`data-storyboard-card="${name}" >`));
  assert.match(html,/data-storyboard-card="worldbook-entry-hash-entry-one" open/);
  const source=await readFile(new URL('../qianmu-storyboard-worldbook-view.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/\b(?:document|window|globalThis|fetch|localStorage|sessionStorage|indexedDB|setTimeout|setInterval|addEventListener)\b/);
});
