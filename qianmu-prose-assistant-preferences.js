import {normalizeProseAssistantSelection} from './qianmu-prose-assistant-request.js';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=()=>{throw Object.assign(new Error('助手设置或来源已变化，请重新打开后保存'),{code:'prose_assistant_preferences'});};

// Drafts share the existing credential-redacted selection field. They are never
// used for a request until the strict request adapter validates the connection.
function incompleteSelection(value,profiles){
  if(value===null)return null;
  if(!object(value)||!['profile','custom'].includes(value.mode))fail();
  if(value.mode==='profile'){
    if(typeof value.profileId!=='string'||!profiles?.some(row=>row?.id===value.profileId))fail();
    return {mode:'profile',profileId:value.profileId,transport:'st-proxy'};
  }
  if(!object(value.connection))fail();const connection={};
  for(const [field,max] of [['apiUrl',4096],['apiKey',8192],['model',512]]){
    const text=value.connection[field]??'';if(typeof text!=='string'||text.length>max||/[\u0000-\u001f\u007f]/.test(text)||new TextDecoder().decode(new TextEncoder().encode(text))!==text)fail();connection[field]=text;
  }
  for(const field of ['temperature','maxTokens','stream'])if(Object.hasOwn(value.connection,field))connection[field]=value.connection[field];
  if(connection.temperature!==undefined&&(!Number.isFinite(connection.temperature)||connection.temperature<0||connection.temperature>2)||connection.maxTokens!==undefined&&(!Number.isSafeInteger(connection.maxTokens)||connection.maxTokens<0||connection.maxTokens>1000000)||connection.stream!==undefined&&typeof connection.stream!=='boolean')fail();
  return {mode:'custom',transport:'st-proxy',connection};
}

// Host `persist` is a synchronous scheduling callback, NOT a durable receipt.
// Credential-bearing copies live only here/the dedicated settings, never in results.
export async function saveProseAssistantConnection({selection,referenceFloors,systemPrompt,allowIncomplete=false,current,persist,guard,isCurrent}={}){
  if(typeof current!=='function'||typeof persist!=='function'||typeof guard!=='function'||typeof isCurrent!=='function')fail();
  if(referenceFloors!==undefined&&(!Number.isSafeInteger(referenceFloors)||referenceFloors<0||referenceFloors>9))fail();
  if(systemPrompt!==undefined&&(typeof systemPrompt!=='string'||systemPrompt.length>20000||systemPrompt.includes('\0')||new TextDecoder().decode(new TextEncoder().encode(systemPrompt))!==systemPrompt))fail();
  const owner=current();if(!object(owner)||isCurrent()!==true)fail();
  const previous=owner.proseAssistant,had=Object.hasOwn(owner,'proseAssistant');
  if(previous!==undefined&&!object(previous))fail();
  const normalize=allowIncomplete?incompleteSelection:normalizeProseAssistantSelection;
  const baseline=JSON.stringify(previous),selected=normalize(selection,owner.apiProfiles);
  if(await guard()!==true||current()!==owner||isCurrent()!==true||owner.proseAssistant!==previous||JSON.stringify(previous)!==baseline)fail();
  // Recheck the chosen preset after the asynchronous identity check.
  const value=normalize(selected,owner.apiProfiles),next={...previous,selection:structuredClone(value),...(referenceFloors===undefined?{}:{referenceFloors}),...(systemPrompt===undefined?{}:{systemPrompt})};
  let touched=false,requested=false;
  try{
    owner.proseAssistant=next;touched=true;requested=true;await persist();
    return Object.freeze({status:'applied',persistence:'requested'});
  }catch(_){
    if(!touched)return Object.freeze({status:'rejected',persistence:'not-requested'});
    if(current()!==owner||owner.proseAssistant!==next)return Object.freeze({status:'incomplete',persistence:'uncertain'});
    try{if(had)owner.proseAssistant=previous;else delete owner.proseAssistant;if(requested)await persist();}
    catch(_){return Object.freeze({status:'incomplete',persistence:'uncertain'});}
    return Object.freeze({status:'reverted',persistence:'uncertain'});
  }
}

// Serial, latest-draft debounce. Explicit close/send can flush; failures retain
// the pending revision and never claim that the latest user input was saved.
export function createProseAssistantAutosave({read,save,isCurrent,onStatus=()=>{},delayMs=350}={}){
  if(typeof read!=='function'||typeof save!=='function'||typeof isCurrent!=='function')fail();
  let revision=0,saved=0,timer=null,active=null,closed=false,failed=false;
  const state=()=>Object.freeze({dirty:revision!==saved,saving:!!active,failed});
  const report=()=>{if(!closed)onStatus(state());};
  function flush(){
    clearTimeout(timer);timer=null;if(closed)return Promise.resolve(false);if(active)return active;
    active=Promise.resolve().then(async()=>{
      while(revision!==saved){if(closed||isCurrent()!==true)return false;const target=revision,draft=read(),result=await save(draft);
        if(closed||isCurrent()!==true)return false;if(result?.status!=='applied')throw Error('unconfirmed');saved=target;failed=false;
      }return true;
    }).catch(()=>{failed=true;return false;}).finally(()=>{active=null;report();});report();return active;
  }
  return Object.freeze({change(){if(closed)return;revision++;failed=false;clearTimeout(timer);timer=setTimeout(()=>void flush(),delayMs);report();},flush,state,close(){closed=true;clearTimeout(timer);timer=null;}});
}
