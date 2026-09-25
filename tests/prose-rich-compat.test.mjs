import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {isRichProse, syncRichProseRuns, clearRichProseRuns, proseLayoutTargets, prepareRichProseRuns, clearProseBreakMarks, changedProseRoots} from '../qianmu-prose-rich-compat.js';

const css=await readFile(new URL('../style.css',import.meta.url),'utf8');

// The helper deliberately needs only basic DOM insertion/removal. This small fake
// verifies identity and order without importing a full browser DOM into tests.
function dom() {
  let mutations=0;
  const document={createElement:(tag)=>element(tag)};
  function element(tag, classes='') {
    const names=new Set(classes.split(/\s+/).filter(Boolean));
    const attrs=new Set(classes?['class']:[]);
    const node={nodeType:1,localName:tag.toLowerCase(),tagName:tag.toUpperCase(),ownerDocument:document,parentNode:null,childNodes:[],dataset:{},
      classList:{contains:name=>names.has(name),add:name=>{names.add(name);attrs.add('class');}},
      hasAttribute:name=>attrs.has(name),setAttribute:name=>attrs.add(name),
      get children(){return this.childNodes.filter(child=>child.nodeType===1);},
      get firstChild(){return this.childNodes[0]||null;},
      appendChild(child){return this.insertBefore(child,null);},
      insertBefore(child,before){
        if(child.parentNode){const prior=child.parentNode.childNodes;prior.splice(prior.indexOf(child),1);}
        const index=before?this.childNodes.indexOf(before):this.childNodes.length;
        assert.notEqual(index,-1);
        this.childNodes.splice(index,0,child);child.parentNode=this;mutations++;return child;
      },
      remove(){if(!this.parentNode)return;const siblings=this.parentNode.childNodes;siblings.splice(siblings.indexOf(this),1);this.parentNode=null;mutations++;},
      querySelector(selector){
        const matches=selector.split(',').map(item=>item.trim());
        const visit=(parent)=>{
          for(const child of parent.children){
            if(matches.some(item=>item==='style'&&child.localName==='style'
              ||item==='.np-min-card'&&child.classList.contains('np-min-card')
              ||item==='[data-sd-prose-exempt]'&&child.hasAttribute('data-sd-prose-exempt')))return child;
            const nested=visit(child);if(nested)return nested;
          }
          return null;
        };
        return visit(this);
      },
    };
    return node;
  }
  function text(value){return {nodeType:3,textContent:value,parentNode:null};}
  return {element,text,mutations:()=>mutations};
}

function flatten(message) {
  const visit=(node)=>node.nodeType===3?node.textContent
    :node.childNodes.map(visit).join('');
  return visit(message);
}

test('plain prose is untouched; mixed prose gets separate runs while card and style retain identity',()=>{
  const d=dom(),message=d.element('div'),before=d.element('p'),card=d.element('div','np-min-card'),style=d.element('style'),after=d.element('p');
  before.appendChild(d.text('before'));card.appendChild(d.text('card'));after.appendChild(d.text('after'));
  message.appendChild(before);
  const plainMutations=d.mutations();
  assert.deepEqual(syncRichProseRuns(message),[message]);
  assert.equal(d.mutations(),plainMutations);
  message.appendChild(card);message.appendChild(style);message.appendChild(after);
  const original=flatten(message),runs=syncRichProseRuns(message);
  assert.equal(isRichProse(message),true);
  assert.equal(message.dataset.sdProseMixed,'1');
  assert.equal(runs.length,2);
  assert.deepEqual(message.childNodes,[runs[0],card,style,runs[1]]);
  assert.equal(runs[0].childNodes[0],before);assert.equal(runs[1].childNodes[0],after);
  assert.equal(flatten(message),original);
  assert.equal(runs[0].dataset.sdProseRun,'1');
  const stable=d.mutations();
  assert.deepEqual(syncRichProseRuns(message),runs);
  assert.equal(d.mutations(),stable,'idempotent sync must not reparent existing runs');
});

test('direct text and br form prose runs, rich native blocks and explicit opt-outs stay outside',()=>{
  const d=dom(),message=d.element('div'),text=d.text('lead'),br=d.element('br'),card=d.element('div','np-min-card'),pre=d.element('pre'),tail=d.text('tail'),exempt=d.element('aside');
  exempt.setAttribute('data-sd-prose-exempt');
  [text,br,card,pre,tail,exempt].forEach(node=>message.appendChild(node));
  const runs=syncRichProseRuns(message);
  assert.equal(runs.length,2);
  assert.deepEqual(message.childNodes,[runs[0],card,pre,runs[1],exempt]);
  assert.deepEqual(runs[0].childNodes,[text,br]);
  assert.deepEqual(runs[1].childNodes,[tail]);
  assert.equal(pre.parentNode,message);assert.equal(exempt.parentNode,message);
});

test('new prose merges into adjacent run; removal of card restores original nodes and clears marker',()=>{
  const d=dom(),message=d.element('div'),card=d.element('div','np-min-card'),first=d.element('p'),later=d.element('p');
  first.appendChild(d.text('first'));later.appendChild(d.text('later'));
  message.appendChild(card);message.appendChild(first);
  const [run]=syncRichProseRuns(message);
  message.appendChild(later);
  assert.deepEqual(syncRichProseRuns(message),[run]);
  assert.deepEqual(run.childNodes,[first,later]);
  card.remove();
  assert.deepEqual(syncRichProseRuns(message),[message]);
  assert.deepEqual(message.childNodes,[first,later]);
  assert.equal(message.dataset.sdProseMixed,undefined);
  assert.equal(isRichProse(message),false,'run must not become a false rich detector');
});

