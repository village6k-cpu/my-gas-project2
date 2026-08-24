import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRuntime } from './runtime-probe.mjs';
function fake(overrides={}){return async(file)=>{if(file==='which')return {stdout:overrides.path??'/opt/codex'};if(file==='/opt/codex')return {stdout:overrides.version??'codex 0.147.0\n'};if(file==='git'){if(overrides.branchFailure)throw Object.assign(new Error('raw'),{code:'ENOENT'});return {stdout:'codex/test\n'};}return {stdout:''};};}
test('runtime probe retains exact sanitized Node/Codex paths and versions',async()=>{const dir=await mkdtemp(join(tmpdir(),'gate0-runtime-'));try{const r=await collectRuntime({exec:fake(),cwd:dir,configuredMcp:[{name:'node_repl',status:'available'}]});assert.deepEqual(r.evidence.node,{path:process.execPath,version:process.versions.node});assert.deepEqual(r.evidence.codex,{path:'/opt/codex',version:'0.147.0'});assert.equal(r.result,'PASS');}finally{await rm(dir,{recursive:true,force:true});}});
test('empty path, version failure, and branch failure are blocked',async()=>{const empty=await collectRuntime({exec:fake({path:''})});assert.equal(empty.errorClass,'empty_path');const failed=await collectRuntime({exec:async(file)=>{if(file==='which')return {stdout:'/opt/codex'};throw Object.assign(new Error('raw secret'),{code:'ENOENT'});}});assert.equal(failed.errorClass,'version_failed');const branch=await collectRuntime({exec:fake({branchFailure:true})});assert.equal(branch.result,'BLOCKED');assert.equal(branch.errorClass,'command_failed');});
