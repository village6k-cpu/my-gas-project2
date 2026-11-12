import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
// Caller holds per-source lock. Rejected guesses must not permanently occupy an ID.
export function prepareRequestFile(file,request){
 if(fs.existsSync(file+'.prepared.json')){
  if(!fs.existsSync(file)||JSON.stringify(JSON.parse(fs.readFileSync(file,'utf8')))!==JSON.stringify(request))throw Error('Same source already has a verified prepared correction; review required');
  return;
 }
 const temporary=file+'.'+randomUUID()+'.tmp';
 try{fs.writeFileSync(temporary,JSON.stringify(request),{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);}
 finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
