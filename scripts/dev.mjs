import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
if(existsSync(path.join(root,'.env')))process.loadEnvFile(path.join(root,'.env'));
const env={...process.env,NODE_ENV:'development',HOST:'127.0.0.1',PORT:'4310',APP_ORIGIN:'http://127.0.0.1:5173'};
if(!process.env.MODERATION_API_KEY&&!process.env.MODERATION_URL){env.LOCAL_DEMO='1';env.DATA_DIR=path.join(root,'data','local-demo');}
const args=existsSync(path.join(root,'.env'))?['--env-file=.env','--watch','server/index.js']:['--watch','server/index.js'];
const children=[spawn(process.execPath,args,{cwd:root,env,stdio:'inherit'}),spawn(process.execPath,['node_modules/vite/bin/vite.js'],{cwd:root,env,stdio:'inherit'})];
let stopping=false;
function stop(){if(stopping)return;stopping=true;for(const child of children)child.kill('SIGTERM');}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
for(const child of children)child.on('exit',(code)=>{if(!stopping&&code){stop();process.exitCode=code;}});
