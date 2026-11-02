import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const [envFile,queueDir,outputDir]=process.argv.slice(2);
if(process.platform!=='darwin'||![envFile,queueDir,outputDir].every(p=>p&&path.isAbsolute(p)))throw Error('macOS and three absolute configured paths required');
if(!fs.statSync(envFile).isFile()||!fs.statSync(queueDir).isDirectory())throw Error('configured source unavailable');
const label='com.village.reservation-reconciliation',domain='gui/'+process.getuid();
const plist=path.join(os.homedir(),'Library/LaunchAgents',label+'.plist');
const entry=path.join(path.dirname(fileURLToPath(import.meta.url)),'run.mjs');
const escape=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const args=[process.execPath,entry,envFile,queueDir,outputDir,'--publish'];
fs.mkdirSync(outputDir,{recursive:true,mode:0o700});fs.mkdirSync(path.dirname(plist),{recursive:true});
const content=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(x=>'<string>'+escape(x)+'</string>').join('')}</array><key>RunAtLoad</key><true/><key>StartInterval</key><integer>300</integer><key>ProcessType</key><string>Background</string><key>LowPriorityIO</key><true/><key>StandardOutPath</key><string>${escape(path.join(outputDir,'service.log'))}</string><key>StandardErrorPath</key><string>${escape(path.join(outputDir,'service-error.log'))}</string></dict></plist>`;
if(fs.existsSync(plist)&&fs.readFileSync(plist,'utf8')!==content)throw Error('existing service configuration differs; preserve it and review before replacing');
fs.writeFileSync(plist,content,{mode:0o600});execFileSync('plutil',['-lint',plist]);
let loaded=false;try{execFileSync('launchctl',['print',domain+'/'+label],{stdio:'ignore'});loaded=true;}catch{}
if(!loaded)execFileSync('launchctl',['bootstrap',domain,plist]);
console.log(JSON.stringify({label,installed:true,alreadyLoaded:loaded,intervalSeconds:300,outputDir}));