test('a new card inserted inside an existing run is moved back to full-width top level',()=>{
  const d=dom(),message=d.element('div'),firstCard=d.element('div','np-min-card'),paragraph=d.element('p'),newCard=d.element('div','np-min-card');
  message.appendChild(firstCard);message.appendChild(paragraph);
  const [run]=syncRichProseRuns(message);
  run.appendChild(newCard);
  const [nextRun]=syncRichProseRuns(message);
  assert.deepEqual(message.childNodes,[firstCard,nextRun,newCard]);
  assert.deepEqual(nextRun.childNodes,[paragraph]);
});

test('a nested style and custom card container stay outside the prose column',()=>{
  const d=dom(),message=d.element('div'),paragraph=d.element('p'),container=d.element('div'),style=d.element('style');
  container.appendChild(style);message.appendChild(paragraph);message.appendChild(container);
  const [run]=syncRichProseRuns(message);
  assert.deepEqual(message.childNodes,[run,container]);
  assert.equal(run.childNodes[0],paragraph);
});

test('clear restores all original node identities and ordering when layout is disabled',()=>{
  const d=dom(),message=d.element('div'),a=d.text('a'),card=d.element('div','np-min-card'),style=d.element('style'),b=d.element('p');
  [a,card,style,b].forEach(node=>message.appendChild(node));
  syncRichProseRuns(message);
  clearRichProseRuns(message);
  assert.deepEqual(message.childNodes,[a,card,style,b]);
  assert.equal(message.dataset.sdProseMixed,undefined);
  assert.deepEqual(proseLayoutTargets(message),[message]);
});

test('CSS formats only owned prose runs within mixed messages',()=>{
  assert.match(css,/\.mes_text\[data-sd-prose-mixed="1"\]\s*>\s*\.sd-prose-run\[data-sd-prose-run="1"\]/);
  assert.match(css,/\.mes_text:not\(\[data-sd-prose-mixed="1"\]\)/);
  assert.match(css,/\.sd-prose-run\[data-sd-prose-run="1"\]\s*>\s*p/);
});

test('split-break formatting reaches ordinary mixed prose but never the sibling card',()=>{
  class Element {}
  const proseBreak={dataset:{},nextSibling:null,closest:()=>null,after:(...nodes)=>{assert.equal(nodes.length,2);}};
  const cardBreak={dataset:{}};
  const run={querySelectorAll:()=>[proseBreak]},message={querySelectorAll:()=>[cardBreak]};
  const context=vm.createContext({Element,document:{createElement:()=>({dataset:{},setAttribute(){}})},
    proseLayoutSettings:()=>({active:true,splitBreaks:true}),proseLayoutMessageRoots:()=>[message],proseLayoutTargets:()=>[run],proseLayoutClearBreakMarks:()=>{throw Error('must not clear active mixed prose');}});
  vm.runInContext(section('proseLayoutMarkBreaks'),context);
  context.proseLayoutMarkBreaks({});
  assert.equal(proseBreak.dataset.sdProseBreak,'1');
  assert.equal(cardBreak.dataset.sdProseBreak,undefined);
});

test('preparing a dynamically decorated floor clears old width once, then restores plain prose after card removal',()=>{
  const d=dom(),message=d.element('div'),paragraph=d.element('p'),card=d.element('div','np-min-card');
  message.appendChild(paragraph);let clears=0;
  prepareRichProseRuns([message],()=>{clears++;});
  assert.equal(clears,0);assert.deepEqual(message.childNodes,[paragraph]);
  message.appendChild(card);prepareRichProseRuns([message],()=>{clears++;});
  assert.equal(clears,1);assert.equal(message.dataset.sdProseMixed,'1');
  prepareRichProseRuns([message],()=>{clears++;});assert.equal(clears,1);
  card.remove();prepareRichProseRuns([message],()=>{clears++;});
  assert.equal(clears,2);assert.deepEqual(message.childNodes,[paragraph]);
});

test('observer schedules new and removed rich blocks but ignores owned line-break spacers and ordinary nested text',()=>{
  const d=dom(),message=d.element('div'),card=d.element('div','np-min-card'),paragraph=d.element('p');
  message.closest=()=>message;paragraph.closest=()=>message;
  const layout={splitBreaks:false,contentWidth:80};
  const changed=(target,addedNodes=[],removedNodes=[])=>[...changedProseRoots([{target,addedNodes,removedNodes}],layout)];
  assert.deepEqual(changed(message,[card]),[message]);
  assert.deepEqual(changed(paragraph,[card]),[message]);
  assert.deepEqual(changed(paragraph,[],[card]),[message]);
  assert.deepEqual(changed(paragraph,[d.text('ordinary')]),[]);
  const spacer=d.element('span');spacer.dataset.sdProseGap='1';
  assert.deepEqual(changed(message,[spacer]),[]);
});

test('clearing split-break marks removes only owned nodes and br marker',()=>{
  let removed=0,unset=0;
  const owned={remove:()=>removed++},br={removeAttribute:()=>unset++};
  const root={querySelectorAll:selector=>selector.startsWith('br')?[br]:[owned]};
  clearProseBreakMarks(root);
  assert.equal(removed,2);assert.equal(unset,1);
});
