import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {isRichProse, syncRichProseRuns, clearRichProseRuns, proseLayoutTargets, prepareRichProseRuns, clearProseBreakMarks, changedProseRoots, syncDropCap, dropCapStart} from '../qianmu-prose-rich-compat.js';

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
      querySelectorAll(selector){
        const keys=selector.split(',').map(item=>item.trim().match(/^\[data-([a-z-]+)="1"\]$/)?.[1]).filter(Boolean).map(key=>key.replace(/-([a-z])/g,(_,c)=>c.toUpperCase()));
        const found=[];const visit=(parent)=>{for(const child of parent.children){if(keys.some(key=>child.dataset[key]==='1'))found.push(child);visit(child);}};
        visit(this);return found;
      },
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
  assert.deepEqual(message.childNodes,[runs[0],card,runs[1]]);
  assert.equal(runs[0].childNodes[0],before);assert.deepEqual(runs[1].childNodes,[style,after]);
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

test('a paragraph whose inline annotation carries a style tag stays in the prose run',()=>{
  const d=dom(),message=d.element('div'),first=d.element('p'),noted=d.element('p'),span=d.element('span','tn'),style=d.element('style'),last=d.element('p');
  first.appendChild(d.text('first'));noted.appendChild(d.text('lead'));noted.appendChild(span);noted.appendChild(style);noted.appendChild(d.text('tail'));last.appendChild(d.text('last'));
  [first,noted,last].forEach(node=>message.appendChild(node));
  const runs=syncRichProseRuns(message);
  assert.equal(message.dataset.sdProseMixed,'1');
  assert.equal(runs.length,1);
  assert.deepEqual(runs[0].childNodes,[first,noted,last]);
  assert.equal(style.parentNode,noted,'the style tag itself is never moved out of its paragraph');
});

test('a top-level style lifted out by markdown never splits prose, and a style alone is not wrapped',()=>{
  const d=dom(),message=d.element('div'),first=d.element('p'),lifted=d.element('style'),opened=d.element('p'),lone=d.element('style'),card=d.element('div','np-min-card');
  first.appendChild(d.text('first'));opened.appendChild(d.text('opened by an annotation'));
  [first,lifted,opened,card,lone].forEach(node=>message.appendChild(node));
  const runs=syncRichProseRuns(message);
  assert.equal(runs.length,1);
  assert.deepEqual(runs[0].childNodes,[first,lifted,opened]);
  assert.deepEqual(message.childNodes,[runs[0],card,lone]);
});

function spacers(d){const gap=d.element('span'),indent=d.element('span');gap.dataset.sdProseGap='1';indent.dataset.sdProseIndent='1';return [gap,indent];}

test('drop cap skips a wrapper tag followed by line breaks and folds those breaks only',()=>{
  // Shape seen on a real floor: status card, then <p><content><br>…<br>…text</content></p>.
  const d=dom(),message=d.element('div'),run=d.element('div','sd-prose-run'),style=d.element('style'),first=d.element('p'),content=d.element('content'),second=d.element('p');
  run.dataset.sdProseRun='1';
  const br1=d.element('br'),br2=d.element('br'),[g1,i1]=spacers(d),[g2,i2]=spacers(d),midBreak=d.element('br');
  [d.text('\n'),br1,g1,i1,d.text(' '),br2,g2,i2,d.text('正午的日头'),midBreak,d.text('第二行')].forEach(node=>content.appendChild(node));
  first.appendChild(content);second.appendChild(d.text('第二段'));
  [style,first,second].forEach(node=>run.appendChild(node));message.appendChild(run);
  assert.equal(syncDropCap(message,[run]),first);
  assert.equal(first.dataset.sdProseDrop,'1');
  for(const node of [br1,g1,i1,br2,g2,i2]) assert.equal(node.dataset.sdProseLead,'1');
  assert.equal(midBreak.dataset.sdProseLead,undefined,'a break after the first character is ordinary text flow');
  assert.equal(second.dataset.sdProseDrop,undefined);
  assert.equal(syncDropCap(message,null),null);
  assert.equal(first.dataset.sdProseDrop,undefined);assert.equal(br1.dataset.sdProseLead,undefined);
});

test('drop cap passes over empty paragraphs and headings, but not body text outside a paragraph',()=>{
  const d=dom(),message=d.element('div'),heading=d.element('h2'),empty=d.element('p'),body=d.element('p');
  heading.appendChild(d.text('第一章'));empty.appendChild(d.element('br'));body.appendChild(d.text('正文'));
  [heading,empty,body].forEach(node=>message.appendChild(node));
  assert.equal(syncDropCap(message,[message]),body);
  const loose=d.element('div'),later=d.element('p');later.appendChild(d.text('后一段'));
  loose.appendChild(d.text('裸露的正文'));loose.appendChild(later);
  assert.equal(syncDropCap(loose,[loose]),null,'never push the drop cap down to what is really the second paragraph');
});

test('drop cap start finds the first visible character, the glyph past quotes, and where the first visual paragraph ends',()=>{
  const d=dom(),p=d.element('p'),content=d.element('content'),lead=d.element('br'),q=d.element('q'),text=d.text('“你来晚了。”'),stop=d.element('br');
  q.appendChild(text);[d.text('\n'),lead,q,stop,d.text('她没有回头。')].forEach(node=>content.appendChild(node));p.appendChild(content);
  const start=dropCapStart(p);
  assert.equal(start.node,text);assert.equal(start.offset,0);assert.equal(start.letter,'你');assert.equal(start.stop,stop);
  const plain=d.element('p');plain.appendChild(d.text('  雨。'));
  assert.deepEqual([dropCapStart(plain).offset,dropCapStart(plain).letter,dropCapStart(plain).stop],[2,'雨',null]);
  const empty=d.element('p');empty.appendChild(d.element('br'));
  assert.equal(dropCapStart(empty),null);
});

test('drop cap mark moves with the first paragraph and is not rewritten when unchanged',()=>{
  const d=dom(),message=d.element('div'),a=d.element('p'),b=d.element('p');
  a.appendChild(d.text('甲'));b.appendChild(d.text('乙'));message.appendChild(a);message.appendChild(b);
  syncDropCap(message,[message]);const stable=d.mutations();
  assert.equal(syncDropCap(message,[message]),a);assert.equal(d.mutations(),stable);
  a.remove();
  assert.equal(syncDropCap(message,[message]),b);assert.equal(b.dataset.sdProseDrop,'1');
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
