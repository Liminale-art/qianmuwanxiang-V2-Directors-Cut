import {galleryRecordFingerprintText} from './qianmu-gallery-record-fingerprint.js';
import {sha256} from './vendor/noble-hashes-2.4.0/sha2.js';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const utf8=new TextEncoder(),capture=value=>galleryRecordFingerprintText(value).text;
const fingerprint=record=>record===null?null:sha256(utf8.encode(capture(record)));
const same=(left,right)=>left===null?right===null:right!==null&&left.every((value,index)=>value===right[index]);
const fail=()=>{throw Error('原画面或镜头资料已变化，请重新打开；未使用其他计划替代');};

// One selected consumer, not a hot-gallery cache or migration. The caller owns
// host/account scope; its scoped recipe reader remains the only archive reader.
export function createGalleryShotReader(record,{readSnapshot,readLegacy=()=>null,isCurrent}={}){
  if(record!==null&&!object(record)||typeof readSnapshot!=='function'||typeof readLegacy!=='function'||typeof isCurrent!=='function')fail();
  const original=fingerprint(record);
  const assertCurrent=()=>{if(isCurrent()!==true||!same(fingerprint(record),original))fail();return true;};
  return Object.freeze({assertCurrent,async read(){
    assertCurrent();let shot;
    if(object(record?.shotSpec))shot=record.shotSpec;
    else if(record?.recipeUnavailable===true)shot=null;
    else if(record&&(record.snapshot||record.snapshotServerRef||record.snapshotRef)){
      const snapshot=await readSnapshot(record);assertCurrent();
      // A known original without a shot is still authoritative. Never borrow a
      // current plan when the original is missing, fails, or has no shotSpec.
      shot=snapshot?.shotSpec??null;
    }else shot=readLegacy();
    assertCurrent();
    if(shot===null||shot===undefined)return null;
    if(!object(shot))fail();
    return JSON.parse(capture({shot})).shot; // Whole detached JSON, including unknown fields.
  }});
}
