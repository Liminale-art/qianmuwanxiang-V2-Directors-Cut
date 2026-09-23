const decode=value=>String(value).replace(/&(amp|lt|gt|quot|#39);/g,(_,key)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[key]));
export class ChoiceNode {
  constructor(dataset={}){this.dataset=dataset;this.isConnected=true;this.disabled=false;this.hidden=false;this.listeners={};this.attributes={};this.value='';this.textContent='';this.focused=0;}
  addEventListener(name,callback){(this.listeners[name]||=[]).push(callback);}
  setAttribute(name,value){this.attributes[name]=String(value);}
  focus(){this.focused++;}
  closest(selector){return selector==='[data-choice-id]'&&Object.hasOwn(this.dataset,'choiceId')?this:null;}
  fire(name='click',target=this){return Promise.all((this.listeners[name]||[]).map(callback=>callback({target,currentTarget:this})));}
}
export function createChoiceFrame(id){
  const frame=new ChoiceNode({galleryPicker:id}),nodes={};
  for(const selector of ['[data-choice-search]','[data-choice-list]','[data-choice-selected]','[data-choice-page="prev"]','[data-choice-page="next"]','[data-choice-page-label]','[data-choice-current]','[data-choice-error]'])nodes[selector]=new ChoiceNode();
  const list=nodes['[data-choice-list]'];list.buttons=[];
  Object.defineProperty(list,'innerHTML',{get(){return this.markup||'';},set(html){
    for(const button of this.buttons)button.isConnected=false;this.markup=html;
    this.buttons=[...html.matchAll(/<button\b([^>]*data-choice-id="([^"]*)"[^>]*)>([\s\S]*?)<\/button>/g)].map(match=>{
      const button=new ChoiceNode({choiceId:decode(match[2])});button.disabled=/\bdisabled\b/.test(match[1]);button.textContent=decode(match[3]);
      for(const [,name,value] of match[1].matchAll(/(aria-pressed|aria-checked)="([^"]*)"/g))button.setAttribute(name,value);return button;
    });
  }});
  list.querySelectorAll=()=>list.buttons;nodes['[data-choice-page-label]'].parentElement=new ChoiceNode();
  frame.querySelector=selector=>nodes[selector]||null;frame.contains=node=>frame.isConnected&&node.isConnected&&(Object.values(nodes).includes(node)||list.buttons.includes(node));
  const choose=id=>{const button=list.buttons.find(node=>node.dataset.choiceId===id);if(!button)throw Error('Missing visible choice '+id);return frame.fire('click',button);};
  return {frame,nodes,list,choose,search:async value=>{nodes['[data-choice-search]'].value=value;await nodes['[data-choice-search]'].fire('input');}};
}
export function createChoiceRoot(id){
  const choice=createChoiceFrame(id),root=new ChoiceNode();root.querySelectorAll=selector=>selector==='[data-gallery-picker]'?[choice.frame]:[];
  root.querySelector=()=>null;root.contains=node=>node===choice.frame||choice.frame.contains(node);
  return {...choice,root};
}
