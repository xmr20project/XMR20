#!/usr/bin/env node
// Locked build recipe + reproduction check for the four pinned binaries of this candidate.
// For each artifact: record the SOURCE identity (every local package in the cargo graph, hashed file by file, plus
// Cargo.lock), the TOOLCHAIN identity (rustc -vV / cargo -vV / platform-tools), the exact build command, then rebuild
// and compare the output byte-for-byte with the digest recorded by the completed integration run.
//
// Path dependence (measured, runs/repro-builds/*/attempt*.txt): the two lab binaries and the holder wasm embed the
// absolute path of the monero-bulletproofs build-script output directory
// (<target dir>/<profile>/build/monero-bulletproofs-<unit hash>/out/generators*.rs). A different target directory
// changes the path; any RUSTFLAGS (including --remap-path-prefix) changes the <unit hash>. The only way to reproduce the
// RECORDED bytes is therefore to build in the recorded target directory with no RUSTFLAGS ("inplace"): the recorded
// artifact is copied aside first, restored if the rebuild differs, and the directory is pruned back to the artifact
// afterwards so the lab folders keep their footprint. The custody program embeds only registry paths (it was built with
// CARGO_HOME=<base>/.cargo-cache, since removed), which --remap-path-prefix pins without side effects ("remap").
// Offline, --locked, no network. Nothing else in the lab folders is touched.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync, copyFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=dirname(fileURLToPath(import.meta.url));   // candidate root
const xmr20=resolve(root,'..','..');                  // workspace root
const HOME=process.env.HOME;
const CARGO=join(HOME,'.cargo','bin','cargo');
const PT=process.env.SOLANA_PLATFORM_TOOLS||join(HOME,'.cache/solana/v1.57/platform-tools');
const args=process.argv.slice(2);
const only=args.includes('--only')?args[args.indexOf('--only')+1].split(','):null;
const outDir=join(root,'runs','repro-builds');

const sha256=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const rel=p=>relative(xmr20,p);

// Recorded digests = the build block of the completed integration run.
const report=JSON.parse(readFileSync(join(root,'runs','integration-report.json'),'utf8'));
const recorded=report.build;

const ARTIFACTS=[
 {key:'labRoles', mode:'inplace',
  crate:resolve(xmr20,'research/privacy-stagenet-roles-20261023-lab'),
  targetDir:resolve(xmr20,'research/privacy-stagenet-roles-20261023-lab/target'),
  output:'release/xmr20-integration-lab', keepInTarget:['release/xmr20-integration-lab','.rustc_info.json'],
  cargo:CARGO, cargoArgs:['build','--release','--offline','--locked'], platform:'aarch64-apple-darwin'},
 {key:'labBackend', mode:'inplace',
  crate:resolve(xmr20,'research/privacy-verifier-params-20261023-lab'),
  targetDir:resolve(xmr20,'research/privacy-verifier-params-20261023-lab/target'),
  output:'release/xmr20-integration-lab', keepInTarget:['release/xmr20-integration-lab','release/libxmr20_integration_lab.rlib','.rustc_info.json'],
  cargo:CARGO, cargoArgs:['build','--release','--offline','--locked'], platform:'aarch64-apple-darwin'},
 {key:'wasm', mode:'inplace',
  crate:resolve(xmr20,'research/privacy-stagenet-roles-20261023/holder-wasm'),
  targetDir:resolve(xmr20,'research/privacy-stagenet-roles-20261023/holder-wasm/target'),
  output:'wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm', keepInTarget:['wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm'],
  cargo:CARGO, cargoArgs:['build','--release','--offline','--locked','--target','wasm32-unknown-unknown'], platform:'wasm32-unknown-unknown'},
 {key:'custodyProgram', mode:'remap',
  crate:resolve(xmr20,'proof-of-concepts/joint-escrow-wallet/core-monero-send/program'),
  manifestDir:resolve(xmr20,'proof-of-concepts/joint-escrow-wallet/core-monero-send'),
  output:'sbpf-solana-solana/release/xmr20_joint_escrow.so',
  cargo:join(PT,'rust/bin/cargo'), platform:'sbpf-solana-solana',
  cargoArgs:['build','--manifest-path',resolve(xmr20,'proof-of-concepts/joint-escrow-wallet/core-monero-send/program/Cargo.toml'),'--release','--target','sbpf-solana-solana','--locked','--offline'],
  env:{RUSTC:join(PT,'rust/bin/rustc'),CARGO_TARGET_SBPF_SOLANA_SOLANA_LINKER:join(PT,'llvm/bin/ld.lld')},
  remap:[[join(HOME,'.cargo/registry'), resolve(xmr20,'proof-of-concepts/joint-escrow-wallet/.cargo-cache/registry')]]},
];

function run(cmd,argv,opts={}){const r=spawnSync(cmd,argv,{encoding:'utf8',maxBuffer:1<<28,...opts});return {status:r.status,stdout:r.stdout||'',stderr:r.stderr||'',error:r.error?.message};}
function cleanEnv(extra){const e={...process.env};delete e.RUSTFLAGS;delete e.CARGO_ENCODED_RUSTFLAGS;delete e.CARGO_BUILD_RUSTFLAGS;return {...e,...extra};}   // caller flags dropped, explicit flags kept

