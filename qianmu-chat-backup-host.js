import * as fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const unavailable=()=>Object.assign(new Error('当前 ST 尚不能提供可靠的后台账户目录，自动备份未启动'),{code:'chat_backup_host',status:503});

// Host-owned modules only. No account database, caller path or synthetic login is used.
export async function createChatBackupHost({hostDirectory,io=fs,importModule=url=>import(url)}={}) {
  if(typeof hostDirectory!=='string'||!path.isAbsolute(hostDirectory))throw unavailable();
  const root=path.resolve(hostDirectory);
  if(root===path.parse(root).root)throw unavailable();
  try {
    for(const dir of [root,path.join(root,'src')]) {
      const stat=await io.lstat(dir);
      if(!stat.isDirectory()||stat.isSymbolicLink()||path.resolve(await io.realpath(dir))!==dir)throw unavailable();
    }
    const modules=[];
    for(const name of ['users.js','util.js','constants.js']) {
      const file=path.join(root,'src',name),stat=await io.lstat(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||path.resolve(await io.realpath(file))!==file)throw unavailable();
      modules.push(await importModule(pathToFileURL(file).href));
    }
    const [users,util,constants]=modules;
    if(typeof users.getAllEnabledUsers!=='function'||typeof users.getUserDirectories!=='function'||typeof util.getConfigValue!=='function'
      ||typeof constants.DEFAULT_USER?.handle!=='string')throw unavailable();
    return async function accounts() {
      const profiles=util.getConfigValue('enableUserAccounts',false,'boolean')
        ? await users.getAllEnabledUsers() : [constants.DEFAULT_USER];
      if(!Array.isArray(profiles))throw unavailable();
      // Strip secrets from host user records before entering the backup service.
      return profiles.filter(profile=>profile?.enabled!==false).map(profile=>({
        profile:{handle:profile.handle,enabled:profile.enabled!==false},
        directories:Object.fromEntries(Object.entries(users.getUserDirectories(profile.handle)).map(([key,value])=>[key,typeof value==='string'?path.resolve(root,value):value])),
      }));
    };
  } catch {throw unavailable();}
}
