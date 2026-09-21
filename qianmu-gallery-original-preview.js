// Decode already byte-verified private originals. No network or object URLs.
export async function decodeGalleryOriginalBlob(blob,{guard=async()=>true,signal,decode=value=>globalThis.createImageBitmap(value),timeoutMs=30000}={}){
    if(!(blob instanceof Blob)||!blob.size||blob.size>24*1024*1024||!['image/png','image/jpeg','image/webp'].includes(blob.type))throw Error('原图副本格式或大小不符');
    const controller=new AbortController();let bitmap,released=false,reject;
    const release=()=>{if(bitmap&&!released){released=true;bitmap.close?.();}};
    const cancelled=new Promise((_,no)=>{reject=no;});
    const abort=()=>{controller.abort();release();reject(Error('原图解码已取消或超时'));};
    const check=async()=>{if(controller.signal.aborted)throw Error('原图解码已取消');if(await guard()!==true||controller.signal.aborted)throw Error('原图页面已变化');};
    signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,Math.max(100,Math.min(60000,Number(timeoutMs)||30000)));
    try{
        if(signal?.aborted)abort();
        const worker=(async()=>{
            await check();bitmap=await decode(blob);
            try{
                await check();if(!Number.isSafeInteger(bitmap?.width)||bitmap.width<1||!Number.isSafeInteger(bitmap.height)||bitmap.height<1||bitmap.width*bitmap.height>32000000)
                    throw Error('原图超过 3200 万像素或无法解码');
                await check();return {blob,width:bitmap.width,height:bitmap.height};
            }finally{release();}
        })();
        return await Promise.race([worker,cancelled]);
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();release();}
}
