import {FOCUS_LIBRARY_MOMENTS,focusLibraryScope} from './qianmu-focus-library.js';

// Small text assets live with account settings; existing audio originals remain untouched.
export function createFocusDialogueLibrary({owner,legacy,save,random=Math.random,uid=()=>crypto.randomUUID()}) {
  let loading=null;
  async function load(){
    const account=owner();
    if(account.focusClock.dialogueLibrary)return account.focusClock.dialogueLibrary;
    if(loading?.account===account)return loading.promise;
    const promise=(async()=>{
      const originals=await legacy();
      if(owner()!==account)throw Error('账户已变化，请重新打开台词库');
      if(!account.focusClock.dialogueLibrary){
        const rows=originals.map(row=>({id:uid(),characterKey:row.characterKey,speaker:row.speaker,text:row.text,moments:[...row.moments]}));
        account.focusClock.dialogueLibrary={schema:1,revision:1,rows};save();
      }
      return account.focusClock.dialogueLibrary;
    })();
    loading={account,promise};try{return await promise;}finally{if(loading?.promise===promise)loading=null;}
  }
  function check(data){
    if(data?.schema!==1||!Number.isSafeInteger(data.revision)||data.revision<1||!Array.isArray(data.rows)||data.rows.length>512)throw Error('台词库格式异常，未改动原数据');
    return data;
  }
  async function snapshot(){return structuredClone(check(await load()));}
  async function change(expected,action){
    const account=owner(),data=check(await load());
    if(account!==owner()||account.focusClock.dialogueLibrary!==data||data.revision!==expected||data.revision===Number.MAX_SAFE_INTEGER)throw Error('台词库已变化，请重新打开条目');
    const next=structuredClone(data);action(next.rows);next.revision++;
    if(next.rows.length>512)throw Error('台词库已满，请先整理已有台词');
    account.focusClock.dialogueLibrary=next;save();return structuredClone(next);
  }
  async function put(value,expected){
    const {characterKey}=focusLibraryScope({namespace:'st-user:settings',characterKey:value.characterKey});
    const text=String(value.text||'').trim(),moments=[...new Set(value.moments||[])];
    if(!text||text.length>2000||!moments.length||moments.some(key=>!FOCUS_LIBRARY_MOMENTS.includes(key)))throw Error('请填写不超过 2000 字的台词并选择适用阶段');
    return change(expected,rows=>{
      const at=value.id?rows.findIndex(row=>row.id===value.id&&row.characterKey===characterKey):-1;
      if(value.id&&at<0)throw Error('此台词已被删除，请重新打开列表');
      const row={id:value.id||uid(),characterKey,speaker:String(value.speaker||'角色').slice(0,160),text,moments};
      if(at<0)rows.push(row);else rows[at]=row;
    });
  }
  const removeMany=(ids,expected)=>{
    if(!Array.isArray(ids)||!ids.length||ids.length>512||ids.some(id=>typeof id!=='string'||!id))throw Error('请先选择台词');
    const selected=new Set(ids);
    return change(expected,rows=>{
      if([...selected].some(id=>!rows.some(row=>row.id===id)))throw Error('所选台词已被删除，请刷新列表后重选');
      for(let index=rows.length-1;index>=0;index--)if(selected.has(rows[index].id))rows.splice(index,1);
    });
  };
  const remove=(id,expected)=>removeMany([id],expected);
  async function lines({characterKey,phase,specs,isCurrent=()=>true}){
    const data=await snapshot();if(!isCurrent())return [];
    let previous='';return specs.map(spec=>{
      const candidates=data.rows.filter(row=>row.characterKey===characterKey&&row.moments.includes(`${phase}:${spec.type}`));
      const alternatives=candidates.filter(row=>row.id!==previous),pool=alternatives.length?alternatives:candidates;
      if(!pool.length)return '';const sample=random();if(!Number.isFinite(sample)||sample<0||sample>=1)throw Error('台词抽取状态异常');
      const selected=pool[Math.floor(sample*pool.length)];previous=selected.id;return selected.text;
    });
  }
  return {snapshot,put,remove,removeMany,lines};
}
