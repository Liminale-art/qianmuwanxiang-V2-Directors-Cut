// Local writing aids. These functions never choose a generation target or invoke a model.
const clean=value=>String(value??'').trim();
export function storyboardTagContent(tag){
  return clean(tag?.content)||clean(tag?.renderings?.novel)||clean(Object.values(tag?.renderings||{}).find(value=>clean(value)))||clean(tag?.naturalLanguage)||clean(tag?.name);
}
export function storyboardTagText(tag,source='novel'){
  return clean(tag?.renderings?.[source])||(source!=='novel'?clean(tag?.naturalLanguage):'')||storyboardTagContent(tag);
}
export function storyboardTagSpans(value){
  const text=String(value??''),spans=[],stack=[];let start=0,quote='',weight=0;
  const pairs={'(':')','[':']','{':'}','<':'>'};
  for(let i=0;i<text.length;i++){
    const char=text[i];if(char==='\\'){i++;continue;}
    if(quote){if(char===quote)quote='';continue;}
    if(char==='"'||(char==="'"&&(!i||/[\s,，([{]/.test(text[i-1])))){quote=char;continue;}
    if(char===':'&&text[i+1]===':'){
      let numberStart=i;while(numberStart>start&&/[\d.+-]/.test(text[numberStart-1]))numberStart--;
      if((numberStart===start||/[\s,，([{]/.test(text[numberStart-1]))&&/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text.slice(numberStart,i)))weight++;
      else weight=weight?weight-1:1;
      i++;continue;
    }
    if(pairs[char])stack.push(pairs[char]);else if(char===stack.at(-1))stack.pop();
    if(!stack.length&&!weight&&/[,，\n\r]/.test(char)){spans.push({start,end:i,text:text.slice(start,i)});start=i+1;}
  }
  spans.push({start,end:text.length,text:text.slice(start)});return spans;
}
export function validateStoryboardTagContent(name,content){
  const label=clean(name),text=clean(content);
  if(label.length>100||text.length>6000)throw Error('组名或内容超过长度上限');
  if(!text)throw Error('请填写可复用内容');
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(label+text))throw Error('内容含无效控制字符');
  if(!label&&storyboardTagSpans(text).filter(part=>part.text.trim()).length>1)throw Error('多词组合请填写组名，或拆成单个 Tag 保存');
  return {name:label,content:text};
}
export function createStoryboardTagIndex(items,source='novel'){
  return (items||[]).map(item=>{const value=storyboardTagText(item,source);return {item,value,label:clean(item.name)||value,search:[...new Set([item.name,value,storyboardTagContent(item),...(item.aliases||[])].filter(Boolean))].join('\n').toLocaleLowerCase()};}).filter(row=>row.value);
}
export function searchStoryboardTags(index,{query='',category='all',sort='recent',polarity='all',offset=0,limit=40}={}){
  const words=clean(query).toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const rows=index.filter(row=>(category==='all'||row.item.category===category)&&(polarity==='all'||(row.item.positive===false?'negative':'positive')===polarity)&&words.every(word=>row.search.includes(word)));
  rows.sort((a,b)=>(sort==='used'?Number(b.item.usageCount||0)-Number(a.item.usageCount||0):0)||Number(b.item.createdAt||0)-Number(a.item.createdAt||0)||String(a.item.id).localeCompare(String(b.item.id)));
  return {total:rows.length,rows:rows.slice(offset,offset+limit)};
}

// Match only the edited leaf, keeping surrounding emphasis/weights and unrelated prose intact.
export function storyboardTagFragment(value,start,end=start,{format='tags'}={}){
  const text=String(value??'');start=Math.max(0,Math.min(text.length,start));end=Math.max(start,Math.min(text.length,end));
  if(end>start)return {start,end,query:text.slice(start,end),selected:true};
  const boundary=(i)=>/[,，\n\r()\[\]{}<>]/.test(text[i])||(format==='natural'&&/[\s。！？!?；;]/.test(text[i]))||(text[i]===':'&&(text[i-1]===':'||text[i+1]===':'));
  let left=start,right=start;while(left>0&&!boundary(left-1))left--;while(right<text.length&&!boundary(right))right++;
  while(left<start&&/\s/.test(text[left]))left++;
  const weight=/\s*:\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)\s*$/.exec(text.slice(left,right));
  if(weight&&left+weight.index>=start)right=left+weight.index;
  while(right>start&&/\s/.test(text[right-1]))right--;
  return {start:left,end:right,query:text.slice(left,start).trim(),selected:false};
}
function canonical(value){
  let text=clean(value);
  for(let count=0;count<8;count++){
    const previous=text;
    if(/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)::[\s\S]*::$/.test(text))text=text.replace(/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)::/,'').slice(0,-2).trim();
    else if(/^\([\s\S]*:\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)\)$/.test(text))text=text.slice(1,-1).replace(/:\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/,'').trim();
    else if((text[0]==='{'&&text.at(-1)==='}')||(text[0]==='['&&text.at(-1)===']'))text=text.slice(1,-1).trim();
    if(text===previous)break;
  }
  return text.replace(/\s+/g,' ').toLocaleLowerCase();
}
export function insertStoryboardTag(value,start,end,insertion,{format='tags',maxLength=12000}={}){
  const text=String(value??''),content=clean(insertion),range=storyboardTagFragment(text,start,end,{format});
  if(!content)return {changed:false,reason:'empty',value:text,start,end};
  if(format==='tags'&&storyboardTagSpans(text).some(part=>canonical(part.text)===canonical(content)))return {changed:false,reason:'duplicate',value:text,start,end};
  const suffix=text.slice(range.end),tail=!suffix?(format==='tags'?', ':' '):'';
  const result=text.slice(0,range.start)+content+tail+suffix,caret=range.start+content.length+tail.length;
  if(result.length>maxLength)return {changed:false,reason:'limit',value:text,start,end};
  return {changed:result!==text,value:result,start:caret,end:caret,replaceStart:range.start,replaceEnd:range.end,insert:content+tail};
}
