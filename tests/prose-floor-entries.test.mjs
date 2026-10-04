import test from 'node:test';
import assert from 'node:assert/strict';
import {injectStoryboardMessageButtons} from '../qianmu-prose-floor-entries.js';

test('rendered prompt-excluded floors receive one explicit capture action without changing prompt flags or messages',()=>{
  const chat=[{mes:'visible'},{mes:'excluded',is_system:true}],before=JSON.stringify(chat),icons=[];
  // Narrow toolbar double; this test proves routing/idempotence, not browser layout.
  const messages=[0,1,2].map(floor=>({floor,buttons:[],querySelector(selector){
    if(selector==='.sd-storyboard-message-action')return this.buttons[0]||null;
    assert.equal(selector,'.mes_buttons .extraMesButtons, .mes_buttons .mes_buttons_inner, .mes_buttons');
    return {appendChild:button=>this.buttons.push(button)};
  }}));
  const root={querySelectorAll:selector=>{assert.equal(selector,'.mes');return messages;},ownerDocument:{createElement:tag=>{
    assert.equal(tag,'button');return {dataset:{},attrs:{},setAttribute(name,value){this.attrs[name]=value;}};
  }}};
  let busy=false;
  const api={floorOf:message=>message.floor,getContext:()=>({chat}),getState:()=>({}),planForMessage:()=>null,applyIcons:button=>icons.push(button),isBusy:floor=>busy&&floor===1};
  injectStoryboardMessageButtons(root,api);injectStoryboardMessageButtons(root,api);
  assert.deepEqual(messages.map(message=>message.buttons.length),[1,1,0]);assert.equal(icons.length,2);
  assert.equal(messages[1].buttons[0].dataset.storyboardChatAction,'capture-floor');
  assert.equal(messages[1].buttons[0].attrs['aria-label'],'提取第 1 层生成词');
  chat[1].is_system=false;injectStoryboardMessageButtons(root,api);chat[1].is_system=true;
  assert.equal(messages[1].buttons.length,1);assert.equal(JSON.stringify(chat),before);
  busy=true;injectStoryboardMessageButtons(root,api);
  assert.equal(messages[1].buttons[0].attrs['aria-busy'],'true');assert.match(messages[1].buttons[0].className,/is-generating/);
  assert.equal(messages[0].buttons[0].attrs['aria-busy'],'false');
  busy=false;injectStoryboardMessageButtons(root,api);
  assert.equal(messages[1].buttons[0].attrs['aria-busy'],'false');assert.doesNotMatch(messages[1].buttons[0].className,/is-generating/);
  assert.equal(icons.length,2);
});
