import test from 'node:test';
import assert from 'node:assert/strict';
import {characterNativeFixture,namespace,document} from './helpers/character-native-fixture.mjs';
import {characterLegacyFixture,legacyPacket} from './helpers/character-legacy-fixture.mjs';
import {createCharacterReconciliation} from '../qianmu-character-reconciliation.js';
import {createCharacterArchiveController,renderCharacterArchive} from '../qianmu-character-archive-view.js';
import {readCharacterBackupFile} from '../qianmu-character-backup-file.js';

// Event/HTML protocol double, not a rendered browser or a visual acceptance.
function hostFixture(){
  let html='',nodes=[];const scroll={scrollTop:0};
  const host={isConnected:true,ownerDocument:new EventTarget(),closest:()=>scroll,contains:node=>nodes.includes(node),
    set innerHTML(value){html=value;nodes=[];
      for(const match of html.matchAll(/<(button|input|select|details)\b([^>]*)>/g)){
        const attrs=Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map(r=>[r[1],r[2]]));
        const data=Object.fromEntries(Object.entries(attrs).filter(([k])=>k.startsWith('data-')).map(([k,v])=>[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),v]));
        const listeners={};nodes.push({dataset:data,attrs,disabled:/\bdisabled\b/.test(match[2]),value:'',addEventListener:(type,fn)=>{listeners[type]=fn;},emit(type){listeners[type]?.({target:this,preventDefault(){},stopPropagation(){}});}});
      }
    },get innerHTML(){return html;},
    querySelectorAll(selector){const key=/^\[([^\]]+)\]$/.exec(selector)?.[1];return nodes.filter(node=>Object.hasOwn(node.attrs,key));},
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;},
    button(action){return nodes.find(node=>node.dataset.archiveAction===action);},choices(){return this.querySelectorAll('[data-archive-legacy-choice]');},
  };return host;
}
async function settled(host,predicate=()=>!host.innerHTML.includes('aria-busy="true"')){
  for(let i=0;i<400;i++){await new Promise(resolve=>setImmediate(resolve));if(predicate())return;}assert.fail('controller did not settle');
}
async function fixture(t,callbacks={}){
  const f=await characterNativeFixture(t),old=characterLegacyFixture(t,legacyPacket()),store=f.open();
  await store.createOnce(namespace,{id:'old-0',document:document('Remote <name>')},{isCurrent:()=>true});
  const job=createCharacterReconciliation({storage:f.storage,local:old.createLocal()});for(let i=0;i<10;i++){if((await job.step()).done)break;}job.close();
  const host=hostFixture(),notices=[];let account=namespace;
  const controller=createCharacterArchiveController({store,resolveNamespace:async()=>account,getContext:async()=>({chatKey:'test',subjects:[]}),notify:(text,kind)=>notices.push({text,kind}),...callbacks});
  t.after(()=>controller.dispose());controller.mount(host);await settled(host,()=>host.innerHTML.includes('核对旧资料')&&!host.innerHTML.includes('aria-busy="true"'));
  return {f,store,controller,host,notices,account:value=>{account=value;}};
}

test('actual controller presents review only for unresolved imports and loads complete comparison on user request',async t=>{
  const {host,f}=await fixture(t);assert.ok(host.button('legacy-open'));assert.equal(host.button('legacy-apply'),undefined);
  host.button('legacy-open').emit('click');await settled(host);assert.ok(host.innerHTML.includes('旧资料核对'));assert.equal(host.button('legacy-apply').disabled,true);
  f.reset();host.button('legacy-details').emit('click');await settled(host);assert.equal(f.originalReads,2);
  assert.match(host.innerHTML,/当前档案/);assert.match(host.innerHTML,/旧端完整原件/);assert.match(host.innerHTML,/Remote &lt;name&gt;/);assert.doesNotMatch(host.innerHTML,/<name>/);
});

test('actual backup button exports active and resolved/unresolved legacy sources together',async t=>{
  const files=[],prompts=[],{host,store}=await fixture(t,{confirm:async text=>{prompts.push(text);return true;},download:async file=>files.push(file)});
  host.button('backup-library').emit('click');await settled(host);assert.equal(files.length,1);
  const packet=await readCharacterBackupFile(files[0]);assert.equal(packet.schema,'qianmu.character.resources.v2');assert.deepEqual(packet.sources,await store.backupSources(namespace));
  assert.ok(prompts[0].includes('1 份完整旧端来源'));assert.ok(prompts[0].includes('不自动采用旧绑定'));assert.equal(packet.library.archives[0].document.name,'Remote <name>');
});

