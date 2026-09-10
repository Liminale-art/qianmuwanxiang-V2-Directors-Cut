import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

function fixture(){
  const state={},characters=[],personas=[],notices=[],applied=[],popups=[];
  const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  const host={POPUP_TYPE:{CONFIRM:7}},wrap={innerHTML:'',querySelector:()=>({value:'picked'})};let resolve;
  host.Popup=class{constructor(...args){popups.push(args);}show(){return new Promise(done=>resolve=done);}};
  const c=vm.createContext({coread:()=>state,coreadCompanionChoices:()=>characters,coreadPersonaChoices:()=>personas,htmlEscape:escape,
    ctx:()=>host,readerView:null,document:{createElement:()=>wrap},toast:(...args)=>notices.push(args),
    coreadApplyIdentityChoice:async(...args)=>applied.push(args)});
  vm.runInContext(['renderCoreadIdentity','renderCoreadIdentityChoices','coreadChooseIdentity'].map(section).join('\n'),c);
  return {c,state,characters,personas,host,wrap,notices,applied,popups,answer:value=>resolve(value)};
}

test('identity avatars retain selectable reader and read-only archive forms without mutating inputs',()=>{
  const {c}=fixture();
  for(const kind of ['', 'char','user']){
    const html=c.renderCoreadIdentity('role<&','name"<&','image"<&','fa-user',kind);
    assert.match(html,/role&lt;&amp;/);assert.match(html,/title="name&quot;&lt;&amp;"/);assert.match(html,/src="image&quot;&lt;&amp;"/);
    if(kind)assert.match(html,new RegExp(`<button type="button"[^>]*data-coread-identity="${kind}"`));
    else {assert.doesNotMatch(html,/<button|data-coread-identity/);assert.match(html,/<span class="sd-reader-identity-avatar"/);}
  }
  assert.doesNotMatch(c.renderCoreadIdentity('role','name','','fa-user'),/<img/);
});

test('identity choices preserve saved keys, follow mode, fallback names and bounded list height',()=>{
  const e=fixture();
  for(const n of [0,1,2,7,12]){
    e.characters.splice(0,99,...Array.from({length:n},(_,i)=>({data:{avatar:`key${i}`,name:`name${i}`}})));
    assert.match(e.c.renderCoreadIdentityChoices('char'),new RegExp(`size="${Math.min(8,Math.max(3,n+1))}"`));
  }
  e.characters.splice(0,99,{data:{avatar:'key"<&'}},{avatar:'second',name:'<name>'});e.state.companionOverrideAvatar='key"<&';
  e.personas.push({key:'user<&',name:'User<&'});e.state.personaOverrideAvatar='user<&';const before=JSON.stringify(e.state);
  const char=e.c.renderCoreadIdentityChoices('char'),user=e.c.renderCoreadIdentityChoices('user');
  assert.match(char,/>选择书友</);assert.match(char,/value="key&quot;&lt;&amp;" selected>未命名角色/);
  assert.match(user,/>选择人设</);assert.match(user,/value="user&lt;&amp;" selected>User&lt;&amp;/);
  assert.equal(JSON.stringify(e.state),before);e.state.companionOverrideAvatar='';
  assert.match(e.c.renderCoreadIdentityChoices('char'),/value="" selected>跟随当前聊天/);
});

test('identity popup accepts host confirmation variants and applies only to the original reader',async()=>{
  for(const answer of [true,1,'1',false,0,''])for(const replaced of [false,true]){
    const e=fixture(),run=e.c.coreadChooseIdentity('user');
    assert.equal(e.popups[0][0],e.wrap);assert.equal(e.popups[0][1],7);assert.equal(e.popups[0][3].okButton,'选择');
    if(replaced)e.c.readerView={bookId:'new'};e.answer(answer);await run;
    assert.deepEqual(e.applied,!replaced&&[true,1,'1'].includes(answer)?[['user','picked']]:[]);assert.deepEqual(e.notices,[]);
  }
});

test('unavailable or failed popup stays non-mutating and reports a concise warning',async()=>{
  for(const failure of ['missing','throw']){
    const e=fixture();if(failure==='missing')delete e.host.Popup;else e.host.Popup=class{constructor(){throw Error('host failure');}};
    await e.c.coreadChooseIdentity('char');assert.deepEqual(e.applied,[]);assert.equal(e.notices.length,1);assert.equal(e.notices[0][1],'warning');
  }
});
