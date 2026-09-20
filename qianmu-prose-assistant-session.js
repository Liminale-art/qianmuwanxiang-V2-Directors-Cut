import {captureProseAssistantContext} from './qianmu-prose-assistant-context.js';
import {PROSE_ASSISTANT_HISTORY_LIMITS,validateProseAssistantHistory} from './qianmu-prose-assistant-history-contract.js';

const {bytes,...sessionLimits}=PROSE_ASSISTANT_HISTORY_LIMITS;
export const PROSE_ASSISTANT_SESSION_LIMITS=Object.freeze(sessionLimits);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const unicode=text=>new TextDecoder().decode(new TextEncoder().encode(text))===text;

// A bounded in-memory conversation, not durable storage or a global session pool.
// The caller supplies an explicitly selected request adapter; no API is discovered here.
export function createProseAssistantSession({key,isCurrent,onChange=()=>{},initialHistory}={}){
  if(typeof key!=='string'||!key||key.length>4096||typeof isCurrent!=='function'||typeof onChange!=='function')fail('prose_assistant_setup','正文助手会话来源未就绪');
  const reference=value=>value===null?null:Object.freeze({...value,range:Object.freeze({...value.range})});
  const restored=initialHistory===undefined?[]:validateProseAssistantHistory(initialHistory,key).rows;
  const limits=PROSE_ASSISTANT_SESSION_LIMITS,rows=restored.map(row=>({...row,reference:reference(row.reference)}));
  let active=null,closed=false,characters=rows.reduce((n,row)=>n+row.user.length+row.assistant.length,0),nextId=rows.at(-1)?.id||0;
  const snapshot=()=>Object.freeze({key,rows:Object.freeze(rows.map(row=>Object.freeze({...row}))),busy:Boolean(active),characters});
  const publish=()=>{try{if(!closed&&isCurrent()===true)onChange(snapshot());}catch(_){/* View failures cannot change a model result or trigger another request. */}};
  function stop(){
    if(!active)return false;const run=active;active=null;run.row.status='cancelled';run.controller.abort();run.context?.close();publish();return true;
  }
  const close=()=>{closed=true;stop();rows.length=0;characters=0;};
  function checkLive(){if(closed)fail('prose_assistant_closed','正文助手会话已关闭');try{if(isCurrent()!==true)fail('prose_assistant_scope','正文助手账户或页面已变化');}catch(cause){close();throw cause;}}
  const history=()=>{checkLive();return Object.freeze({key,turns:Object.freeze(rows.filter(row=>row.status==='complete').map(row=>Object.freeze({user:row.user,assistant:row.assistant})))});};
  async function run({question,source,request}={}){
    checkLive();if(active)fail('prose_assistant_busy','请等待当前回复完成或先停止');
    if(typeof request!=='function'||typeof question!=='string'||!question.trim()||question.length>limits.question||question.includes('\0')||!unicode(question))fail('prose_assistant_input','请填写有效问题并选择明确的助手连接');
    if(rows.length>=limits.turns||characters+question.length>=limits.characters||nextId>=Number.MAX_SAFE_INTEGER)fail('prose_assistant_capacity','助手会话已达容量上限，请先复制需要的内容，再清空会话');
    const prior=history(),row={id:++nextId,user:question,assistant:'',status:'running',reference:null},token={row,controller:new AbortController(),context:null};
    rows.push(row);characters+=question.length;active=token;publish();
    function check(){checkLive();if(active!==token||token.controller.signal.aborted)fail('prose_assistant_cancelled','此轮助手回复已停止');token.context?.assertCurrent();}
    const update=text=>{
      check();if(typeof text!=='string'||text.includes('\0')||text.length>limits.reply||!text.startsWith(row.assistant)||characters+text.length-row.assistant.length>limits.characters)fail('prose_assistant_output','助手返回内容无效、不连续或超过会话容量');
      characters+=text.length-row.assistant.length;row.assistant=text;publish();
    };
    try{
      check();token.context=await captureProseAssistantContext({...source,history:prior,signal:token.controller.signal});check();
      if(token.context.key!==key)fail('prose_assistant_scope','引用来源不属于当前助手会话');
      const {floor,replyId,mode,range}=token.context.reference;row.reference=reference({floor,replyId,mode,range});
      const guard=async()=>{check();await token.context.guard();check();return true;};await guard();
      const result=await request(Object.freeze({context:token.context,question,signal:token.controller.signal,guard,onText:update}));
      await guard();if(typeof result!=='string'||!result.trim()||!unicode(result))fail('prose_assistant_output','助手未返回完整有效的回复');update(result);check();
      row.status='complete';active=null;publish();return Object.freeze({...row});
    }catch(cause){
      if(row.status==='running'){row.status='failed';if(active===token)active=null;token.controller.abort();publish();}
      throw cause;
    }finally{token.context?.close();token.context=null;}
  }
  return Object.freeze({key,run,history,view(){checkLive();return snapshot();},stop,clear(){checkLive();stop();rows.length=0;characters=0;nextId=0;publish();},close});
}