test('backup controller refuses a source changed after confirmation and does not download a mixed snapshot',async t=>{
  const files=[];let change;
  const f=await fixture(t,{confirm:async()=>{await change();return true;},download:async file=>files.push(file)});
  change=async()=>{await f.store.save(namespace,{document:document('Added during export')});};
  f.host.button('backup-library').emit('click');await settled(f.host);assert.equal(files.length,0);assert.match(f.host.innerHTML,/备份期间角色库或旧来源已变化/);
});

test('missing source binding can be selected only after explicitly choosing its associated archive',()=>{
  const conflicts=[{key:'archive:old',kind:'archive',id:'old',localName:'无',sourceName:'Old',localVersion:0,sourceVersion:1},
    {key:'binding:x',kind:'binding',sourceArchiveId:'old',category:'char',subjectKey:'char:old',scope:'default',chatKey:'',missing:true}];
  const before=renderCharacterArchive({legacyReview:{conflicts,choices:{},page:0},busy:false,error:''});
  const after=renderCharacterArchive({legacyReview:{conflicts,choices:{'archive:old':'source'},page:0},busy:false,error:''});
  assert.equal((before.match(/<option value="source"\s+disabled>/g)||[]).length,1);assert.doesNotMatch(after,/<option value="source"\s+disabled>/);
});

test('actual controller selections submit exact preview identity, clear pending badge and retain old source after keep-current',async t=>{
  const {host,store,notices}=await fixture(t);host.button('legacy-open').emit('click');await settled(host);
  const count=host.choices().length;
  for(let i=0;i<count;i++){const field=host.choices()[i];field.value='current';field.emit('change');}
  assert.equal(host.button('legacy-apply').disabled,false);host.button('legacy-apply').emit('click');await settled(host);
  assert.equal(host.button('legacy-open'),undefined);assert.equal(host.button('legacy-apply'),undefined);assert.deepEqual(await store.legacyImports(namespace),[]);
  assert.equal((await store.load(namespace,'old-0')).document.name,'Remote <name>');assert.ok(notices.some(row=>row.kind==='success'));
});

test('controller refuses stale review after a concurrent write and keeps the review visible for recheck',async t=>{
  const {host,store}=await fixture(t);host.button('legacy-open').emit('click');await settled(host);
  for(let i=0;i<host.choices().length;i++){const field=host.choices()[i];field.value='source';field.emit('change');}
  await store.save(namespace,{document:document('Other new record')});host.button('legacy-apply').emit('click');await settled(host);
  assert.match(host.innerHTML,/核对期间角色库已变化/);assert.ok(host.button('legacy-reload'));assert.equal((await store.load(namespace,'old-0')).document.name,'Remote <name>');
  host.button('legacy-reload').emit('click');await settled(host);assert.equal(host.button('legacy-apply').disabled,true);
});

test('closing review changes no data and account changes remove private review and choices',async t=>{
  const {host,f,account}=await fixture(t);host.button('legacy-open').emit('click');await settled(host);f.reset();host.button('legacy-close').emit('click');await settled(host);
  assert.equal(f.uploads,0);assert.ok(host.button('legacy-open'));host.button('legacy-open').emit('click');await settled(host);
  account('st-user:elsewhere');host.button('legacy-reload').emit('click');await settled(host);assert.doesNotMatch(host.innerHTML,/Remote|Legacy 0|旧端完整原件/);assert.equal(f.uploads,0);
});

test('review is bounded to 24 items per page, escapes names and disables unsafe adoption while leaving keep-current available',()=>{
  const conflicts=Array.from({length:25},(_,i)=>({key:`archive:${i}`,kind:'archive',id:String(i),localName:'<script>',sourceName:'Old',localVersion:1,sourceVersion:2,deleted:i===0}));
  const html=renderCharacterArchive({legacyReview:{conflicts,choices:{},page:0},busy:false,error:''});
  assert.equal([...html.matchAll(/data-archive-legacy-choice=/g)].length,24);assert.match(html,/legacy-next/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
  assert.match(html,/<option value="source"\s+disabled>/);assert.match(html,/<option value="current"/);
});

test('completed background changes refresh an idle list but never replace an open conflict review or detached panel',async t=>{
  const {host,store,controller,f}=await fixture(t);await store.save(namespace,{document:document('Fresh background')});
  host.ownerDocument.dispatchEvent(new Event('qianmu-character-library-changed'));await settled(host);assert.match(host.innerHTML,/Fresh background/);
  host.button('legacy-open').emit('click');await settled(host);const before=host.innerHTML;f.reset();host.ownerDocument.dispatchEvent(new Event('qianmu-character-library-changed'));await settled(host);
  assert.equal(host.innerHTML,before);assert.equal(f.calls.length,0);controller.detach();host.ownerDocument.dispatchEvent(new Event('qianmu-character-library-changed'));await settled(host);assert.equal(f.calls.length,0);
});
