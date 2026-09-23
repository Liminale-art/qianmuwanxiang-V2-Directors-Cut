// Verified immutable UTF-8 file bytes, not decoded receipt JSON, browser heap,
// directory history, abandoned uploads, other modules or total VPS disk usage.
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const fail=()=>{throw Object.assign(Error('费用原件计值尚未完整核对'),{code:'vibe_receipt_accounting'});};
const scope='registered-fee-original-files';
// The persisted catalogue is at most 8 MiB. Every version contains multiple
// hashes and a full immutable reference (>128 bytes), so this loose bound does
// not impose a smaller capacity than the catalogue itself.
const fileLimit=513,byteLimit=513*1024,versionLimit=65536;
export function validateVibeReceiptFileUsage(value,selectedVersions){
  if(!value||Object.keys(value).length!==8||value.version!==1||value.scope!==scope||!integer(value.versions)||value.versions>versionLimit
    ||value.selectedVersions!==selectedVersions||!integer(selectedVersions)||selectedVersions>18432||value.versions<selectedVersions||(value.versions===0)!==(selectedVersions===0))fail();
  for(const part of [value.total,value.selected,value.history]){
    if(!part||Object.keys(part).length!==2||!integer(part.count)||!integer(part.bytes)||(part.count===0)!==(part.bytes===0)||part.bytes<part.count||part.count>value.versions*fileLimit||part.bytes>part.count*byteLimit)fail();
  }
  if(value.total.count!==value.selected.count+value.history.count||value.total.bytes!==value.selected.bytes+value.history.bytes
    ||value.selected.count<selectedVersions||value.total.count<value.versions||value.selected.count>selectedVersions*fileLimit)fail();
  if(value.complete!==true)fail();
  return {version:1,scope,complete:true,versions:value.versions,selectedVersions,total:{...value.total},selected:{...value.selected},history:{...value.history}};
}
export function createVibeReceiptFileAccounting(){
  const originals=new Map(),files=new Map();let owner='';
  return {
    verified({digest,files:references}){
      if(typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest)||!Array.isArray(references)||references.length<2||references.length>fileLimit||references[0]?.slot!=='vibe-receipt-original'||references.slice(1).some(ref=>ref?.slot!=='vibe-receipt-part'))fail();
      const keys=[];
      for(const reference of references){
        if(!['vibe-receipt-original','vibe-receipt-part'].includes(reference?.slot)||!/^[a-f0-9]{64}$/.test(reference.scope)||!/^[a-f0-9]{64}$/.test(reference.fingerprint)||!integer(reference.bytes)||!reference.bytes||reference.bytes>byteLimit)fail();
        if(owner&&owner!==reference.scope)fail();owner=reference.scope;
        const key=JSON.stringify([reference.scope,reference.slot,reference.fingerprint]);if(files.has(key)&&files.get(key)!==reference.bytes)fail();files.set(key,reference.bytes);keys.push(key);
      }
      const unique=[...new Set(keys)].sort(),prior=originals.get(digest);if(prior&&JSON.stringify(prior)!==JSON.stringify(unique))fail();originals.set(digest,unique);
    },
    summarize(selectedDigests,expectedVersions){
      if(!Array.isArray(selectedDigests)||new Set(selectedDigests).size!==selectedDigests.length||originals.size!==expectedVersions)fail();
      const selected=new Set();for(const digest of selectedDigests){const refs=originals.get(digest);if(!refs)fail();for(const key of refs)selected.add(key);}
      const total={count:files.size,bytes:[...files.values()].reduce((a,b)=>a+b,0)},active={count:selected.size,bytes:[...selected].reduce((n,key)=>n+files.get(key),0)};
      return validateVibeReceiptFileUsage({version:1,scope,complete:true,versions:originals.size,selectedVersions:selectedDigests.length,total,selected:active,history:{count:total.count-active.count,bytes:total.bytes-active.bytes}},selectedDigests.length);
    },
  };
}
