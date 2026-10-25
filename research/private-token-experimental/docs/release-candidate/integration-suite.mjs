#!/usr/bin/env node
// ONE INTEGRATION SUITE for the release candidate: runs the unit, settlement, conformance, migration, vector, interop and
// real-popup suites that exist in this candidate, in order, with a single JSON report (runs/integration-report.json) and a
// nonzero exit if anything fails.
//   node integration-suite.mjs [--quick] [--carry <earlier runs/integration-report*.json>] [--only <substring,substring>]
//   --quick   skips the four long real-popup browser suites (the report then says PARTIAL; no full-suite claim)
//   --only    runs the matching rows only (PARTIAL)
//   --carry   reuses a PASS row of an earlier report of THIS runner only when the recorded CONTENT IDENTITIES of that suite's
//             inputs (test file, import closure, spawned scripts, engine wasm, lab binaries, monerod, custody program, parameter
//             manifests and proving-key bytes, built extension, toolchain) equal the current ones (suite-provenance.mjs). Reused
//             rows keep their ORIGIN (run id, execution time, build) through repeated reuse. Rows without recorded provenance
//             (older reports, logs) are never reused; mtimes are never trusted.
// Every suite runs in its own process group with a bounded time. Its complete output streams to runs/suite-logs/<file>.log while it
// runs; failures and one heartbeat per minute are echoed live (bounded), so a stalled suite is visible and cannot block the run
// forever: at the bound its whole process group (test runner, test child, Chromium, fakechain) is terminated and the row FAILS.
// Everything here is SIMULATED on offline fakechains and LiteSVM unless the row says otherwise; the stagenet real-popup run
// (browser-stagenet.test.mjs, hours, faucet-limited) is NOT started here and is reported from its retained results instead.
import {spawn} from 'node:child_process';
import {writeFile,readFile,mkdir,access} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {fingerprint,canReuse,summarize,sha256,EXTENSION_DIR} from './suite-provenance.mjs';
const dir=fileURLToPath(new URL('./',import.meta.url));const argv=process.argv.slice(2);const quick=argv.includes('--quick');
const arg=f=>{const i=argv.indexOf(f);return i>=0?argv[i+1]:null;};const carryFrom=arg('--carry');const only=arg('--only')?.split(',').filter(Boolean)||null;
const MIN=60,EXT=dir+EXTENSION_DIR;
const SUITES=[
 {name:'journal',file:'private-journal.test.mjs',kind:'unit',timeout:10*MIN},
 {name:'carrier lookup-before-retry',file:'holder-carrier-recovery.test.mjs',kind:'unit (scripted daemon)',timeout:10*MIN},
 {name:'fault proxy',file:'lossy-proxy.test.mjs',kind:'unit',timeout:10*MIN},
 {name:'parameter authentication',file:'holder-params.test.mjs',kind:'unit + holder-funded carrier (wasm, offline daemon)',timeout:30*MIN},
 {name:'engine + records',file:'holder-engine.test.mjs',kind:'engine (wasm, offline daemon)',timeout:30*MIN},
 {name:'finality model (trading, abstract)',file:'settlement/model/finality-model.test.mjs',kind:'model; PASS = loss case retained',timeout:5*MIN},
 {name:'COUNTEREXAMPLE A live (bridge payout then rollback)',file:'settlement/bridge-rollback-loss.test.mjs',kind:'SIMULATED fakechain + LiteSVM; PASS = loss reproduced',timeout:30*MIN},
 {name:'indexer replay equivalence + restart + rollback',file:'conformance/indexer-replay-equivalence.test.mjs',kind:'SIMULATED fakechain, lab roles',timeout:30*MIN},
 {name:'operator journal corruption',file:'conformance/operator-journal-corruption.test.mjs',kind:'unit',timeout:5*MIN},
 {name:'observer-gated payout',file:'conformance/observer-gated-payout.test.mjs',kind:'SIMULATED fakechains + LiteSVM',timeout:30*MIN},
 {name:'catalog migration: 5 selected mints + 1 added after startup (synthetic holdings), exact entitlement, per-mint fees; asset ids of all 66 catalog entries',file:'migration/legacy-migration.test.mjs',kind:'SIMULATED fakechain + LiteSVM custody with the REAL mint account bytes; legacy lots SYNTHETIC',timeout:60*MIN},
 {name:'independent checker over the interop vectors',file:'independent/check.mjs',kind:'script (Node crypto only, no engine); exit 0 = every checkable rule matched, the rest listed as notCheckable',script:true,timeout:5*MIN},
 {name:'two-wallet interop: real popup A + CLI wallet B on one pool; tamper/duplicate admission',file:'interop.test.mjs',kind:'SIMULATED fakechain; Playwright Chromium (local test extension) + wallet-lib CLI',browser:true,extraRoots:['cli-wallet/xmr20-private-cli.mjs'],timeout:60*MIN},
 {name:'stagenet-aware roles (simulation)',file:'stagenet-roles.test.mjs',kind:'SIMULATED fakechain',timeout:30*MIN},
 {name:'suite runner: provenance + reuse rules',file:'integration-suite.test.mjs',kind:'unit (runner self-test)',timeout:5*MIN},
 ...(quick?[]:[
 {name:'real popup: carriers incl. actual lost reply',file:'browser-carrier.test.mjs',kind:'SIMULATED fakechain, Playwright Chromium',browser:true,timeout:60*MIN},
 {name:'real popup: recovery',file:'browser-recovery.test.mjs',kind:'SIMULATED',browser:true,timeout:60*MIN},
 {name:'real popup: journal recovery',file:'browser-journal-recovery.test.mjs',kind:'SIMULATED',browser:true,timeout:60*MIN},
 {name:'real popup: interruptions',file:'browser-interruptions.test.mjs',kind:'SIMULATED',browser:true,timeout:60*MIN},
 {name:'migration: public-data snapshot + reconciliation (66 mints; envelopes; reproducible digest)',file:'migration/snapshot-reconcile.test.mjs',kind:'offline (recorded public API + catalog)',timeout:5*MIN},
 {name:'migration: cutover boundaries + rollbacks on the isolated legacy indexer',file:'migration/cutover-rollback.test.mjs',kind:'offline replay',timeout:5*MIN},
 {name:'marketplace model: listing reservation + bundled trade (B\' retained)',file:'settlement/model/bundled-trade.test.mjs',kind:'ABSTRACT MODEL',timeout:5*MIN},
 {name:'payout depth policy D=20: rollbacks below/at/beyond before+after payout (loss preserved)',file:'settlement/payout-depth-policy.test.mjs',kind:'SIMULATED fakechain + LiteSVM, controlled /pop_blocks',timeout:60*MIN},
 {name:'parameter ceremony REHEARSAL: verify, tamper refusal, manifest binding, prove+verify with rehearsed keys',file:'ceremony/ceremony-rehearsal.test.mjs',kind:'offline; needs runs/ceremony-rehearsal + params/ceremony-rehearsal-v1',timeout:40*MIN},
 {name:'real popup: catalog tokens (EXTREMIST 0 bps, LUKE 150 bps from real mint bytes): migrate incl. interrupted claim, transfer, bridge out + payout at depth, deposit, fresh-profile recovery',file:'browser-catalog-migration-bridge.test.mjs',kind:'SIMULATED fakechain + LiteSVM custody, Playwright Chromium',browser:true,timeout:60*MIN}]),
];
const FULL_COUNT=SUITES.length+(quick?4:0);
const slug=s=>s.file.replace(/\.mjs$/,'').replace(/[\/.]/g,'-');
const say=t=>process.stderr.write(t+'\n');
const shaOrNull=async f=>{try{return await sha256(f);}catch{return null;}};
async function run(s){
 const t0=Date.now();const logRel='runs/suite-logs/'+slug(s)+'.log';const log=createWriteStream(dir+logRel);
 if(s.browser){try{await access(EXT+'/manifest.json');}catch{const why='test extension build missing: '+EXT;log.end(why+'\n');return {code:'not started',pass:0,fail:1,seconds:0,log:logRel,tail:[why]};}}
 const args=s.script?[s.file]:['--test','--test-reporter=tap','--test-reporter-destination=stdout',s.file];
 const p=spawn(process.execPath,args,{cwd:dir,detached:true,stdio:['ignore','pipe','pipe']});
 let out='',lastLine='',echoed=0;const ECHO_MAX=25;
 const onData=d=>{const t=d.toString();out+=t;log.write(t);for(const l of t.split('\n')){if(!l.trim())continue;lastLine=l;if(echoed<ECHO_MAX&&/^not ok|^# (pass|fail|cancelled)|^\s*(error|failureType|code):|Error:|^✖/.test(l)){echoed++;say(`  [${s.name}] ${l.slice(0,200)}`);}}};
 p.stdout.on('data',onData);p.stderr.on('data',onData);
 const beat=setInterval(()=>say(`  [${s.name}] … ${Math.round((Date.now()-t0)/1000)}s; last: ${lastLine.slice(0,140)}`),60000);
 let timedOut=false;const kill=sig=>{try{process.kill(-p.pid,sig);}catch{}};
 const timer=setTimeout(()=>{timedOut=true;say(`  [${s.name}] TIMEOUT after ${s.timeout}s: terminating its process group`);kill('SIGTERM');setTimeout(()=>kill('SIGKILL'),10000).unref();},s.timeout*1000);
 const code=await new Promise(res=>p.on('exit',(c,sig)=>res(c??('signal '+sig))));
 clearInterval(beat);clearTimeout(timer);await new Promise(r=>log.end(r));
 const mp=/^# pass (\d+)/m.exec(out),mf=/^# fail (\d+)/m.exec(out);
 const pass=s.script?(code===0?1:0):mp?Number(mp[1]):null,fail=s.script?(code===0?0:1):mf?Number(mf[1]):null;
 return {code,pass,fail,timedOut,seconds:Math.round((Date.now()-t0)/1000),log:logRel,tail:out.split('\n').filter(l=>/^not ok|Error|^\s*error:|TIMEOUT/.test(l)).slice(0,5)};
}
await mkdir(dir+'runs/suite-logs',{recursive:true});
const startedAt=new Date().toISOString(),runId=startedAt.replace(/[:.]/g,'-')+'-'+randomBytes(3).toString('hex');
let playwright=null;try{playwright=JSON.parse(await readFile(''+(process.env.XMR20_PLAYWRIGHT_DIR||'../../node_modules')+'/playwright/package.json','utf8')).version;}catch{}
const toolchain={node:process.version,playwright};
const build={node:process.version,playwright,wasm:await shaOrNull(dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm'),labBackend:await shaOrNull(dir+'../privacy-verifier-params-20261023-lab/target/release/xmr20-integration-lab'),labRoles:await shaOrNull(dir+'../privacy-stagenet-roles-20261023-lab/target/release/xmr20-integration-lab'),monerod:await shaOrNull(dir+'../../operations/native-market-20261016/local-chain/bin/monerod'),custodyProgram:await shaOrNull(dir+'proof-of-concepts/joint-escrow-wallet/core-monero-send/target/sbpf-solana-solana/release/xmr20_joint_escrow.so'),extensionAppJs:await shaOrNull(EXT+'/app.js'),extensionHolderWorker:await shaOrNull(EXT+'/vendor/private-holder.worker.js'),extensionHolderWasm:await shaOrNull(EXT+'/vendor/holder.wasm'),testManifest:await shaOrNull(dir+'params/test-v1/manifest.json'),backendService:await shaOrNull(dir+'backend/service.mjs'),browserHarness:await shaOrNull(dir+'browser-harness.mjs'),runner:await shaOrNull(dir+'integration-suite.mjs'),provenance:await shaOrNull(dir+'suite-provenance.mjs')};
let prev=null;if(carryFrom){try{prev=JSON.parse(await readFile(dir+carryFrom,'utf8'));}catch(e){say(`[suite] --carry: cannot read ${carryFrom}: ${e.message}; nothing will be reused`);}if(prev&&!Array.isArray(prev.rows)){say('[suite] --carry: not a report of this runner; nothing will be reused');prev=null;}}
const report={runId,startedAt,quick,only,carry:carryFrom?{report:carryFrom,runId:prev?.runId||null,readable:Boolean(prev)}:null,build,rows:[]};
say(`[suite] run ${runId}; fingerprinting inputs…`);
for(const s of SUITES){
 if(only&&!only.some(o=>s.name.includes(o)||s.file.includes(o))){report.rows.push({...s,skipped:true});say(`[suite] SKIP ${s.name} (--only)`);continue;}
 const inputs=await fingerprint(s,{root:dir,toolchain});const cur={...s,inputs,runId};
 if(inputs.missing.length)say(`  [${s.name}] inputs missing: ${inputs.missing.join(', ')}`);
 const prevRow=prev?.rows?.find(r=>r.file===s.file);const reuse=prev?canReuse(prevRow,cur):{ok:false,reason:'no --carry report'};
 if(reuse.ok){report.rows.push({...cur,ok:true,reused:true,pass:prevRow.pass,fail:prevRow.fail,seconds:prevRow.seconds,log:prevRow.log,origin:reuse.origin});say(`[suite] REUSED ${s.name}: ${prevRow.pass}/${prevRow.pass} (executed ${reuse.origin.executedAt} in run ${reuse.origin.runId}; identical inputs: ${inputs.fileCount} files, digest ${inputs.digest.slice(0,16)}…)`);continue;}
 if(carryFrom)say(`  [${s.name}] not reused: ${reuse.reason}`);
 say(`[suite] ${s.name} (${s.file})…`);const executedAt=new Date().toISOString();const r=await run(s);const ok=r.code===0&&r.fail===0&&!r.timedOut;
 report.rows.push({...cur,...r,ok,executed:true,executedAt,build,notReused:carryFrom?reuse.reason:undefined});
 say(`[suite] ${ok?'PASS':'FAIL'} ${s.name}: ${r.pass}/${(r.pass||0)+(r.fail||0)} in ${r.seconds}s${ok?'':' ('+(r.timedOut?'timeout; ':'')+'exit '+r.code+'; see '+r.log+')'}`);}
let stagenet=null;try{stagenet=JSON.parse(await readFile(dir+'../privacy-stagenet-wallet-20261024/runs/stagenet-popup-results.json','utf8'));}catch{}
report.stagenetRealPopup=stagenet?{execution:stagenet.execution,evidence:stagenet.evidence,send1:stagenet.results?.send1?.txid,lostReply:stagenet.results?.lost?.txid,balances:stagenet.results?.balances,freshRecovery:stagenet.results?.freshRecovery,note:'retained result of the 24 Oct run; not re-run here'}:{note:'no retained stagenet result found'};
const summary=summarize(report.rows,{quick,only,fullCount:FULL_COUNT});
report.finishedAt=new Date().toISOString();Object.assign(report,summary);report.failedSuites=summary.failed;
await writeFile(dir+'runs/integration-report.json',JSON.stringify(report,null,1));
console.log(JSON.stringify({runId,passed:report.passed,complete:report.complete,claim:report.claim,executed:report.executed,reused:report.reused,failedSuites:report.failedSuites,suites:report.rows.map(r=>({name:r.name,ok:r.ok,pass:r.pass,fail:r.fail,seconds:r.seconds,reused:r.reused||undefined,origin:r.origin?.runId,skipped:r.skipped||undefined,inputs:r.inputs?.digest?.slice(0,16)}))},null,1));
process.exit(report.failedSuites?1:0);
