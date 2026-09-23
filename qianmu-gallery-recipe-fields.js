import {galleryRecordFingerprintText} from './qianmu-gallery-record-fingerprint.js';
import {sha256} from './vendor/noble-hashes-2.4.0/sha2.js';

const text=value=>galleryRecordFingerprintText({value}).text;
const utf8=new TextEncoder(),fingerprint=record=>sha256(utf8.encode(galleryRecordFingerprintText(record).text));
const same=(a,b)=>a.length===b.length&&a.every((value,index)=>value===b[index]);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=()=>{throw Error('原画面的来源信息尚不能等价移出，原配方保持内联');};
function editable(record){
  if(!Object.getOwnPropertyDescriptor(record,'snapshot')?.configurable)fail();
  for(const name of ['chatKey','snapshotRef','snapshotVersion','snapshotServerRef']){
    const field=Object.getOwnPropertyDescriptor(record,name);if(field?!field.writable:!Object.isExtensible(record))fail();
  }
}

// Not a storage receipt or deletion grant. Called ONLY after the caller has
// confirmed the complete server recipe and immutable local copy, before host save.
// shotSpec stays resident for legacy synchronous consumers; original files stay.
export function prepareGalleryRecipeFieldRelease(record,snapshot,metadata){
  if(!object(record)||!object(snapshot)||typeof metadata!=='function')fail();
  const inline=Object.getOwnPropertyDescriptor(record,'snapshot');
  if(!inline||!Object.hasOwn(inline,'value')||inline.value!==snapshot||!inline.configurable)fail();
  const captured=fingerprint(record); // Complete validation, but retain only 32 bytes across this batch.
  editable(record);
  const original=metadata(record),expected=text(original),candidate={...record};delete candidate.snapshot;
  for(const name of ['compiledPrompt','compositionDecision']){
    const field=Object.getOwnPropertyDescriptor(record,name);
    if(field?.configurable&&field.writable&&object(field.value)&&Object.hasOwn(snapshot,name)
      &&text(field.value)===text(snapshot[name]))delete candidate[name];
  }
  // A historical image may store provenance only inside its inline recipe.
  // Add only absent lightweight fields; never overwrite an existing/unknown one.
  if(text(metadata(candidate))!==expected){
    if(!Object.hasOwn(record,'productionContext'))candidate.productionContext=original.production;
    if(original.decision&&!Object.hasOwn(record,'directorDecision'))candidate.directorDecision=original.decision;
  }
  if(text(metadata(candidate))!==expected)fail();
  galleryRecordFingerprintText(candidate);
  const changes=[];
  for(const name of ['compiledPrompt','compositionDecision','productionContext','directorDecision']){
    const before=Object.getOwnPropertyDescriptor(record,name),present=Object.hasOwn(candidate,name);
    if(present===Boolean(before)&&(!present||candidate[name]===before.value))continue;
    if(before&&!before.configurable||!before&&!Object.isExtensible(record))fail();
    changes.push({name,before,present,value:candidate[name],fingerprint:present?text(candidate[name]):null});
  }
  let applied=false;
  return Object.freeze({
    apply(){
      if(applied||!same(fingerprint(record),captured))fail();
      editable(record);
      for(const change of changes){const now=Object.getOwnPropertyDescriptor(record,change.name);
        if(Boolean(now)!==Boolean(change.before)||now&&(now.value!==change.before.value||now.configurable!==change.before.configurable||now.writable!==change.before.writable))fail();}
      if(text(metadata(record))!==expected)fail();
      for(const change of changes){if(change.present)Object.defineProperty(record,change.name,{value:change.value,enumerable:true,writable:true,configurable:true});else delete record[change.name];}
      applied=true;
    },
    rollback(){
      if(!applied)return;applied=false;
      for(const change of changes){
        const now=Object.getOwnPropertyDescriptor(record,change.name);
        // A newer edit owns its field, including edits in place to added metadata.
        if(change.present){if(!now||!Object.hasOwn(now,'value')||now.value!==change.value||!now.configurable||!now.writable||!now.enumerable)continue;
          try{if(text(now.value)!==change.fingerprint)continue;}catch{continue;}}
        else if(now||!Object.isExtensible(record))continue;
        if(change.before)Object.defineProperty(record,change.name,change.before);else delete record[change.name];
      }
    },
  });
}
