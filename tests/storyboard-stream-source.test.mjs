import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {captureStoryboardStreamFrame as frame,captureStoryboardCompilerSources as capture,openStoryboardCompilerContinuity as open,storyboardStableStreamBoundary as boundary} from '../qianmu-storyboard-compiler-sources.js';
import {borrowStoryboardStreamFrame} from '../qianmu-storyboard-stream-source.js?v=1.59.359';

const copy=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;return {promise:new Promise(yes=>{resolve=yes;}),resolve:value=>resolve(value)};};
function fixture(){
  const emitter=new EventEmitter();emitter.setMaxListeners(100);
  const context={chatId:'chat-a',characterId:0,characters:[{chat:'chat-a',avatar:'Alice.png'}],chatMetadata:{story_director_liminale:{}},eventSource:emitter,
    chat:[{mes:'USER asks about dinner.',send_date:'earlier',is_user:true},{mes:'Alice puts down her coat.\n\nShe reaches',send_date:'stream-start',gen_started:'start',name:'Alice',swipe_id:0}]};
  let epoch=0,account='st-user:alice',valid=true,lookup=null,saves=0;const reads=[];
  context.saveMetadata=async()=>saves++;
  const options={getContext:()=>context,epoch:()=>epoch,resolveNamespace:async()=>lookup?lookup():account,isCurrent:()=>valid,floor:1,referenceFloors:1,
    readText:(message,floor)=>{reads.push(floor);return message.mes;},readParagraphs:message=>message.mes.split(/\r?\n\s*\r?\n/).filter(text=>text.trim()).map((text,index)=>({id:`P${index+1}`,text}))};
  return {context,emitter,options,reads,get saves(){return saves;},set lookup(value){lookup=value;},set account(value){account=value;},set valid(value){valid=value;},bump:()=>epoch++,
    listeners:()=>emitter.eventNames().reduce((sum,type)=>sum+emitter.listenerCount(type),0)};
}

test('closed paragraph detection preserves exact LF/CRLF offsets and holds the unfinished tail or fenced block',()=>{
  for(const newline of ['\n','\r\n']){
    const first=`Alice cooks.${newline}${newline}`;
    assert.equal(boundary(first+'unfinished'),first.length);assert.equal(boundary('unfinished'),0);
    assert.equal(boundary(first+'```js'+newline+'unfinished'+newline+newline+'code'),first.length);
    const closed=first+'~~~txt'+newline+'words'+newline+'~~~'+newline+newline;
    assert.equal(boundary(closed+'next'),closed.length);
  }
  assert.equal(boundary('\n\n'),0);assert.equal(boundary('x'.repeat(200001)),0);
  assert.equal(boundary('Alice\rcooks.\n\nunfinished'),0);
});

test('the actual compiler window receives the complete snapshot, marks only closed paragraphs eligible, and tolerates append without host mutation',async()=>{
  const f=fixture(),original=copy(f.context.chat),snapshot=f.context.chat[1].mes,scope=await frame(f.options);
  assert.match(scope.proof.prefixDigest,/^[a-f0-9]{64}$/);assert.equal(scope.proof.prefixDigest,createHash('sha256').update(snapshot.slice(0,scope.proof.stableLength)).digest('hex'));
  f.context.chat[1].mes+=' for a cup.';
  const window=await capture({...f.options,streamFrame:scope});assert.deepEqual(f.reads,[0,1]);assert.equal(window.messages[1].text,snapshot);
  assert.deepEqual(window.paragraphs,['Alice puts down her coat.','She reaches']);assert.deepEqual(window.stream.stableParagraphIds,['P1']);
  f.context.chat[1].mes+='\n\nBob arrives.';assert.equal(window.assertCurrent(),true);await window.guard();
  assert.deepEqual(f.context.chat[0],original[0]);assert.equal(f.context.chat[1].mes,snapshot+' for a cup.\n\nBob arrives.');
  window.close();assert.equal(f.listeners(),0);assert.throws(scope.assertCurrent);await assert.rejects(window.guard());
});

for(const newline of ['\n','\r\n'])test(`host trimming terminal ${JSON.stringify(newline)} whitespace keeps the closed visible paragraph and original complete snapshot`,async()=>{
  const f=fixture(),text='Alice puts down her coat.',raw=text+` \t${newline} \t${newline}${newline}`;
  f.context.chat[1].mes=raw;
  const scope=await frame(f.options),window=await capture({...f.options,streamFrame:scope});
  assert.equal(scope.proof.stableLength,text.length);assert.equal(scope.proof.snapshotLength,raw.length);
  assert.deepEqual(window.stream.stableParagraphIds,['P1']);assert.equal(window.messages.at(-1).text,raw);
  f.context.chat[1].mes=raw.trimEnd();await window.guard();assert.equal(window.assertCurrent(),true);
  assert.equal(window.messages.at(-1).text,raw);assert.equal(f.saves,0);window.close();assert.equal(f.listeners(),0);
});

