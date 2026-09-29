const tags=['p','br','hr','h1','h2','h3','h4','h5','h6','strong','b','em','i','del','s','ul','ol','li','blockquote','pre','code','table','thead','tbody','tfoot','tr','th','td','a'];

// Use the host's Markdown libraries. Only a sanitized, non-interactive fragment
// reaches the conversation; missing libraries leave the original text readable.
export function renderProseAssistantMarkdown(element,text,{libs=globalThis.SillyTavern?.libs}={}){
 const raw=String(text??'');
 try{
  if(typeof libs?.showdown?.Converter!=='function'||typeof libs?.DOMPurify?.sanitize!=='function')throw Error('Markdown unavailable');
  const converter=new libs.showdown.Converter({simpleLineBreaks:true,tables:true,strikethrough:true,literalMidWordUnderscores:true,ghCodeBlocks:true});
  const fragment=libs.DOMPurify.sanitize(converter.makeHtml(raw),{
   ALLOWED_TAGS:[...tags],ALLOWED_ATTR:['href','title','start'],ALLOW_ARIA_ATTR:false,ALLOW_DATA_ATTR:false,
   ALLOWED_URI_REGEXP:/^(?:https?:\/\/|mailto:)/i,RETURN_DOM_FRAGMENT:true,
   FORBID_CONTENTS:['script','style','iframe','object','embed','svg','math','form','button','textarea','select','option'],
  });
  if(fragment?.nodeType!==11||typeof fragment.querySelectorAll!=='function')throw Error('Markdown fragment unavailable');
  for(const link of fragment.querySelectorAll('a')){
   let protocol;try{protocol=new URL(link.getAttribute('href')||'').protocol;}catch{}
   if(!['http:','https:','mailto:'].includes(protocol)){link.removeAttribute('href');link.removeAttribute('target');link.removeAttribute('rel');continue;}
   link.setAttribute('rel','noopener noreferrer');
   if(protocol==='mailto:')link.removeAttribute('target');else link.setAttribute('target','_blank');
  }
  element.replaceChildren(fragment);return true;
 }catch{
  element.textContent=raw;return false;
 }
}
