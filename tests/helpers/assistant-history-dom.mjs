// DOM/event double, not real browser layout or ST acceptance evidence.
export function assistantHistoryDom(){
 const observers=new Set(),events=new EventTarget(),doc={activeElement:null,visibilityState:'visible'};
 class Element{
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.attrs={};this.dataset={};this.listeners=new Map();this.parentNode=null;this.ownerDocument=doc;this._text='';this.disabled=false;this.hidden=false;this.open=false;this.className='';this.classList={add:value=>{this.className+=(this.className?' ':'')+value;}};}
  get isConnected(){return this===doc.documentElement||this.parentNode?.isConnected===true;}
  set textContent(value){this._text=String(value);for(const node of this.children)node.parentNode=null;this.children=[];}
  get textContent(){return this._text+this.children.map(node=>node.textContent).join('');}
  append(...nodes){for(const node of nodes){node.remove();node.parentNode=this;this.children.push(node);}}
  replaceChildren(...nodes){this.textContent='';this.append(...nodes);}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(node=>node!==this);this.parentNode=null;}
  setAttribute(name,value){this.attrs[name]=String(value);}
  getAttribute(name){return this.attrs[name]??null;}
  addEventListener(name,handler){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(handler);}
  removeEventListener(name,handler){this.listeners.get(name)?.delete(handler);}
  emit(name,extra={}){for(const handler of this.listeners.get(name)||[])handler({target:this,preventDefault(){},stopPropagation(){},...extra});}
  focus(){doc.activeElement=this;}
  click(){this.emit('click');}
  showModal(){this.open=true;}
  close(){this.open=false;this.emit('close');}
  querySelectorAll(){return [];}
 }
 doc.createElement=tag=>new Element(tag);doc.createElementNS=(namespace,tag)=>new Element(tag);doc.documentElement=new Element('html');doc.head=new Element('head');doc.body=new Element('body');doc.documentElement.append(doc.head,doc.body);
 const all=(root=doc.body)=>root.children.flatMap(node=>[node,...all(node)]),get=label=>all().find(node=>node.attrs['aria-label']===label);
 doc.querySelector=selector=>selector==='link[data-qm-assistant-manager-style]'?all(doc.head).find(node=>Object.hasOwn(node.attrs,'data-qm-assistant-manager-style'))||null:null;
 doc.defaultView={MutationObserver:class{constructor(fn){this.fn=fn;}observe(){observers.add(this);}disconnect(){observers.delete(this);}},addEventListener:(...args)=>events.addEventListener(...args),removeEventListener:(...args)=>events.removeEventListener(...args),AbortController};
 const parent=new Element('section');doc.body.append(parent);
 return {doc,parent,all,get,mutate:()=>{for(const observer of [...observers])observer.fn();},events,observers,
  status:()=>all().find(node=>node.attrs.role==='status'),async wait(predicate){for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,2));}throw Error('DOM double did not settle');},
  idle(){return this.wait(()=>all().some(node=>node.tagName==='DIALOG'&&node.attrs['aria-busy']==='false'));}};
}
