// Called only by the native plugin; no standalone CLI/environment fallback grant.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {prepareRequestFile} from '../tools/master-correction/request-state.mjs';
import {correctionIdForSource} from '../tools/master-correction/owner-proof.mjs';
if(process.env.VILLAGE_NATIVE_MASTER_TOOL!=='1'||process.env.HERMES_DELEGATED_CHILD_CONTEXT){console.error('Current native owner tool invocation required');process.exit(1);}
try{
 const configFile=process.argv[2];const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
 const request=JSON.parse(fs.readFileSync(0,'utf8'));request.correctionId=correctionIdForSource(request.source);
 const dir=config.stateDirectory;fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const file=path.join(dir,request.correctionId+'.json');
 const lock=fs.openSync(file+'.lock','wx',0o600);
 try {
 prepareRequestFile(file,request);
 const result=spawnSync(process.execPath,[new URL('./master-correction-approved.mjs',import.meta.url).pathname,configFile,file],{encoding:'utf8',timeout:request.kind==='create'?390000:170000,env:process.env});
 if(result.status!==0)throw Error(result.stderr?.trim()||'Verified issuer failed');process.stdout.write(result.stdout);
 }finally{fs.closeSync(lock);fs.unlinkSync(file+'.lock');}
}catch(error){console.error(error.message);process.exitCode=1;}
