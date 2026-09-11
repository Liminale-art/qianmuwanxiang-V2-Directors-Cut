// Shared scanner extracted from the existing storyboard package reader.
export function parseBoundedJson(text,{maxBytes,maxDepth=40,maxNodes=500000,label='JSON'}={}){
  const fail=message=>{throw Error(message.replaceAll('分镜包',label));};
  if([maxBytes,maxDepth,maxNodes].some(n=>!Number.isSafeInteger(n)||n<1))fail('分镜包读取上限无效');
  if(typeof text!=='string'||!text.length||text.length>maxBytes||new TextEncoder().encode(text).length>maxBytes)fail('分镜包为空或超过读取上限');
  const stack=[];let nodes=0;
  for(let at=0;at<text.length;at++){
    const char=text[at],parent=stack.at(-1);
    if(char==='"'){
      const start=at;let end=at;
      do{end=text.indexOf('"',end+1);if(end<0)fail('分镜包 JSON 不完整');let back=end-1;while(text[back]==='\\')back--;if((end-1-back)%2===0)break;}while(true);
      if(parent?.object&&parent.key){
        let name;try{name=JSON.parse(text.slice(start,end+1));}catch(_){fail('分镜包字段格式无效');}
        if(parent.keys.has(name))fail('分镜包含重复字段，未接受覆盖后的内容');
        if(['__proto__','prototype','constructor'].includes(name))fail('分镜包字段不安全');parent.keys.add(name);
      }at=end;
    }else if(char==='{'||char==='['){
      if(stack.length>=maxDepth||++nodes>maxNodes)fail('分镜包结构过深或过大');
      stack.push({object:char==='{',keys:new Set(),key:true});
    }else if(char==='}'||char===']')stack.pop();
    else if(char===':'&&parent)parent.key=false;
    else if(char===','&&parent){if(++nodes>maxNodes)fail('分镜包条目过多');parent.key=true;}
  }
  let payload;try{payload=JSON.parse(text);}catch(_){fail('分镜包 JSON 无效');}
  const finite=value=>{if(typeof value==='number'&&!Number.isFinite(value))fail('分镜包数值超出有效范围');if(value&&typeof value==='object')for(const item of Object.values(value))finite(item);};finite(payload);
  return payload;
}
