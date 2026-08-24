import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform, release } from 'node:os';
import { makeProbe } from './probe-contract.mjs';
const defaultExec=promisify(execFile);
async function run(exec,file,args){try{const r=await exec(file,args);return String(r.stdout??'').trim();}catch(error){return {errorClass:error.code||'command_failed'};}}
export async function collectRuntime({exec=defaultExec,cwd=process.cwd(),configuredMcp=[]}={}){const node={path:process.execPath,version:process.versions.node};const rawPath=await run(exec,'which',['codex']);let errorClass;let codexPath=rawPath;if(typeof rawPath!=='string'||!rawPath)errorClass='empty_path';else if(!/^\//.test(rawPath))errorClass='invalid_path';let codex;if(!errorClass){const v=await run(exec,rawPath,['--version']);if(typeof v!=='string'||!/^codex\s+\d+\.\d+\.\d+/.test(v))errorClass='version_failed';else codex={path:rawPath,version:v.match(/\d+\.\d+\.\d+/)[0]};}const branch=await run(exec,'git',['-C',cwd,'branch','--show-current']);const evidence={node,codex,branch:typeof branch==='string'?branch:'unknown',platform:`${platform()}-${release()}`,mcp:configuredMcp.map(x=>({name:String(x.name),status:String(x.status??'unknown')})),capabilities:{node:true,codex:Boolean(codex),commandArgsCaptured:false,environmentCaptured:false}};return makeProbe({probeId:'launchagent_security',result:errorClass?'BLOCKED':'PASS',evidence,errorClass});}
if(import.meta.url===`file://${process.argv[1]}`)process.stdout.write(JSON.stringify(await collectRuntime(),null,2)+'\n');