test('removing the paragraph separator before further prose invalidates the live frame, not just changed prefix letters',async()=>{
  for(const separator of ['', ' ', '\n', '\r\n']){
    const f=fixture(),scope=await frame(f.options);
    f.context.chat[1].mes='Alice puts down her coat.'+separator+'She reaches';
    assert.throws(scope.assertCurrent,{code:'storyboard_stream_source'});assert.equal(f.listeners(),0);
  }
});

test('tail cleanup while account resolution is pending does not require recapturing or shorten the input snapshot',async()=>{
  const f=fixture(),raw='Alice puts down her coat.\n\n',gate=deferred();let calls=0;
  f.context.chat[1].mes=raw;f.lookup=()=>++calls===1?gate.promise:'st-user:alice';
  const pending=frame(f.options);f.context.chat[1].mes=raw.trimEnd();gate.resolve('st-user:alice');
  const scope=await pending,window=await capture({...f.options,streamFrame:scope});
  assert.equal(window.messages.at(-1).text,raw);await window.guard();window.close();assert.equal(f.listeners(),0);
});

test('a partial frame may read prior state but cannot publish provisional events as a finished floor or invoke ST saving',async()=>{
  const f=fixture(),before=copy(f.context.chatMetadata),scope=await frame(f.options),window=await capture({...f.options,streamFrame:scope}),session=open(window);
  assert.equal((await session.read()).status,'ready');
  const proposal={floor:1,roster:{branches:[{id:'now',layer:'present'}],subjectIds:['Alice']},events:[{id:'coat',branchId:'now',paragraphId:'P1',subjectId:'Alice',category:'outfit',key:'coat',value:'off',persistence:'persistent',evidence:'Alice puts down her coat.'}]};
  assert.deepEqual(await session.publish([proposal]),{status:'deferred',reason:'streaming_source'});assert.equal(f.saves,0);assert.deepEqual(f.context.chatMetadata,before);
  await assert.rejects(session.publish([{...proposal,floor:99}]));await assert.rejects(session.publish([proposal,proposal]));
  await assert.rejects(session.publish([{...proposal,events:[{...proposal.events[0],evidence:'invented'}]}]));
  await assert.rejects(session.publish([{...proposal,unexpected:true}]));
  await assert.rejects(session.publish([{...proposal,roster:{...proposal.roster,paragraphs:[{id:'P1',text:'invented'}]}}]));
  session.close();await assert.rejects(session.publish([proposal]));await assert.rejects(session.read());window.close();assert.equal(f.listeners(),0);
});

for(const [name,mutate] of [
  ['prefix rewrite',f=>f.context.chat[1].mes='Bob'+f.context.chat[1].mes.slice(5)],
  ['swipe',f=>f.context.chat[1].swipe_id++],['role',f=>f.context.chat[1].is_user=true],['replacement',f=>f.context.chat[1]={...f.context.chat[1]}],
  ['new generation',f=>f.context.chat[1].gen_started='second-start'],['message identity',f=>f.context.chat[1].send_date='other'],
  ['epoch',f=>f.bump()],['disabled',f=>f.valid=false],['metadata replacement',f=>f.context.chatMetadata={}],
  ['chat changed and restored',f=>f.emitter.emit('chat_changed','other')],['message edit and restore',f=>f.emitter.emit('message_edited',1)],
  ['delete notification',f=>f.emitter.emit('message_deleted',0)],
])test(`${name} permanently invalidates a captured frame and releases every listener`,async()=>{
  const f=fixture(),scope=await frame(f.options),window=await capture({...f.options,streamFrame:scope});mutate(f);
  assert.throws(window.assertCurrent);assert.throws(scope.assertCurrent);assert.equal(f.listeners(),0);await assert.rejects(window.guard());
});

test('earlier complete floors remain strict even though the target can append',async()=>{
  const f=fixture(),scope=await frame(f.options),window=await capture({...f.options,streamFrame:scope});f.context.chat[0].mes+=' changed';
  assert.throws(window.assertCurrent);assert.equal(f.listeners(),0);
});

test('host balancing may change an unfinished tail without rewriting the already completed prefix',async()=>{
  const f=fixture();f.context.chat[1].mes='Alice cooks.\n\n"I think"';const scope=await frame(f.options),window=await capture({...f.options,streamFrame:scope});
  f.context.chat[1].mes='Alice cooks.\n\n"I think of yesterday';assert.equal(window.assertCurrent(),true);assert.deepEqual(window.stream.stableParagraphIds,['P1']);window.close();
});

