
// The real ST emitter replays APP_READY, including to listeners registered
// after startup. A DOM-ready flag or an initial account flag is insufficient.
export function readySource(initial=false){
  const rows=new Map();let emitted=initial;
  return {on(type,fn){let set=rows.get(type);if(!set)rows.set(type,set=new Set());set.add(fn);if(type==='APP_READY'&&emitted)fn();},
    removeListener(type,fn){rows.get(type)?.delete(fn);},
    emit(){emitted=true;for(const fn of rows.get('APP_READY')||[])fn();},
    get listeners(){return rows.get('APP_READY')?.size||0;}};
}
export const singleUser=()=>({currentUser:null,accountsEnabled:false,getCurrentUserHandle:()=>'default-user'});
