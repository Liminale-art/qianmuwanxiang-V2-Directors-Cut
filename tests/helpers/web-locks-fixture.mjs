// Models the ifAvailable lifetime contract, not browser scheduling or persistence.
export function fakeWebLocks(){
  const held=new Set();return {held,async request(name,options,callback){
    if(options.ifAvailable!==true)throw Error('unexpected lock wait');
    if(held.has(name))return callback(null);
    held.add(name);try{return await callback({name,mode:options.mode});}finally{held.delete(name);}
  }};
}
