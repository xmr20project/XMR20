// CONTENT-IDENTITY PROVENANCE for the integration suite runner (no timestamps are trusted).
// A suite's "inputs" are: its test file and the static import closure of local modules, every local script/module the
// closure's text refers to at runtime (spawned CLIs, holder processes), and the runtime-resolved resources the closure's text
// names: the engine wasm, the lab role binaries, monerod, the custody program, parameter sets (manifest, parameters.json and
// the proving-key BYTES; issuer.secret.json is never read), the stagenet trusted manifest, the interop vectors, the built
// test extension (browser rows) and the toolchain (Node version; Playwright version for browser rows). Each input is hashed
// (sha256 of content) and the sorted {path: sha256} map is digested. A previous PASS may be reused for a suite only when its
// recorded digest equals the current one; a row without recorded provenance is never reused. Over-inclusion of inputs is
// harmless (it only prevents a reuse); under-inclusion would be a false reuse, so detection errs towards inclusion.
import {readFile,readdir,stat,realpath,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
export const sha256=async f=>createHash('sha256').update(await readFile(f)).digest('hex');
const exists=async f=>{try{await access(f);return true;}catch{return false;}};
const IMPORT_RE=/(?:import|export)\s*(?:[^'";]*?\s*from\s*)?['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
// Local script/module paths mentioned in text (spawned or dynamically resolved), e.g. dir+'cli-wallet/xmr20-private-cli.mjs'.
const TEXT_PATH_RE=/['"`]((?:\.{1,2}\/)?[\w\-]+(?:\/[\w\-.]+)*\.(?:mjs|js|json))['"`]/g;
// Static import closure plus text-referenced local scripts. Returns root-relative paths (sorted) and the concatenated text.
export async function importClosure(entry,{root,extraRoots=[]}){
 const seen=new Map();const q=[path.resolve(root,entry),...extraRoots.map(e=>path.resolve(root,e))];let text='';
 while(q.length){const f=q.shift();if(seen.has(f))continue;let src;try{src=await readFile(f,'utf8');}catch{seen.set(f,false);continue;}
  seen.set(f,true);if(!/\.json$/.test(f))text+=src+'\n';if(/\.json$/.test(f))continue;
  for(const m of src.matchAll(IMPORT_RE)){const spec=m[1]||m[2];const t=path.resolve(path.dirname(f),spec);if(/\.(mjs|js|json)$/.test(t))q.push(t);}
  for(const m of src.matchAll(TEXT_PATH_RE)){const spec=m[1];if(spec.includes('node_modules'))continue;for(const base of [path.dirname(f),root]){const t=path.resolve(base,spec);if(await exists(t)&&!/\/(runs|evidence)\//.test(t))q.push(t);}}}
 return {files:[...seen.keys()].filter(f=>seen.get(f)).map(f=>path.relative(root,f)).sort(),text};}
// Runtime-resolved resources named in the closure's text. `files` are root-relative (symlinks are followed when hashing).
export const SHARED=[
 {key:'wasm',when:t=>/xmr20_holder_wasm\.wasm/.test(t),files:['holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm']},
 {key:'labBackend',when:t=>/privacy-verifier-params-20261023-lab/.test(t),files:['../privacy-verifier-params-20261023-lab/target/release/xmr20-integration-lab']},
 {key:'labRoles',when:t=>/privacy-stagenet-roles-20261023-lab/.test(t),files:['../privacy-stagenet-roles-20261023-lab/target/release/xmr20-integration-lab']},
 {key:'monerod',when:t=>/bin\/monerod/.test(t),files:['../../operations/native-market-20261016/local-chain/bin/monerod']},
 {key:'custodyProgram',when:t=>/xmr20_joint_escrow\.so/.test(t),files:['proof-of-concepts/joint-escrow-wallet/core-monero-send/target/sbpf-solana-solana/release/xmr20_joint_escrow.so']},
 {key:'paramsTestV1',when:t=>/params\//.test(t),files:['params/test-v1/manifest.json','params/test-v1/parameters.json','params/test-v1/normal.public-pk','params/test-v1/boundary.public-pk']},
 {key:'paramsTestOther',when:t=>/params\//.test(t),files:['params/test-other/manifest.json','params/test-other/parameters.json','params/test-other/normal.public-pk','params/test-other/boundary.public-pk']},
 {key:'paramsCeremony',when:t=>/ceremony-rehearsal-v1/.test(t),files:['params/ceremony-rehearsal-v1/manifest.json','params/ceremony-rehearsal-v1/parameters.json','params/ceremony-rehearsal-v1/attestation.json','params/ceremony-rehearsal-v1/normal.public-pk','params/ceremony-rehearsal-v1/boundary.public-pk']},
 {key:'ceremonyTool',when:t=>/xmr20-params-ceremony/.test(t),files:['ceremony/target/release/xmr20-params-ceremony']},
 {key:'trustedStagenetManifest',when:t=>/stagenet-v0-trusted/.test(t),files:['params/stagenet-v0-trusted/manifest.json']},
 {key:'vectors',when:t=>/vectors\/vectors\.json/.test(t),files:['vectors/vectors.json']},
];
export const EXTENSION_DIR='wallet-extension/extension-private-holder-test';
async function walk(d,rel,out){for(const e of (await readdir(d,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const p=path.join(d,e.name);if(e.isDirectory())await walk(p,rel+e.name+'/',out);else out.push(rel+e.name);}return out;}
// Fingerprint one suite row: {files:{relPath:sha256}, missing:[], digest|null, shared:[keys], toolchain}.
export async function fingerprint(row,{root,toolchain={}}){
 const {files,text}=await importClosure(row.file,{root,extraRoots:row.extraRoots||[]});const inputs=new Set(files);const shared=[];
 for(const s of SHARED)if(s.when(text)){shared.push(s.key);for(const f of s.files)inputs.add(f);}
 if(row.browser){const ext=path.join(root,EXTENSION_DIR);if(await exists(ext))for(const f of await walk(ext,EXTENSION_DIR+'/',[]))inputs.add(f);else inputs.add(EXTENSION_DIR+'/manifest.json');}
 const out={},missing=[];for(const f of [...inputs].sort()){const abs=path.resolve(root,f);try{await stat(abs);out[f]=await sha256(abs);}catch{missing.push(f);}}
 const tc={node:toolchain.node||process.version,...(row.browser?{playwright:toolchain.playwright||null}:{})};
 const digest=missing.length?null:createHash('sha256').update(JSON.stringify({files:out,toolchain:tc})).digest('hex');
 return {files:out,fileCount:Object.keys(out).length,missing,shared,toolchain:tc,digest};}
// May `prev` (a row of an earlier report) stand for `cur` (the current fingerprinted row)? Never without recorded provenance.
export function canReuse(prev,cur){
 if(!prev)return {ok:false,reason:'no earlier row'};
 if(prev.skipped)return {ok:false,reason:'earlier row was skipped'};
 if(prev.ok!==true)return {ok:false,reason:'earlier row did not pass'};
 if(!prev.inputs?.digest)return {ok:false,reason:'earlier row has no recorded content identities (provenance missing)'};
 if(!cur.inputs?.digest)return {ok:false,reason:'current inputs incomplete: '+(cur.inputs?.missing||[]).join(', ')};
 if(prev.inputs.digest!==cur.inputs.digest){const changed=Object.keys({...prev.inputs.files,...cur.inputs.files}).filter(f=>prev.inputs.files?.[f]!==cur.inputs.files[f]);const tc=JSON.stringify(prev.inputs.toolchain)!==JSON.stringify(cur.inputs.toolchain);return {ok:false,reason:'inputs changed: '+changed.slice(0,8).join(', ')+(changed.length>8?' …':'')+(tc?' toolchain':''),changed};}
 return {ok:true,origin:prev.origin||{runId:prev.runId,executedAt:prev.executedAt,build:prev.build,seconds:prev.seconds,log:prev.log}};}
// A run is complete only when every row of the FULL suite passed (executed or reused with matching provenance).
export function summarize(rows,{quick=false,only=null,fullCount}){
 const ran=rows.filter(r=>!r.skipped);const passed=ran.length>0&&ran.every(r=>r.ok===true);const complete=passed&&!quick&&!only&&ran.length===fullCount;
 const claim=complete?'full suite: every row passed (executed or reused with identical recorded inputs)':quick?'PARTIAL (--quick): the long real-popup suites did not run; no full-suite completion is claimed':only?'PARTIAL (--only): selected rows only; no full-suite completion is claimed':passed?'PARTIAL: not every row of the full suite is present':'FAILED: at least one row did not pass';
 return {passed,complete,claim,executed:ran.filter(r=>r.executed).length,reused:ran.filter(r=>r.reused).length,failed:ran.filter(r=>r.ok!==true).length};}