test('account change during initial capture or later guard cannot revive a frame or leak listeners',async()=>{
  const initial=fixture(),gate=deferred();let calls=0;initial.lookup=async()=>++calls===1?gate.promise:'st-user:other';
  const capturing=frame(initial.options);gate.resolve('st-user:alice');await assert.rejects(capturing);assert.equal(initial.listeners(),0);
  const f=fixture(),scope=await frame(f.options),window=await capture({...f.options,streamFrame:scope});f.account='st-user:bob';await assert.rejects(window.guard());assert.equal(f.listeners(),0);
});

test('cancellation while identity is in flight discards the snapshot without a retained host view',async()=>{
  const f=fixture(),controller=new AbortController(),gate=deferred();f.lookup=()=>gate.promise;
  const pending=frame({...f.options,signal:controller.signal});controller.abort();gate.resolve('st-user:alice');await assert.rejects(pending);assert.equal(f.listeners(),0);
});

test('forged, foreign and already borrowed frames cannot enter a compiler window',async()=>{
  const f=fixture(),scope=await frame(f.options);
  await assert.rejects(capture({...f.options,streamFrame:{...scope}}));
  const other=fixture();await assert.rejects(capture({...other.options,streamFrame:scope}));
  const window=await capture({...f.options,streamFrame:scope});await assert.rejects(capture({...f.options,streamFrame:scope}));window.close();assert.equal(f.listeners(),0);assert.equal(other.listeners(),0);
});

test('missing stable blocks or durable message identity defer to the completed-floor flow, without guessing or truncating',async()=>{
  for(const kind of ['no-boundary','no-identity','oversize']){
    const f=fixture();if(kind==='no-boundary')f.context.chat[1].mes='unfinished';
    if(kind==='no-identity'){delete f.context.chat[1].send_date;delete f.context.chat[1].gen_started;}
    if(kind==='oversize')f.context.chat[1].mes='x'.repeat(200001)+'\n\n';
    if(kind==='oversize')await assert.rejects(frame(f.options),/超过单次容量/);else assert.equal(await frame(f.options),null);
    assert.deepEqual(f.reads,[]);assert.equal(f.listeners(),0);assert.equal(f.saves,0);
  }
});

test('inconsistent paragraph mapping never invents a stable cut',async()=>{
  const f=fixture(),scope=await frame(f.options);
  await assert.rejects(capture({...f.options,streamFrame:scope,readParagraphs:message=>[{id:'P1',text:message.mes}]}));assert.equal(f.listeners(),0);
});

test('the projected target and array are read-only, without freezing or mutating real ST data',async()=>{
  const f=fixture(),before=copy(f.context.chat),scope=await frame(f.options),borrowed=borrowStoryboardStreamFrame(scope,f.options),view=borrowed.getContext();
  assert.throws(()=>{view.chat[1].mes='changed';});assert.throws(()=>{view.chat[1].extra.gen_id='changed';});
  assert.throws(()=>{view.chat[1]={mes:'changed'};});assert.throws(()=>{view.chat.push({mes:'extra'});});
  assert.throws(()=>{delete view.chat[0];});assert.throws(()=>Object.defineProperty(view.chat,'1',{value:{}}));
  assert.deepEqual(f.context.chat,before);assert.equal(Object.isFrozen(f.context.chat[1]),false);assert.equal(Object.isFrozen(f.context.chat),false);
  borrowed.close();assert.throws(borrowed.getContext);assert.equal(f.listeners(),0);
});

test('host lookup failure after listener acquisition releases the original host scope',async()=>{
  const f=fixture(),read=f.options.getContext;let reads=0;
  await assert.rejects(frame({...f.options,getContext:()=>{if(++reads===2)throw new Error('host unavailable');return read();}}),/host unavailable/);
  assert.equal(f.listeners(),0);
});

test('closing a deferred publication while its identity check is pending cannot return a usable result',async()=>{
  const f=fixture(),scope=await frame(f.options),window=await capture({...f.options,streamFrame:scope}),session=open(window),gate=deferred();
  f.lookup=()=>gate.promise;
  const publishing=session.publish([{floor:1,roster:{branches:[],subjectIds:[]},events:[]}]);
  session.close();gate.resolve('st-user:alice');await assert.rejects(publishing);window.close();assert.equal(f.listeners(),0);assert.equal(f.saves,0);
});

test('high-floor streaming capture reads only the selected bounded range, not every earlier message',async()=>{
  const f=fixture(),target=f.context.chat[1];f.context.chat=Array.from({length:10000},(_,index)=>({mes:'older '+index,send_date:String(index)}));f.context.chat[9999]=target;f.options.floor=9999;f.options.referenceFloors=2;
  const scope=await frame(f.options),window=await capture({...f.options,streamFrame:scope});assert.deepEqual(f.reads,[9997,9998,9999]);assert.equal(window.sources.length,3);window.close();assert.equal(f.listeners(),0);
});
