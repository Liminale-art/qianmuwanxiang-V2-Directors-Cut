import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createNotesPanelSync} from '../qianmu-notes-panel-sync.js';

const panelSource=await readFile(new URL('../qianmu-notes-panel-sync.js',import.meta.url),'utf8');
// Use the facade's exact installed URL so this also checks versioned imports.
const facadeURL=panelSource.match(/from '(\.\/qianmu-notes\.js[^']*)'/)[1];
const notes=await import(new URL('../'+facadeURL.slice(2),import.meta.url));

test('active note workflow has no legacy database dependency, scanner, adoption API or styling',async()=>{
  const facade=await readFile(new URL('../qianmu-notes.js',import.meta.url),'utf8');
  const runtime=await readFile(new URL('../qianmu-notes-sync-runtime.js',import.meta.url),'utf8');
  const style=await readFile(new URL('../style.css',import.meta.url),'utf8');
  assert.doesNotMatch(panelSource,/Legacy|legacy|旧便笺|download|confirm/);
  assert.doesNotMatch(facade,/blobstore|listLegacy|adoptLegacy|importLegacy/);
  assert.doesNotMatch(runtime,/importLegacy|receipts\.push/);
  assert.doesNotMatch(style,/\.sd-note-legacy/);
  assert.equal(notes.listLegacyQianmuNotes,undefined);
  assert.equal(notes.adoptLegacyQianmuNotes,undefined);
});

test('opening and repainting notes never scans old storage or mounts a legacy control',async()=>{
  const doc=new EventTarget(),win=new EventTarget(),notices=[];
  doc.hidden=false;doc.createElement=()=>assert.fail('no legacy controls should be created');
  const root={querySelector:()=>assert.fail('no legacy selectors should be queried')};
  const panel=createNotesPanelSync({getRoot:()=>root,document:doc,window:win,notify:(...args)=>notices.push(args)});
  try{
    panel.mount();panel.mount();panel.paint();panel.hide();panel.mount();
    await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(notices,[]);
    panel.fail(Error('synthetic local write failure'));panel.paint();
    assert.equal(notices.length,1);assert.match(notices[0][0],/保存未完成/);
  }finally{panel.dispose();}
});

test('removing legacy controls retains coalesced cross-device refresh, retry and focus wake lifecycle',async()=>{
  let calls=0,refreshes=0,retries=0,release;
  const pending=new Promise(resolve=>release=resolve),doc=new EventTarget(),win=new EventTarget();doc.hidden=false;
  notes.configureQianmuNotes({resolveNamespace:async()=>'st-user:retirement-fixture',createRuntime:()=>({
    status:{state:'synced',error:'',pending:0},async sync(){calls++;await pending;},close(){},
  })});
  const panel=createNotesPanelSync({getRoot:()=>({}),document:doc,window:win,
    refresh:async()=>refreshes++,retryLocal:async()=>retries++,hasUnsaved:()=>true});
  try{
    panel.mount();const a=panel.sync(),b=panel.sync();
    await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.equal(retries,1);
    release();await Promise.all([a,b]);assert.equal(refreshes,1);
    panel.hide();win.dispatchEvent(new Event('focus'));await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
    panel.mount();win.dispatchEvent(new Event('online'));await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);
  }finally{release();panel.dispose();await notes.clearTemporaryQianmuNotes();}
});
