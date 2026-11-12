'use strict';
// Usage: node scripts/master-correction.cjs ENV_FILE REQUEST_JSON
// Defaults to preview; apply requires explicit mode and preview revision in the file.
const fs=require('node:fs');
const {parseEnv}=require('./windows/village-live-read.js');
async function main(){
 const [envPath,requestPath]=process.argv.slice(2);
 if(!envPath||!requestPath)throw Error('ENV_FILE and REQUEST_JSON required');
 const config=parseEnv(fs.readFileSync(envPath,'utf8'));
 const url=new URL(config.VILLAGE2_API_URL);
 if(url.protocol!=='https:'||url.hostname!=='script.google.com')throw Error('invalid endpoint');
 const request=JSON.parse(fs.readFileSync(requestPath,'utf8'));
 const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...request,key:config.VILLAGE2_API_KEY,action:'masterCorrection'}),signal:AbortSignal.timeout(90000)});
 const result=await response.json();
 if(!response.ok||result.error||!result.success)throw Error(result.error||'correction failed; inspect receipt before retry');
 console.log(JSON.stringify(result,null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
