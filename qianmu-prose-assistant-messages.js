import {PROSE_ASSISTANT_CONTEXT_LIMITS as limits} from './qianmu-prose-assistant-context.js';
import {PROSE_ASSISTANT_SOURCE_LIMIT} from './qianmu-prose-assistant-source.js';

const fail=message=>{throw Object.assign(new Error(message),{code:'prose_assistant_messages'});};
const text=(value,max)=>typeof value==='string'&&value.trim()&&value.length<=max&&!value.includes('\0')&&new TextDecoder().decode(new TextEncoder().encode(value))===value;
const floor=value=>Number.isSafeInteger(value)&&value>=0;

// This defines input formatting, not the assistant's formal system prompt.
// Fictional characters remain quoted data, never conversation/system roles.
export function compileProseAssistantMessages({context,question,systemPrompt}={}){
  if(typeof systemPrompt!=='string'||systemPrompt.length>20000||systemPrompt.includes('\0')||new TextDecoder().decode(new TextEncoder().encode(systemPrompt))!==systemPrompt)fail('场外特助人格前置词格式无效');
  if(!text(question,20000)||typeof context?.assertCurrent!=='function')fail('场外特助问题或引用未就绪');context.assertCurrent();
  const ref=context.reference;
  if(ref!==null&&(!ref||!floor(ref.floor)||!['selection','floor'].includes(ref.mode)||!text(ref.text,PROSE_ASSISTANT_SOURCE_LIMIT)))fail('场外特助引用格式无效');
  if(!Array.isArray(context.previous)||context.previous.length>limits.maxPreviousFloors||!Array.isArray(context.history)||context.history.length>limits.historyPairs)fail('场外特助上下文范围无效');
  if(ref===null&&context.previous.length)fail('关闭正文参考时不可混入前文');
  let previousFloor=-1,previousCharacters=0,historyCharacters=0;
  const previous=context.previous.map(row=>{
    if(!row||!floor(row.floor)||row.floor<=previousFloor||row.floor>=ref.floor||!['user','character'].includes(row.role)||!text(row.text,limits.previousCharacters)||(previousCharacters+=row.text.length)>limits.previousCharacters)fail('场外特助参考前文顺序或容量无效');
    previousFloor=row.floor;return {floor:row.floor,speaker:row.role,text:row.text};
  });
  const messages=systemPrompt.trim()?[{role:'system',content:systemPrompt}]:[];
  for(const pair of context.history){
    if(!pair||!text(pair.user,limits.historyCharacters)||!text(pair.assistant,limits.historyCharacters)||(historyCharacters+=pair.user.length+pair.assistant.length)>limits.historyCharacters)fail('场外特助近期问答无效');
    messages.push({role:'user',content:pair.user},{role:'assistant',content:pair.assistant});
  }
  // Explicit allowlist: account/chat keys, host metadata, credentials, world data,
  // unselected prose and internal callbacks cannot be serialized by accident.
  messages.push({role:'user',content:JSON.stringify({type:'qianmu-prose-assistant-input',version:1,
    reference:ref===null?null:{floor:ref.floor,mode:ref.mode,text:ref.text},previous,question})});
  if(messages.reduce((sum,row)=>sum+row.content.length,0)>300000)fail('场外特助本次消息过长，请缩小引用范围');
  context.assertCurrent();return Object.freeze(messages.map(row=>Object.freeze(row)));
}
