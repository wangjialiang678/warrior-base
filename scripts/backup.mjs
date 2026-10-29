import { DatabaseSync,backup } from 'node:sqlite';
import { existsSync,mkdirSync,cpSync } from 'node:fs';
import path from 'node:path';
const dataDir=path.resolve(process.env.DATA_DIR||'data');
const stamp=new Date().toISOString().replaceAll(':','-');
const destination=path.join(dataDir,'backups',stamp);
mkdirSync(destination,{recursive:true,mode:0o700});
for(const file of ['warrior-base.sqlite','moderation-usage.sqlite']){
 if(!existsSync(path.join(dataDir,file)))continue;
 const db=new DatabaseSync(path.join(dataDir,file),{readOnly:true});
 try{await backup(db,path.join(destination,file));}finally{db.close();}
}
if(existsSync(path.join(dataDir,'media')))cpSync(path.join(dataDir,'media'),path.join(destination,'media'),{recursive:true,errorOnExist:true,force:false});
console.log(`Backup completed: ${destination}`);
