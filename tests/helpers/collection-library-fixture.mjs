import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {textCollectionDisplayLabel,textCollectionListLabel,textCollectionRecord,TEXT_COLLECTION_LIMITS} from '../../qianmu-text-collection.js';
import {partitionTextCollectionMutations,TEXT_COLLECTION_BULK_LIMITS} from '../../qianmu-text-collection-bulk-contract.js';

// Executes the real panel controller against a small in-memory DOM/event double.
// It proves controller cancellation/order, not native ST layout or rendering.
export async function collectionLibraryFixture(t,{ignoreAbort=false,background=false,initialCount=0,sessionOverrides={}}={}){
  const all=[],queries=new Map(),timers=new Map(),calls=[];let timerId=0,closed=false,current=true,changes=0;
  class Element{
    constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.listeners=new Map();this.attrs={};this.isConnected=true;this.value='';this.textContent='';this.hidden=false;this.classList={toggle(){}};all.push(this);}
    querySelector(selector){if(!queries.has(selector))queries.set(selector,new Element(selector==='input'?'input':'div'));return queries.get(selector);}
    querySelectorAll(selector){return selector==='button'?all.filter(el=>el.isConnected&&el.tagName==='BUTTON'):all.filter(el=>el.isConnected&&el.dataset.collectionId);}
    append(...nodes){this.children.push(...nodes.flatMap(node=>node.tagName==='FRAGMENT'?node.children:[node]));}
    replaceChildren(...nodes){this.children=[];this.append(...nodes);}
    setAttribute(key,value){this.attrs[key]=value;}
    removeAttribute(key){delete this.attrs[key];}
    addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
    removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
    async emit(type,event={}){for(const fn of this.listeners.get(type)||[])await fn({target:this,preventDefault(){},stopPropagation(){},...event});}
    contains(){return true;}closest(selector){return selector==='button'&&this.tagName==='BUTTON'?this:null;}
    showModal(){this.open=true;}close(){this.open=false;void this.emit('close');}remove(){this.isConnected=false;for(const el of all)el.children=el.children.filter(child=>child!==this);}focus(){}
  }
  const view=new EventTarget();view.AbortController=AbortController;view.Event=Event;view.crypto=globalThis.crypto;
  view.MutationObserver=class{observe(){}disconnect(){}};view.setTimeout=fn=>{timers.set(++timerId,fn);return timerId;};view.clearTimeout=id=>timers.delete(id);
  const document=new EventTarget();document.defaultView=view;document.activeElement=null;document.documentElement=new Element();
  document.addEventListener('qianmu-text-collections-changed',()=>changes++);
  document.createElement=tag=>new Element(tag);document.createDocumentFragment=()=>new Element('fragment');
  const parent=new Element();parent.ownerDocument=document;
  const page=(n=0)=>({items:Array.from({length:n},(_,i)=>({id:'item-'+String(i).padStart(4,'0'),revision:1,charName:'CHAR',userName:'USER',createdAt:10,preview:'片段'+i})),total:n,nextCursor:null});
  const session={guard:async()=>true,close(){closed=true;},readCacheNeedsRefresh:()=>background,
    list(input,options){
      let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;}),call={input,options,resolve:n=>resolve(page(n)),reject};calls.push(call);
      if(!input.search&&!options.revalidate)resolve(page(initialCount));
      else if(!ignoreAbort)options.signal.addEventListener('abort',()=>reject(Object.assign(Error('取消旧搜索'),{code:'text_collection_sync_cancelled'})),{once:true});
      return promise;
    },...sessionOverrides};
  const icon=(_document,action)=>{const el=new Element('button');el.dataset.collectionManage=action;queries.set(`[data-collection-manage="${action}"]`,el);return el;};
  const source=await readFile(new URL('../../qianmu-text-collection-library.js',import.meta.url),'utf8');
  const context=vm.createContext({createTextCollectionSession:async()=>session,createTextCollectionOutboxRuntime:()=>({close(){}}),
    applyCollectionProseStyle(){},collectionIconButton:icon,collectionEditorText:text=>text,collectionEditorValue:(original,text)=>text,
    textCollectionDisplayLabel,textCollectionListLabel,textCollectionRecord,TEXT_COLLECTION_LIMITS,textCollectionParagraphs:()=>[],partitionTextCollectionMutations,TEXT_COLLECTION_BULK_LIMITS});
  vm.runInContext(source.replace(/^import .*\r?\n/gm,'').replace('export async function openTextCollectionLibrary','async function openTextCollectionLibrary')+'\nglobalThis.openPanel=openTextCollectionLibrary;',context);
  const panel=await context.openPanel({parent,resolveNamespace:async()=>'',isCurrent:()=>current});t.after(()=>panel.stop());
  const settle=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};await settle();
  const click=async button=>{await panel.element.emit('click',{target:button});await settle();};
  return {panel,calls,timers,page,settle,view,session,get closed(){return closed;},get changes(){return changes;},get rows(){return queries.get('[data-collection-list]').children;},get status(){return queries.get('[data-collection-status]').textContent;},
    setCurrent(value){current=value;},
    click:async action=>click(queries.get(`[data-collection-manage="${action}"]`)),
    choose:async id=>click(all.find(el=>el.isConnected&&el.dataset.collectionId===id)),
    async input(value){const input=queries.get('input');input.value=value;await input.emit('input');await settle();},
    async tick(){const [id,fn]=timers.entries().next().value;timers.delete(id);fn();await settle();}};
}