function toolchain(a){
 const env=cleanEnv(a.env||{});
 const rustc=a.env?.RUSTC||join(HOME,'.cargo/bin/rustc');
 const t={rustc:run(rustc,['-vV']).stdout.trim(), cargo:run(a.cargo,['-vV'],{env}).stdout.trim()};
 if(a.platform==='sbpf-solana-solana'){t.platformTools=rel(PT); t.platformToolsVersion=existsSync(join(PT,'version.md'))?readFileSync(join(PT,'version.md'),'utf8').trim():null; t.lld=run(join(PT,'llvm/bin/ld.lld'),['--version']).stdout.trim();}
 t.host=run('uname',['-m']).stdout.trim()+' '+run('uname',['-s']).stdout.trim();
 t.rustflagsInCallerEnv=process.env.RUSTFLAGS??null;
 return t;
}

function localPackages(a){
 const env=cleanEnv(a.env||{});
 const r=run(a.cargo,['metadata','--manifest-path',join(a.crate,'Cargo.toml'),'--format-version','1','--offline','--locked','--filter-platform',a.platform],{cwd:a.manifestDir||a.crate,env});
 if(r.status!==0) throw new Error('cargo metadata failed: '+r.stderr.slice(0,400));
 const m=JSON.parse(r.stdout);
 return {total:m.packages.length, local:m.packages.filter(p=>p.source===null).map(p=>({name:p.name,version:p.version,dir:dirname(p.manifest_path)}))};
}

const SKIP=new Set(['node_modules','runs','evidence','.git','.DS_Store']);
function walk(dir,out){
 for(const e of readdirSync(dir,{withFileTypes:true})){
  if(SKIP.has(e.name)||e.name.startsWith('target'))continue;
  const p=join(dir,e.name);
  if(e.isSymbolicLink())continue;
  if(e.isDirectory())walk(p,out);else if(e.isFile())out.push(p);
 }
}
function sourceIdentity(a,pk){
 const files={};
 for(const p of pk.local){const list=[];walk(p.dir,list);for(const f of list)files[rel(f)]=sha256(f);}
 const lock=join(a.crate,'Cargo.lock'); if(existsSync(lock))files[rel(lock)]=sha256(lock);
 const sorted=Object.fromEntries(Object.entries(files).sort(([x],[y])=>x<y?-1:1));
 return {fileCount:Object.keys(sorted).length, digest:createHash('sha256').update(JSON.stringify(sorted)).digest('hex'), files:sorted};
}

function listFiles(dir,out=[]){if(!existsSync(dir))return out;for(const e of readdirSync(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())listFiles(p,out);else out.push(p);}return out;}
function prune(targetDir,keep){
 // remove everything cargo added except the recorded artifacts (and cargo's tiny lock/info files)
 const keepSet=new Set(keep.map(k=>join(targetDir,k)));
 for(const f of listFiles(targetDir)){const base=f.split('/').pop();if(keepSet.has(f)||base==='.cargo-lock'||base==='.cargo-build-lock'||base==='.cargo-artifact-lock'||base==='CACHEDIR.TAG')continue;rmSync(f,{force:true});}
 // drop now-empty directories
 const dirs=[];(function collect(d){for(const e of readdirSync(d,{withFileTypes:true}))if(e.isDirectory()){collect(join(d,e.name));dirs.push(join(d,e.name));}})(targetDir);
 for(const d of dirs)if(readdirSync(d).length===0)rmSync(d,{recursive:true,force:true});
}

function build(a){
 const dir=join(outDir,a.key); mkdirSync(dir,{recursive:true});
 const name=a.output.split('/').pop();
 let target, env, flags='';
 if(a.mode==='inplace'){
  target=a.targetDir;
  const recordedFile=join(target,a.output);
  if(!existsSync(recordedFile)) throw new Error('recorded artifact missing: '+rel(recordedFile));
  copyFileSync(recordedFile,join(dir,name+'.recorded'));
  prune(target,a.keepInTarget);            // only the recorded artifact remains, so cargo compiles every unit again
  env=cleanEnv({CARGO_TARGET_DIR:target});
 }else{
  target=join(dir,'target'); if(existsSync(target))rmSync(target,{recursive:true,force:true});
  flags=a.remap.map(([from,to])=>`--remap-path-prefix=${from}=${to}`).join(' ');
  env=cleanEnv({...(a.env||{}),CARGO_TARGET_DIR:target,RUSTFLAGS:flags});
 }
 const started=new Date().toISOString();
 const r=run(a.cargo,a.cargoArgs,{cwd:a.manifestDir||a.crate,env});
 const finished=new Date().toISOString();
 writeFileSync(join(dir,'build.log'),r.stdout+r.stderr+`\nexit ${r.status}\n`);
 const out=join(target,a.output);
 const produced=r.status===0&&existsSync(out)?{sha256:sha256(out),bytes:statSync(out).size}:null;
 if(produced)copyFileSync(out,join(dir,name+'.reproduced'));
 let restored=false;
 if(a.mode==='inplace'){
  if(!produced||produced.sha256!==recorded[a.key]){copyFileSync(join(dir,name+'.recorded'),out);restored=true;}
  prune(target,a.keepInTarget);
 }else if(existsSync(target))rmSync(target,{recursive:true,force:true});
 return {mode:a.mode,started,finished,seconds:Math.round((Date.parse(finished)-Date.parse(started))/1000),
  command:[rel(a.cargo),...a.cargoArgs.map(x=>x.startsWith('/')?rel(x):x)].join(' '),cwd:rel(a.manifestDir||a.crate),
  env:{CARGO_TARGET_DIR:rel(target),...(flags?{RUSTFLAGS:a.remap.map(([f,t])=>`--remap-path-prefix=${f.startsWith(HOME)?'$HOME'+f.slice(HOME.length):rel(f)}=${rel(t)}`).join(' ')}:{RUSTFLAGS:'(unset)'}),...Object.fromEntries(Object.entries(a.env||{}).map(([k,v])=>[k,rel(v)]))},
  exit:r.status,produced,recordedArtifactRestored:restored};
}

