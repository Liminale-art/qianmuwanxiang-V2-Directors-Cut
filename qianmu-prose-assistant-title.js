const TITLE_LIMIT=40,TAIL_LIMIT=256;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalidTitle=/[<>\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const fail=message=>{throw Object.assign(new TypeError(message),{code:'prose_assistant_title_stream'});};

function insideFence(text,end){
  let fence=null;
  for(const line of text.slice(0,end).split('\n')){
    const match=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.replace(/\r$/,''));
    if(!match)continue;
    const [,,rest]=match,mark=match[1];
    if(!fence){if(mark[0]!=='`'||!rest.includes('`'))fence=mark;}
    else if(mark[0]===fence[0]&&mark.length>=fence.length&&/^[ \t]*$/.test(rest))fence=null;
  }
  return fence!==null;
}

// A one-response suffix protocol. No transport, history, or persistent naming state.
export function createProseAssistantTitleProtocol({id=globalThis.crypto.randomUUID()}={}){
  if(typeof id!=='string'||!UUID.test(id))fail('助手标题标识无效');
  const nonce=id.toLowerCase(),open=`[[qianmu-title:${nonce}]]`,close=`[[/qianmu-title:${nonce}]]`;
  const instruction=`完成正常回答后，请仅根据本次已提供的近期对话和当前问题，为这段对话取一个简短标题（1–40 个字符，单行，无 HTML 或控制字符）。在回答最末尾另起一行，严格追加 ${open}标题${close}；不要放进代码块，不再追加正文或解释。`;
  let previous='',visible='',finished=null;

  function trailer(text){
    let end=text.length;
    while(end>0&&text.length-end<TAIL_LIMIT&&/[ \t\r\n]/.test(text[end-1]))end--;
    const ending=text.slice(end);
    const start=end===0?0:text.lastIndexOf('\n',end-1)+1,line=text.slice(start,end);
    let cut=start?start-1:0;if(cut&&text[cut-1]==='\r')cut--;
    if(!line||cut<visible.length||text.length-cut>TAIL_LIMIT||!open.startsWith(line)&&!line.startsWith(open))return null;
    if(insideFence(text,start))return null;
    if(!line.startsWith(open))return ending?null:{cut,title:null};
    const raw=line.endsWith(close)?line.slice(open.length,-close.length):null;
    let title=null;
    if(raw!==null&&!invalidTitle.test(raw)){
      const trimmed=raw.trim();
      if(trimmed&&[...trimmed].length<=TITLE_LIMIT&&text.slice(0,cut).trim())title=trimmed;
    }
    if(!title&&/[\r\n]/.test(ending))return null;
    return {cut,title};
  }

  function accept(text){
    if(typeof text!=='string'||!text.startsWith(previous))fail('助手标题输出必须连续追加');
    if(finished&&text!==previous)fail('助手标题输出已经结束');
    previous=text;
  }

  function push(text){
    accept(text);if(finished)return finished.text;
    const pending=trailer(text);
    let cut=pending?.cut??text.length;
    // Keep only the next line boundary while its contents are still unknown.
    if(!pending&&text.endsWith('\n'))cut-=text.endsWith('\r\n')?2:1;
    else if(!pending&&text.endsWith('\r'))cut--;
    const next=text.slice(0,cut);
    if(!next.startsWith(visible))fail('助手标题不能撤回已经显示的正文');
    visible=next;return visible;
  }

  function finish(text){
    accept(text);if(finished)return finished;
    const suffix=trailer(text),result=suffix?.title?{text:text.slice(0,suffix.cut),title:suffix.title}:{text,title:null};
    if(!result.text.startsWith(visible))fail('助手标题不能撤回已经显示的正文');
    visible=result.text;finished=Object.freeze(result);return finished;
  }

  return Object.freeze({instruction,push,finish});
}
