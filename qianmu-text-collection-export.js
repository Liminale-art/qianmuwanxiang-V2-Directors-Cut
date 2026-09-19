import {createTextCollectionSession} from './qianmu-text-collection-session.js';
import {prepareTextCollectionBackup} from './qianmu-text-collection-backup.js';

// Explicit read-only export. A snapshot is not a restore authorization or a device cache.
export async function exportTextCollectionBackup({resolveNamespace,isCurrent,headers,confirm,download,check}={}){
  if(typeof confirm!=='function'||typeof download!=='function'||typeof check!=='function')throw TypeError('收藏导出需要明确确认及页面校验');
  let session;
  try{
    check();session=await createTextCollectionSession({resolveNamespace,isCurrent,headers});check();
    const {backup}=await session.snapshot();check();await session.guard();
    if(!backup.records.length)return {status:'empty',count:0};
    const result=prepareTextCollectionBackup(backup);
    const accepted=await confirm('导出正文收藏',`将下载当前账户 ${result.count} 条收藏，包含收藏正文、收藏时的角色与用户名称及来源标识。文件未加密，请妥善保管。不会修改服务器原件。是否继续？`);
    check();await session.guard();check();if(!accepted)return {status:'cancelled',count:0};
    const stamp=new Date(backup.exportedAt).toISOString().replace(/[:.]/g,'-');
    await download(result.blob,`qianmu-text-collections-${stamp}.json`);
    return {status:'download-started',count:result.count};
  }finally{session?.close();}
}
