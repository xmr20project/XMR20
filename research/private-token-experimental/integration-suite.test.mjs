// RUNNER SELF-TEST: content-identity provenance and reuse rules of integration-suite.mjs (suite-provenance.mjs), on a
// disposable miniature candidate. Shows that a changed source dependency, engine binary, parameter bytes, spawned script or
// toolchain invalidates reuse EVEN WITH PRESERVED TIMESTAMPS, that unchanged inputs reuse with the origin carried through
// repeated reuse, that rows without recorded provenance are never reused, and that --quick/--only never claim completion.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,utimes,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fingerprint,canReuse,summarize,importClosure,EXTENSION_DIR} from './suite-provenance.mjs';
const put=async(root,rel,content)=>{const f=path.join(root,rel);await mkdir(path.dirname(f),{recursive:true});await writeFile(f,content);return f;};
// Rewrite a file's bytes and put its atime/mtime back exactly where they were (a timestamp-based check would see no change).
const rewriteKeepingTime=async(f,content)=>{const st=await stat(f);await writeFile(f,content);await utimes(f,st.atime,st.mtime);assert.ok(Math.abs((await stat(f)).mtimeMs-st.mtimeMs)<1,'mtime preserved (to the millisecond; utimes keeps microseconds)');};
async function miniCandidate(){
 const root=await mkdtemp(path.join(tmpdir(),'rc-provenance-'));
 await put(root,'t.test.mjs',"import {x} from './lib/dep.mjs';\nimport {readFile} from 'node:fs/promises';\nconst wasm=dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm';\nspawn(process.execPath,[dir+'cli-wallet/xmr20-private-cli.mjs']);\nconst p='params/test-v1/manifest.json';\n");
 await put(root,'lib/dep.mjs',"export const x=1;\nimport './deeper.mjs';\n");
 await put(root,'lib/deeper.mjs',"export const y=2;\n");
 await put(root,'cli-wallet/xmr20-private-cli.mjs',"console.log('cli');\n");
 await put(root,'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm',Buffer.from([0,97,115,109,1,0,0,0]));
 for(const set of ['test-v1','test-other']){await put(root,`params/${set}/manifest.json`,'{"label":"'+set+'"}');await put(root,`params/${set}/parameters.json`,'{}');await put(root,`params/${set}/normal.public-pk`,Buffer.alloc(64,1));await put(root,`params/${set}/boundary.public-pk`,Buffer.alloc(64,2));await put(root,`params/${set}/issuer.secret.json`,'{"never":"read"}');}
 await put(root,'u.test.mjs',"export const unit=true;\n");
 await put(root,EXTENSION_DIR+'/manifest.json','{"manifest_version":3}');await put(root,EXTENSION_DIR+'/app.js','app');
 return root;}
const ROW={name:'engine-ish',file:'t.test.mjs'},UNIT={name:'unit',file:'u.test.mjs'},BROWSER={name:'popup',file:'u.test.mjs',browser:true};
const tc={node:'v24.1.0',playwright:'1.56.1'};
const passRow=(row,fp,runId,extra={})=>({...row,inputs:fp,ok:true,pass:1,fail:0,seconds:7,runId,executedAt:'2026-10-25T00:00:00.000Z',build:{wasm:'w'},log:'runs/suite-logs/x.log',...extra});
test('closure follows imports and text-referenced scripts; runtime resources are detected from text; secrets are never inputs',async()=>{
 const root=await miniCandidate();try{
  const c=await importClosure('t.test.mjs',{root});
  assert.deepEqual(c.files,['cli-wallet/xmr20-private-cli.mjs','lib/deeper.mjs','lib/dep.mjs','params/test-v1/manifest.json','t.test.mjs'],'imports two levels down, the spawned CLI and a text-referenced JSON file are all inputs');
  const fp=await fingerprint(ROW,{root,toolchain:tc});
  assert.ok(fp.digest&&fp.missing.length===0,'complete fingerprint');
  assert.deepEqual(fp.shared,['wasm','paramsTestV1','paramsTestOther'],'wasm and both parameter sets detected from text');
  const files=Object.keys(fp.files);
  for(const f of ['t.test.mjs','lib/dep.mjs','lib/deeper.mjs','cli-wallet/xmr20-private-cli.mjs','holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm','params/test-v1/normal.public-pk','params/test-v1/boundary.public-pk','params/test-v1/manifest.json','params/test-v1/parameters.json','params/test-other/normal.public-pk'])assert.ok(files.includes(f),f+' is an input');
  assert.ok(!files.some(f=>/issuer\.secret/.test(f)),'issuer.secret.json is never read or hashed');
  const unit=await fingerprint(UNIT,{root,toolchain:tc});assert.deepEqual(Object.keys(unit.files),['u.test.mjs']);assert.deepEqual(unit.shared,[]);
  const popup=await fingerprint(BROWSER,{root,toolchain:tc});assert.ok(Object.keys(popup.files).includes(EXTENSION_DIR+'/app.js'),'browser rows include the built extension');assert.equal(popup.toolchain.playwright,'1.56.1');
 }finally{await rm(root,{recursive:true,force:true});}});
