// Serial editor writes: never replace a live textarea or rebase over another editor.
export function createFocusDialogueAutosave({library,data,row,guard,onSaved=()=>{}}){
  let draft=structuredClone(row),version=0,written=0,pending=null,disposed=false;
  const check=async()=>{await guard();if(disposed)throw Error('台词编辑页已关闭');};
  function update(patch){if(disposed)return;draft={...draft,...structuredClone(patch)};version++;}
  async function drain(){
    while(written<version){
      await check();const target=version,value=structuredClone(draft);
      if(!value.id&&!value.text.trim()){written=target;continue;}
      const before=data,next=await library.put(value,data.revision);
      data=next;draft.id=value.id||next.rows.find(row=>!before.rows.some(old=>old.id===row.id))?.id;
      written=target;
      if(!disposed)onSaved(next);
    }
  }
  async function flush(){await (pending||=drain().finally(()=>{pending=null;}));if(written<version)await flush();}
  return {update,flush,dispose(){disposed=true;}};
}
