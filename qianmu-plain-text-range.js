// Textarea values normalize CRLF to LF. Map UTF-16 offsets back to the original
// plain text without rewriting it or accepting half of an emoji surrogate pair.
export function createPlainTextRangeMapper(text){
  if(typeof text!=='string')throw new TypeError('选区来源须为纯文本');
  const boundaries=[];
  for(let index=0;index<text.length-1;index++){
    if(text[index]==='\r'&&text[index+1]==='\n'){boundaries.push({source:index+2,display:index+1-boundaries.length});index++;}
  }
  function offset(value,from,direction){
    const max=from==='source'?text.length:text.length-boundaries.length;
    if(!Number.isSafeInteger(value)||value<0||value>max)throw new RangeError('选区超出正文范围');
    let low=0,high=boundaries.length;
    while(low<high){const middle=(low+high)>>>1;if(boundaries[middle][from]<=value)low=middle+1;else high=middle;}
    return value+direction*low;
  }
  const isBoundary=value=>Number.isSafeInteger(value)&&value>=0&&value<=text.length&&!(value>0&&value<text.length
    &&text.charCodeAt(value-1)>=0xd800&&text.charCodeAt(value-1)<=0xdbff&&text.charCodeAt(value)>=0xdc00&&text.charCodeAt(value)<=0xdfff);
  return Object.freeze({toSource:value=>offset(value,'display',1),toDisplay:value=>offset(value,'source',-1),isBoundary});
}
