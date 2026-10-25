#!/usr/bin/env node
// ONE INTEGRATION SUITE for the release candidate: runs the unit, settlement, conformance, migration, vector, interop and
// real-popup suites that exist in this candidate, in order, with a single JSON report (runs/integration-report.json) and a
// nonzero exit if anything fails.
//   node integration-suite.mjs [--quick] [--carry <earlier integration-suite log>] [--only <substring,substring>]
//   --quick   skips the four long real-popup browser suites
//   --carry   carries over the PASS rows of an earlier run of THIS runner for suites whose file is unchanged since that run
//             started (the row is marked carried:true with its source; every file modified since is listed in the report)
// Every suite runs in its own process group with a bounded time. Its complete output streams to runs/suite-logs/<file>.log while it
// runs; failures and one heartbeat per minute are echoed live (bounded), so a stalled suite is visible and cannot block the run
// forever: at the bound its whole process group (test runner, test child, Chromium, fakechain) is terminated and the row FAILS.
// Everything here is SIMULATED on offline fakechains and LiteSVM unless the row says otherwise; the stagenet real-popup run
// (browser-stagenet.test.mjs, hours, faucet-limited) is NOT started here and is reported from its retained results instead.
import {spawn} from 'node:child_process';
import {writeFile,readFile,mkdir,stat,readdir,access} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const dir=fileURLToPath(new URL('./',import.meta.url));const argv=process.argv.slice(2);const quick=argv.includes('--quick');
const arg=f=>{const i=argv.indexOf(f);return i>=0?argv[i+1]:null;};const carryLog=arg('--carry');const only=arg('--only')?.split(',').filter(Boolean);
const MIN=60,EXT=dir+'wallet-extension/extension-private-holder-test';
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
 {name:'legacy migration: every catalog token, exact entitlement, per-mint fees',file:'migration/legacy-migration.test.mjs',kind:'SIMULATED fakechain + LiteSVM custody with the REAL mint account bytes',timeout:60*MIN},
 {name:'independent checker over the interop vectors',file:'independent/check.mjs',kind:'script (Node crypto only, no engine); exit 0 = every checkable rule matched, the rest listed as notCheckable',script:true,timeout:5*MIN},
 {name:'two-wallet interop: real popup A + CLI wallet B on one pool',file:'interop.test.mjs',kind:'SIMULATED fakechain; Playwright Chromium (local test extension) + wallet-lib CLI',browser:true,timeout:60*MIN},
 {name:'stagenet-aware roles (simulation)',file:'stagenet-roles.test.mjs',kind:'SIMULATED fakechain',timeout:30*MIN},
 ...(quick?[]:[
 {name:'real popup: carriers incl. actual lost reply',file:'browser-carrier.test.mjs',kind:'SIMULATED fakechain, Playwright Chromium',browser:true,timeout:60*MIN},
 {name:'real popup: recovery',file:'browser-recovery.test.mjs',kind:'SIMULATED',browser:true,timeout:60*MIN},
 {name:'real popup: journal recovery',file:'browser-journal-recovery.test.mjs',kind:'SIMULATED',browser:true,timeout:60*MIN},
 {name:'real popup: interruptions',file:'browser-interruptions.test.mjs',kind:'SIMULATED',browser:true,timeout:60*MIN}]),
];
const slug=s=>s.file.replace(/\.mjs$/,'').replace(/[\/.]/g,'-');
const sha=async f=>{try{return createHash('sha256').update(await readFile(f)).digest('hex');}catch{return null;}};
const say=t=>process.stderr.write(t+'\n');
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
// --carry: PASS rows of an earlier run of this runner, usable only for suites whose own file is unchanged since that run started.
let carried={},carryStarted=null,modifiedSince=[];
if(carryLog){const txt=await readFile(dir+carryLog,'utf8');carryStarted=(await stat(dir+carryLog)).birthtime;
 for(const m of txt.matchAll(/^\[suite\] (?:PASS|CARRIED) (.+?): (\d+)\/(\d+)(?: in (\d+)s)?/gm))carried[m[1]]={pass:+m[2],fail:+m[3]-+m[2],seconds:m[4]?+m[4]:null};
 const skip=new Set(['runs','evidence','node_modules','params','website','proof-of-concepts','output','review','extension-private-holder-test','extension-stagenet-test','target']);
 const walk=async(d,rel)=>{for(const e of await readdir(d,{withFileTypes:true})){if(skip.has(e.name)||e.isSymbolicLink())continue;const p=d+'/'+e.name,r=rel+e.name;if(e.isDirectory())await walk(p,r+'/');else if((await stat(p)).mtime>carryStarted)modifiedSince.push(r);}};
 await walk(dir.replace(/\/$/,''),'');}
await mkdir(dir+'runs/suite-logs',{recursive:true});
const report={startedAt:new Date().toISOString(),quick,only,carry:carryLog?{log:carryLog,started:carryStarted,modifiedSince}:null,
 build:{node:process.version,wasm:await sha(dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm'),extensionAppJs:await sha(EXT+'/app.js'),extensionHolderWorker:await sha(EXT+'/vendor/private-holder.worker.js'),extensionHolderWasm:await sha(EXT+'/vendor/holder.wasm'),testManifest:await sha(dir+'params/test-v1/manifest.json'),backendService:await sha(dir+'backend/service.mjs'),browserHarness:await sha(dir+'browser-harness.mjs')},rows:[]};
let failed=0;
for(const s of SUITES){
 if(only&&!only.some(o=>s.name.includes(o)||s.file.includes(o))){report.rows.push({...s,skipped:true});say(`[suite] SKIP ${s.name} (--only)`);continue;}
 const c=carried[s.name];const fileChanged=carryStarted&&(await stat(dir+s.file)).mtime>carryStarted;
 if(c&&c.fail===0&&!fileChanged){report.rows.push({...s,...c,ok:true,carried:true,from:carryLog});say(`[suite] CARRIED ${s.name}: ${c.pass}/${c.pass} (from ${carryLog})`);continue;}
 say(`[suite] ${s.name} (${s.file})…`);const r=await run(s);const ok=r.code===0&&r.fail===0&&!r.timedOut;if(!ok)failed++;report.rows.push({...s,...r,ok});
 say(`[suite] ${ok?'PASS':'FAIL'} ${s.name}: ${r.pass}/${(r.pass||0)+(r.fail||0)} in ${r.seconds}s${ok?'':' ('+(r.timedOut?'timeout; ':'')+'exit '+r.code+'; see '+r.log+')'}`);}
let stagenet=null;try{stagenet=JSON.parse(await readFile(dir+'../privacy-stagenet-wallet-20261024/runs/stagenet-popup-results.json','utf8'));}catch{}
report.stagenetRealPopup=stagenet?{execution:stagenet.execution,evidence:stagenet.evidence,send1:stagenet.results?.send1?.txid,lostReply:stagenet.results?.lost?.txid,balances:stagenet.results?.balances,freshRecovery:stagenet.results?.freshRecovery,note:'retained result of the 24 Oct run; not re-run here'}:{note:'no retained stagenet result found'};
report.finishedAt=new Date().toISOString();report.failedSuites=failed;report.passed=failed===0&&!only;
await writeFile(dir+'runs/integration-report.json',JSON.stringify(report,null,1));
console.log(JSON.stringify({passed:report.passed,failedSuites:failed,suites:report.rows.map(r=>({name:r.name,ok:r.ok,pass:r.pass,fail:r.fail,seconds:r.seconds,carried:r.carried||undefined,skipped:r.skipped||undefined}))},null,1));
process.exit(failed?1:0);