test('reuse: identical inputs reuse and carry the origin; any changed dependency, binary, parameter bytes, script or toolchain invalidates reuse even with preserved timestamps',async()=>{
 const root=await miniCandidate();try{
  const fp0=await fingerprint(ROW,{root,toolchain:tc});const prev=passRow(ROW,fp0,'run-A');
  // unchanged -> reusable, origin = run A
  let cur={...ROW,inputs:await fingerprint(ROW,{root,toolchain:tc})};let r=canReuse(prev,cur);assert.equal(r.ok,true);assert.equal(r.origin.runId,'run-A');assert.equal(r.origin.executedAt,'2026-10-25T00:00:00.000Z');
  // a reused row reused again keeps the ORIGINAL origin (not the intermediate run)
  const reusedRow={...cur,ok:true,reused:true,pass:1,fail:0,runId:'run-B',origin:r.origin};r=canReuse(reusedRow,cur);assert.equal(r.ok,true);assert.equal(r.origin.runId,'run-A','origin propagates through repeated reuse');
  // each invalidation below rewrites content but restores the timestamps exactly
  const cases=[
   ['source dependency two levels down','lib/deeper.mjs',"export const y=3;\n"],
   ['spawned CLI script (not imported)','cli-wallet/xmr20-private-cli.mjs',"console.log('cli v2');\n"],
   ['engine wasm bytes','holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm',Buffer.from([0,97,115,109,1,0,0,1])],
   ['proving-key bytes (manifest unchanged)','params/test-v1/normal.public-pk',Buffer.alloc(64,9)],
   ['parameter manifest','params/test-v1/manifest.json','{"label":"test-v1","changed":true}'],
   ['the OTHER parameter set (substitution tests)','params/test-other/boundary.public-pk',Buffer.alloc(64,7)],
  ];
  for(const [what,rel,content] of cases){const f=path.join(root,rel);const before=await readFile(f);await rewriteKeepingTime(f,content);
   cur={...ROW,inputs:await fingerprint(ROW,{root,toolchain:tc})};r=canReuse(prev,cur);assert.equal(r.ok,false,what+' must invalidate reuse');assert.match(r.reason,/inputs changed/);assert.ok(r.changed.includes(rel),what+': the changed file is named');
   await rewriteKeepingTime(f,before);cur={...ROW,inputs:await fingerprint(ROW,{root,toolchain:tc})};assert.equal(canReuse(prev,cur).ok,true,what+': restored content reuses again');}
  // toolchain change (same files)
  cur={...ROW,inputs:await fingerprint(ROW,{root,toolchain:{node:'v25.0.0'}})};r=canReuse(prev,cur);assert.equal(r.ok,false);assert.match(r.reason,/toolchain/);
  // a removed spawned script changes the input set (not reusable); a missing runtime resource makes the digest null: nothing can be reused for it
  await rm(path.join(root,'cli-wallet/xmr20-private-cli.mjs'));cur={...ROW,inputs:await fingerprint(ROW,{root,toolchain:tc})};assert.match(canReuse(prev,cur).reason,/inputs changed: .*cli-wallet/);
  await rm(path.join(root,'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm'));cur={...ROW,inputs:await fingerprint(ROW,{root,toolchain:tc})};assert.equal(cur.inputs.digest,null);assert.deepEqual(cur.inputs.missing,['holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm']);assert.match(canReuse(prev,cur).reason,/incomplete/);
 }finally{await rm(root,{recursive:true,force:true});}});
test('never reuse without recorded provenance, a failed row, a skipped row or a missing row',async()=>{
 const root=await miniCandidate();try{
  const cur={...ROW,inputs:await fingerprint(ROW,{root,toolchain:tc})};
  assert.match(canReuse(undefined,cur).reason,/no earlier row/);
  assert.match(canReuse({...ROW,ok:true,pass:1,fail:0},cur).reason,/no recorded content identities/,'a PASS from a log or an old report (no digests) is not current verification');
  assert.match(canReuse({...ROW,ok:true,inputs:{files:{},digest:null}},cur).reason,/no recorded content identities/);
  assert.match(canReuse(passRow(ROW,cur.inputs,'run-A',{ok:false}),cur).reason,/did not pass/);
  assert.match(canReuse(passRow(ROW,cur.inputs,'run-A',{skipped:true}),cur).reason,/skipped/);
 }finally{await rm(root,{recursive:true,force:true});}});
test('completion claims: full only when every row of the full suite passed; --quick/--only are PARTIAL; a failure is FAILED',()=>{
 const ok=(n,extra={})=>({name:n,ok:true,executed:true,...extra});
 let s=summarize([ok('a'),ok('b',{executed:false,reused:true})],{fullCount:2});assert.equal(s.complete,true);assert.equal(s.passed,true);assert.equal(s.reused,1);assert.equal(s.executed,1);assert.match(s.claim,/full suite/);
 s=summarize([ok('a'),ok('b')],{quick:true,fullCount:6});assert.equal(s.complete,false);assert.match(s.claim,/PARTIAL \(--quick\)/);
 s=summarize([ok('a'),{name:'b',skipped:true}],{only:['a'],fullCount:2});assert.equal(s.complete,false);assert.match(s.claim,/PARTIAL \(--only\)/);
 s=summarize([ok('a'),{name:'b',ok:false,executed:true}],{fullCount:2});assert.equal(s.passed,false);assert.equal(s.complete,false);assert.match(s.claim,/FAILED/);
 s=summarize([ok('a')],{fullCount:2});assert.equal(s.complete,false);assert.match(s.claim,/not every row/);
});