mkdirSync(outDir,{recursive:true});
const results=[];
for(const a of ARTIFACTS){
 if(only&&!only.includes(a.key))continue;
 process.stdout.write(`== ${a.key} (${a.mode})\n`);
 const row={key:a.key,recorded:recorded[a.key]};
 try{
  const pk=localPackages(a); row.graph={packages:pk.total,local:pk.local.map(p=>({name:p.name,version:p.version,dir:rel(p.dir)}))};
  row.source=sourceIdentity(a,pk); row.toolchain=toolchain(a);
  process.stdout.write(`   source files ${row.source.fileCount} digest ${row.source.digest.slice(0,16)}… ; building…\n`);
  row.build=build(a);
  row.reproduced=!!row.build.produced&&row.build.produced.sha256===row.recorded;
  process.stdout.write(`   ${row.reproduced?'REPRODUCED':'DIFFERENT'} recorded ${String(row.recorded).slice(0,16)}… produced ${row.build.produced?row.build.produced.sha256.slice(0,16)+'…':'(no output)'} in ${row.build.seconds}s${row.build.recordedArtifactRestored?' (recorded artifact restored)':''}\n`);
 }catch(e){row.error=String(e.message||e);process.stdout.write(`   ERROR ${row.error}\n`);}
 results.push(row);
}
const summary={at:new Date().toISOString(),candidate:rel(root),reproduced:results.filter(r=>r.reproduced).map(r=>r.key),different:results.filter(r=>r.build&&!r.reproduced).map(r=>r.key),errors:results.filter(r=>r.error).map(r=>r.key),rows:results};
writeFileSync(join(outDir,'report.json'),JSON.stringify(summary,null,1));
const lines=[`LOCKED BUILD RECIPE AND REPRODUCTION CHECK — ${summary.at}`,`candidate ${rel(root)}; recorded digests from runs/integration-report.json (build block); per-file source hashes in report.json`,''];
for(const r of results){lines.push(`[${r.key}] ${r.reproduced?'REPRODUCED byte-for-byte':r.build?'DIFFERENT':'ERROR '+r.error}`);if(r.build){lines.push(`  mode     ${r.build.mode}${r.build.mode==='inplace'?' (recorded target directory, no RUSTFLAGS; recorded artifact copied aside, directory pruned back afterwards)':' (fresh target directory, registry path remapped)'}`,`  cwd      ${r.build.cwd}`,`  command  ${r.build.command}`,`  env      ${Object.entries(r.build.env).map(([k,v])=>k+'='+v).join('  ')}`,`  source   ${r.source.fileCount} files, digest ${r.source.digest}`,`           local packages: ${r.graph.local.map(p=>p.name+'@'+p.version+' ('+p.dir+')').join(', ')}; ${r.graph.packages} packages resolved for ${r.key==='custodyProgram'?'sbpf-solana-solana':r.key==='wasm'?'wasm32-unknown-unknown':'aarch64-apple-darwin'} (Cargo.lock, --locked, --offline)`,`  toolchain ${r.toolchain.rustc.split('\n')[0]} | ${r.toolchain.cargo.split('\n')[0]}${r.toolchain.platformToolsVersion?' | '+r.toolchain.platformTools+' | '+r.toolchain.lld:''}`,`  recorded ${r.recorded}`,`  produced ${r.build.produced?r.build.produced.sha256+' ('+r.build.produced.bytes+' B)':'(no output)'} in ${r.build.seconds}s`);}lines.push('');}
writeFileSync(join(outDir,'BUILD-RECIPE.txt'),lines.join('\n'));
process.stdout.write(`\nreproduced: ${summary.reproduced.join(', ')||'none'}\ndifferent: ${summary.different.join(', ')||'none'}\nerrors: ${summary.errors.join(', ')||'none'}\nreport: ${rel(join(outDir,'report.json'))}\n`);
process.exit(summary.different.length||summary.errors.length?1:0);
