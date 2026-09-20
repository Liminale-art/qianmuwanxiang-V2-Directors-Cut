import {normalizeProseAssistantSelection} from './qianmu-prose-assistant-request.js';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=()=>{throw Object.assign(new Error('助手设置或来源已变化，请重新打开后保存'),{code:'prose_assistant_preferences'});};

// Host `persist` is a synchronous scheduling callback, NOT a durable receipt.
// Credential-bearing copies live only here/the dedicated settings, never in results.
export async function saveProseAssistantConnection({selection,referenceFloors,current,persist,guard,isCurrent}={}){
  if(typeof current!=='function'||typeof persist!=='function'||typeof guard!=='function'||typeof isCurrent!=='function')fail();
  if(referenceFloors!==undefined&&(!Number.isSafeInteger(referenceFloors)||referenceFloors<1||referenceFloors>9))fail();
  const owner=current();if(!object(owner)||isCurrent()!==true)fail();
  const previous=owner.proseAssistant,had=Object.hasOwn(owner,'proseAssistant');
  if(previous!==undefined&&!object(previous))fail();
  const baseline=JSON.stringify(previous),selected=normalizeProseAssistantSelection(selection,owner.apiProfiles);
  if(await guard()!==true||current()!==owner||isCurrent()!==true||owner.proseAssistant!==previous||JSON.stringify(previous)!==baseline)fail();
  // Recheck the chosen preset after the asynchronous identity check.
  const value=normalizeProseAssistantSelection(selected,owner.apiProfiles),next={...previous,selection:structuredClone(value),...(referenceFloors===undefined?{}:{referenceFloors})};
  let touched=false,requested=false;
  try{
    owner.proseAssistant=next;touched=true;requested=true;persist();
    return Object.freeze({status:'applied',persistence:'requested'});
  }catch(_){
    if(!touched)return Object.freeze({status:'rejected',persistence:'not-requested'});
    if(current()!==owner||owner.proseAssistant!==next)return Object.freeze({status:'incomplete',persistence:'uncertain'});
    try{if(had)owner.proseAssistant=previous;else delete owner.proseAssistant;if(requested)persist();}
    catch(_){return Object.freeze({status:'incomplete',persistence:'uncertain'});}
    return Object.freeze({status:'reverted',persistence:'uncertain'});
  }
}
