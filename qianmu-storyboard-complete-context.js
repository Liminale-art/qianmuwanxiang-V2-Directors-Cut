// Complete user-selected context goes only to the configured extraction API.
// Reject oversize input before sending; never substitute a shortened story.
export const STORYBOARD_INPUT_MAX_BYTES=1024*1024;
export const completeStoryboardText=value=>String(value??'').trim();
export function completeStoryboardParagraphs(value,{document=globalThis.document,clean=completeStoryboardText}={}){
 const template=document.createElement('template');template.innerHTML=String(value??'').replace(/<br\s*\/?>/gi,'\n');
 const content=template.content;
 content.querySelectorAll('script,style,think,thinking,iframe,svg,video,audio,button').forEach(node=>node.remove());
 content.querySelectorAll('p,div,li,blockquote,pre,tr,h1,h2,h3,h4,h5,h6').forEach(node=>{node.before('\n');node.after('\n');});
 return String(content.textContent||'').split(/\r?\n/).map(clean).filter(Boolean);
}
export function assertStoryboardInputBudget(value){
 const bytes=new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(value)).byteLength;
 if(bytes>STORYBOARD_INPUT_MAX_BYTES)throw Object.assign(new Error('取景上下文超过单次安全容量，未发送、未截断。请减少参考楼层、所选世界书或取景预设内容。'),{code:'storyboard_input_capacity',bytes});
 return value;
}
