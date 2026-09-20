import {readModelResponse} from './qianmu-model-response.js';
import {normalizeQianmuChatApiRoot} from './qianmu-llm-output.js';
import {assertPortableConnectionUrl} from './qianmu-portable-connection.js';

const failure=(code,message)=>Object.assign(new Error(message),{code});
const fail=message=>{throw failure('prose_assistant_connection',message);};
const field=(value,max)=>typeof value==='string'&&value.trim()&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
function connection(selection,profiles){
  if(!selection||!['st-proxy','direct'].includes(selection.transport??'st-proxy'))fail('场外特助连接配置无效');
  let row;
  if(selection.mode==='profile'){
    if(!field(selection.profileId,512)||!Array.isArray(profiles))fail('请选择场外特助API预设');
    const matches=profiles.filter(item=>item?.id===selection.profileId);if(matches.length!==1)fail('场外特助预设已失效或编号重复，请重新选择');row=matches[0];
  }else if(selection.mode==='custom')row=selection.connection;else fail('场外特助尚未选择专用连接，不会借用其他API');
  if(!row||!field(row.apiUrl,4096)||!field(row.apiKey,8192)||!field(row.model,512))fail('请补全场外特助的地址、Key与模型');
  try{assertPortableConnectionUrl(row.apiUrl);if(new URL(row.apiUrl).search)fail('场外特助地址不支持查询参数，请使用独立Key输入框');}catch(_){fail('场外特助地址须为不含内嵌凭据、查询参数或片段的HTTP(S)地址');}
  const temperature=row.temperature??0.75,maxTokens=row.maxTokens??0,stream=row.stream??true;
  if(!Number.isFinite(temperature)||temperature<0||temperature>2||!Number.isSafeInteger(maxTokens)||maxTokens<0||maxTokens>1000000||typeof stream!=='boolean')fail('场外特助生成参数无效');
  let apiUrl=normalizeQianmuChatApiRoot(row.apiUrl);if(new URL(apiUrl).pathname==='/')apiUrl+='/v1';
  return Object.freeze({apiUrl,apiKey:row.apiKey.trim(),model:row.model.trim(),temperature,maxTokens,stream});
}
// Explicit preference capture shares request validation but never sends a request.
export function normalizeProseAssistantSelection(selection,profiles){
  const cfg=connection(selection,profiles);
  return Object.freeze(selection.mode==='profile'
    ? {mode:'profile',profileId:selection.profileId,transport:selection.transport??'st-proxy'}
    : {mode:'custom',transport:selection.transport??'st-proxy',connection:cfg});
}
function messagesFrom(value){
  if(!Array.isArray(value)||!value.length||value.length>64)fail('场外特助消息编译未就绪');let size=0;
  return value.map(row=>{
    if(!row||!['system','user','assistant'].includes(row.role)||typeof row.content!=='string'||!row.content.trim()||row.content.includes('\0')||new TextDecoder().decode(new TextEncoder().encode(row.content))!==row.content||(size+=row.content.length)>300000)fail('场外特助消息无效或超过本次容量');
    return {role:row.role,content:row.content};
  });
}

// Create on explicit send: credentials stay in this short-lived closure, never in
// a conversation, review object or error. The formal prompt compiler is injected.
export function createProseAssistantRequest({selection,profiles,compileMessages,getRequestHeaders,fetchImpl=globalThis.fetch,timeoutMs=120000}={}){
  const cfg=connection(selection,profiles),transport=selection.transport??'st-proxy';
  if(typeof compileMessages!=='function'||typeof fetchImpl!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000||transport==='st-proxy'&&typeof getRequestHeaders!=='function')fail('场外特助请求环境尚未就绪');
  const review=Object.freeze({mode:selection.mode,profileId:selection.mode==='profile'?selection.profileId:null,transport,model:cfg.model,stream:cfg.stream});
  async function send({context,question,signal,guard,onText}={}){
    if(typeof guard!=='function'||typeof onText!=='function')fail('场外特助缺少来源校验或回复接收器');
    const controller=new AbortController();let timedOut=false,status=0;
    const abort=()=>controller.abort(),timer=setTimeout(()=>{timedOut=true;abort();},timeoutMs);
    const check=async()=>{if(controller.signal.aborted)throw failure('prose_assistant_cancelled','场外特助请求已停止');if(await guard()!==true)throw failure('prose_assistant_scope','场外特助来源已变化');if(controller.signal.aborted)throw failure('prose_assistant_cancelled','场外特助请求已停止');return true;};
    try{
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();await check();
      const messages=messagesFrom(await compileMessages({context,question}));await check();
      const fetchOnce=async(url,options)=>{await check();const response=await fetchImpl(url,{...options,redirect:'error',cache:'no-store',credentials:transport==='st-proxy'?'same-origin':'omit'});status=response.status;return response;};
      const body={model:cfg.model,messages,temperature:cfg.temperature,stream:cfg.stream};if(cfg.maxTokens>0)body.max_tokens=cfg.maxTokens;
      let endpoint=`${cfg.apiUrl}/chat/completions`,headers={Authorization:`Bearer ${cfg.apiKey}`,'Content-Type':'application/json'};
      if(transport==='st-proxy'){
        Object.assign(body,{chat_completion_source:'custom',custom_url:cfg.apiUrl,reverse_proxy:'',proxy_password:'',custom_include_headers:`Authorization: Bearer ${cfg.apiKey}`});
        endpoint='/api/backends/chat-completions/generate';headers={...getRequestHeaders(),'Content-Type':'application/json'};
      }
      // Unlike the legacy external wrapper's forced /v1, preserve an explicitly
      // supplied version/path. Both routes share this exact target and decoder.
      const response=await fetchOnce(endpoint,{method:'POST',headers,body:JSON.stringify(body),signal:controller.signal});
      const result=await readModelResponse(response,{stream:cfg.stream,signal:controller.signal,guard:check,onDelta:onText});return result.text;
    }catch(cause){
      // Upstream error bodies/URLs/keys and raw transport are deliberately not retained.
      const code=timedOut?'timeout':controller.signal.aborted?'cancelled':status>=400?'http':cause?.code==='MODEL_OUTPUT_INCOMPLETE'?'incomplete':String(cause?.code||'').startsWith('prose_assistant_')?'scope':'request';
      const message={timeout:'场外特助请求超时，未自动重试',cancelled:'场外特助请求已停止',http:`场外特助请求失败（HTTP ${status}），未切换连接或重试`,incomplete:'场外特助回复未完整结束，半截内容未纳入历史',scope:'场外特助来源或消息配置已变化，未继续请求',request:'场外特助连接或响应异常，未切换连接或重试'}[code];
      throw failure(`prose_assistant_${code}`,message);
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
  }
  return Object.freeze({review,send});
}
