#!/usr/bin/env node
// STAGENET REHEARSAL HARNESS v2 — the complete two-wallet flow with stagenet-aware laboratory roles.
//
//   credit (lab issuer, XB3) -> private transfer A->B with EXACT change (1 note input) -> recovery of both wallets from
//   their roots in fresh instances -> transfer from recovered A (3 note inputs) -> transfer from recovered B (2 note
//   inputs) -> balances, fees, sizes, timings, indexer admission, uncertain-broadcast recovery (same blob re-sent).
//
// Two execution modes, reported explicitly in the output (never mixed up):
//   --mode local     SIMULATED: starts an offline zero-peer regtest fakechain, the static parameter server and the roles
//                    locally; mines blocks on demand. Fees/decoys are OFFLINE values, not stagenet, not mainnet.
//   --mode stagenet  EXECUTED ON STAGENET against an operator-controlled, already-synced stagenet node (--rpc). Waits for
//                    real blocks. Nothing is started for you except the roles (and the parameter server if --params is
//                    omitted). Requires stagenet XMR (faucet) on the three addresses printed by the preflight step.
// Normal Monero validation stays enabled (send_raw_transaction sanity checks ON whenever the network is not the fakechain).
// Mainnet is refused. Bridge payouts and native XMR trading are not part of this harness and remain gated.
//
// Usage (see README-STAGENET.txt for the exact stagenet setup):
//   node stagenet/rehearsal.mjs --mode local  [--start-height 40] [--out runs/rehearsal-local.json]
//   node stagenet/rehearsal.mjs --mode stagenet --rpc http://127.0.0.1:38081 --manifest <trusted manifest> \
//        --params-dir params/stagenet-v0 [--params http://127.0.0.1:8951] --wallet-dir runs/stagenet-wallets [--out …]
// Wallet roots (synthetic 32-byte secrets) are generated into --wallet-dir (mode 0600) on first use and are never logged.
import {readFile,writeFile,mkdir,mkdtemp,chmod} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openPrivateWallet,memoryCache} from '../wallet-lib/private-wallet.mjs';
import {checkManifest as independentManifestCheck,ledgerDomain} from '../independent/decode.mjs';
import {startParamServer} from './param-server.mjs';
import {startRoles,startFakechain,checkDaemonNetwork,daemonRpc,closeFetch} from './roles.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));const CANDIDATE=path.resolve(here,'..');
export const CONFIRMATIONS=10;      // lab setting (operator.mjs); not a reviewed mainnet depth
export const CREDITS=['5000000','3000000','2000000'];   // three notes for A: enables 1-, 3- and 2-input transfers with change
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const hex=b=>Buffer.from(b).toString('hex');const sum=a=>a.reduce((n,x)=>n+BigInt(x),0n);
export async function runRehearsal(o){
 const mode=o.mode;if(mode!=='local'&&mode!=='stagenet')throw Error('--mode local|stagenet');
 const OUT=o.out||path.join(CANDIDATE,'runs',`rehearsal-${mode}.json`);const log=o.log||(m=>console.error(typeof m==='string'?m:JSON.stringify(m).slice(0,400)));
 const report={startedAt:new Date().toISOString(),mode,execution:mode==='local'?'SIMULATED on an offline fakechain (not stagenet, not mainnet)':'EXECUTED ON STAGENET (not mainnet; stagenet fees are not mainnet fees)',sanityChecks:mode!=='local',gates:{bridgePayouts:'gated (not exercised)',nativeTrading:'gated (not exercised)'},steps:[],blocked:null,failed:null};
 const step=(name,data={})=>{const row={at:new Date().toISOString(),name,...data};report.steps.push(row);log({step:name,...data});return row;};
 const save=async()=>{await mkdir(path.dirname(OUT),{recursive:true});await writeFile(OUT,JSON.stringify(report,null,1)+'\n');};
 const blocked=async(reason,data={})=>{report.blocked={reason,...data};step('blocked',{reason,...data});await save();return report;};
 const ports=o.ports||{rpcPort:30081,p2pPort:30080,paramPort:8951};
 const own=[];const stop=async()=>{for(const c of own.reverse())await c.close().catch(()=>{});own.length=0;};
 const wallets={};
 try{
  // ---- parameters and manifest -------------------------------------------------------------------------------------
  const paramsDir=path.resolve(o.paramsDir||path.join(CANDIDATE,'params',mode==='local'?'test-v1':'stagenet-v0'));
  const runsDir=path.join(CANDIDATE,'runs');await mkdir(runsDir,{recursive:true});const run=await mkdtemp(path.join(runsDir,`rehearsal-${mode}-`));
  let manifestPath=o.manifest?path.resolve(o.manifest):path.join(paramsDir,'manifest.json');
  if(mode==='local'&&o.startHeight){// SIMULATION ONLY: a start height on the fakechain, written to a separate trusted copy (same file for roles and wallets).
   const m=JSON.parse(await readFile(manifestPath,'utf8'));m.network.startHeight=Number(o.startHeight);manifestPath=path.join(run,'trusted-manifest.json');await writeFile(manifestPath,JSON.stringify(m,null,1)+'\n');}
  const manifestBytes=new Uint8Array(await readFile(manifestPath));const manifest=JSON.parse(new TextDecoder().decode(manifestBytes));
  const ic=independentManifestCheck(manifest);if(!ic.ok)throw Error('manifest fails the independent structural checks: '+JSON.stringify(ic.problems));
  if(ledgerDomain(manifest.config)!==manifest.config.domain)throw Error('manifest ledger domain does not recompute');
  if(mode==='stagenet'&&manifest.network.kind!=='stagenet')throw Error('--mode stagenet needs a manifest with network.kind "stagenet"');
  if(mode==='local'&&manifest.network.kind!=='offline-fakechain')throw Error('--mode local needs an offline-fakechain manifest');
  step('manifest',{path:manifestPath,sha256:createHash('sha256').update(manifestBytes).digest('hex'),label:manifest.label,network:manifest.network,ledgerDomain:manifest.ledgerDomain});
  // ---- daemon ------------------------------------------------------------------------------------------------------
  let chain=null,rpcUrl=o.rpc;
  if(mode==='local'){chain=await startFakechain({rpcPort:ports.rpcPort,p2pPort:ports.p2pPort,dir:path.join(run,'chain'),log});own.push(chain);rpcUrl=chain.rpcUrl;}
  if(!rpcUrl)throw Error('--rpc <stagenet node JSON-RPC base URL> is required in stagenet mode');
  const net=await checkDaemonNetwork(rpcUrl,manifest);   // refuses mainnet / wrong network / wrong genesis
  step('daemon',{rpcUrl,nettype:net.info.nettype,height:net.info.height,synchronized:net.info.synchronized,offline:net.info.offline,busySyncing:net.info.busy_syncing,genesis:net.genesis,startHeight:net.startHeight});
  if(mode==='stagenet'&&!net.info.synchronized)return await blocked('stagenet node not synchronized; finish the sync first (this harness never starts a chain download)');
  if(mode==='stagenet'&&net.startHeight&&net.startHeight>net.info.height)return await blocked('manifest startHeight is above the node height');
  // ---- parameter server (transport only) -----------------------------------------------------------------------------
  let paramsUrl=o.params;if(!paramsUrl){const ps=await startParamServer({dir:paramsDir,port:ports.paramPort,log});own.push(ps);paramsUrl=ps.url;step('param-server',{url:paramsUrl,files:ps.files,note:'serves parameters.json and the two proving keys only; the wallets authenticate them against their own manifest'});}
  // ---- roles -------------------------------------------------------------------------------------------------------
  const roles=await startRoles({paramsDir,trustedManifest:manifestPath,rpcUrl,runDir:run,log});own.push(roles);
  step('roles',{network:roles.network,startHeight:roles.startHeight,issuerNativeAddress:roles.issuerNativeAddress,issuerTokenAddress:roles.issuerTokenAddress,trustedManifest:roles.trustedManifest});
  // ---- wallets -----------------------------------------------------------------------------------------------------
  const wasm=await WebAssembly.compile(await readFile(o.wasm||path.join(CANDIDATE,'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm')));
  const walletDir=o.walletDir?path.resolve(o.walletDir):path.join(run,'wallets');await mkdir(walletDir,{recursive:true});
  const rootOf=async(name)=>{const f=path.join(walletDir,`${name}.root`);try{const t=(await readFile(f,'utf8')).trim();if(!/^[0-9a-f]{64}$/.test(t))throw Error('bad root file '+f);return t;}catch(e){if(e.code!=='ENOENT')throw e;const r=hex(randomBytes(32));await writeFile(f,r+'\n',{mode:0o600});await chmod(f,0o600);return r;}};
  const roots={A:await rootOf('wallet-a'),B:await rootOf('wallet-b')};
  const open=async(name)=>openPrivateWallet({wasm,manifest,manifestBytes,daemonRpc:rpcUrl,parameterServer:paramsUrl,cache:memoryCache(),fetch:closeFetch,root:roots[name],onProgress:p=>{if(p.phase==='scan'&&p.height%2000===0)log({wallet:name,scan:p.height,target:p.target});}});
  let A=await open('A'),B=await open('B');wallets.A=A;wallets.B=B;
  step('wallets',{A:{token:A.address(),native:A.nativeAddress()},B:{token:B.address(),native:B.nativeAddress()},walletDir,note:'roots stored in walletDir (0600), never logged'});
  const syncAll=async()=>{const r={};for(const [k,w] of Object.entries(wallets)){const t=Date.now();const s=await w.sync();r[k]={tip:s.tip,startHeight:s.startHeight,ms:Date.now()-t};}return r;};
  step('sync',await syncAll());
  // ---- independent observation (stagenet only): a THIRD-PARTY public stagenet node is asked whether it saw each carrier
  // in its pool (relay evidence independent of who mines) and in which block it was confirmed. Failures of that node are
  // recorded, never fatal. The owner node's mining status is recorded so "mined by our own node" is never hidden.
  const publicRpc=mode==='stagenet'?(o.publicRpc||'http://node.monerodevs.org:38089'):null;
  const rawRpc=async(base,ep,body={})=>{const r=await closeFetch(base.replace(/\/$/,'')+'/'+ep,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});return r.json();};
  const publicView=async(txid)=>{if(!publicRpc)return null;try{const j=await rawRpc(publicRpc,'get_transactions',{txs_hashes:[txid]});const t=(j.txs||[])[0];return t?{node:publicRpc,inPool:t.in_pool,blockHeight:t.block_height||null,confirmations:t.confirmations??null}:{node:publicRpc,seen:false,status:j.status};}catch(e){return {node:publicRpc,error:e.message.slice(0,120)};}};
  const publicRelay=async(label,txid)=>{if(!publicRpc)return null;let v=null;for(let i=0;i<12;i++){v=await publicView(txid);if(v&&(v.inPool||v.blockHeight))break;await sleep(5000);}step('public-relay',{label,txid,...v,note:'third-party stagenet node asked whether it holds the carrier (relay evidence independent of our node)'});return v;};
  const miningStatus=async()=>{if(mode!=='stagenet')return null;try{const m=await rawRpc(rpcUrl,'mining_status');const s={active:m.active,threads:m.threads_count,speed:m.speed,address:m.address||null};step('mining-status',{...s,note:s.active?'the OWNER node is mining stagenet blocks itself (CPU); blocks it finds are not independent third-party mining':'the owner node is not mining; every block comes from other stagenet miners'});return s;}catch(e){step('mining-status',{error:e.message.slice(0,120)});return null;}};
  await miningStatus();
  // ---- block advancement: mine locally, WAIT on stagenet -------------------------------------------------------------
  const height=async()=>(await daemonRpc(rpcUrl,'get_info')).height-1;
  const advance=async(n,why)=>{const from=await height();const target=from+n;
   if(mode==='local'){await chain.mine(roles.issuerNativeAddress,n);return step('advance',{blocks:n,from,to:await height(),why,simulated:true});}
   const t0=Date.now();const maxMs=o.maxWaitMs||4*3600*1000;
   while(true){const h=await height();if(h>=target)return step('advance',{blocks:n,from,to:h,why,waitedMs:Date.now()-t0,stagenet:true});if(Date.now()-t0>maxMs)throw Error(`timed out waiting for ${n} stagenet blocks (${why})`);await sleep(30000);}};
  // ---- native funding (holder-paid carrier fees; issuer-paid credit carriers) ---------------------------------------
  if(mode==='local'){// coinbase to the issuer (credit carriers) and to A and B (their own carrier fees); 60-block maturity
   await chain.mine(roles.issuerNativeAddress,Math.max(0,(roles.startHeight||0)-(await height()))+5);await chain.mine(A.nativeAddress(),3);await chain.mine(B.nativeAddress(),3);await chain.mine(roles.issuerNativeAddress,250);step('fund',{simulated:true,note:'coinbase mined to issuer, A and B on the fakechain; matured. 250 further blocks give the gamma decoy sampler enough outputs (a tiny chain hits the round limit); irrelevant on stagenet.'});}
  step('sync',await syncAll());
  const native=k=>{const n=wallets[k].native();return {unlocked:n.unlocked,locked:n.locked,outputs:n.outputs.length};};
  const issuerNative=(await roles.issuerScan()).issuerNative;
  step('native-balances',{issuer:issuerNative,A:native('A'),B:native('B')});
  const missing=[];if(BigInt(issuerNative)<=10_000_000_000n)missing.push({who:'issuer',address:roles.issuerNativeAddress,why:'the issuer pays the credit carriers; needs > 0.01 XMR unlocked'});
  for(const k of ['A','B'])if(BigInt(wallets[k].native().unlocked)===0n)missing.push({who:k,address:wallets[k].nativeAddress(),why:'holder-paid carrier fee; needs unlocked XMR (10 confirmations after funding)'});
  if(missing.length)return await blocked('native XMR funding missing',{fund:missing,note:mode==='stagenet'?'send stagenet XMR from a faucet to each address, wait 10 confirmations, rerun with the same --wallet-dir':'fakechain funding failed'});
  // ---- credits -----------------------------------------------------------------------------------------------------
  const asset=await roles.assetId('uxmr20private-rehearsal');
  // Resume support (stagenet only; the local fakechain always starts empty): notes that already exist in A or B when the
  // run starts come from EARLIER ATTEMPTS. A note whose amount matches a planned credit is REUSED (no replacement credit
  // is issued, no second issuer fee); every other pre-existing note is a BASELINE note that this run never spends or counts.
  const baseline={A:new Set(),B:new Set()};const baselineSum={A:0n,B:0n};const reused=[];let toIssue=[...CREDITS];
  if(mode==='stagenet'){const pre=A.status().notes.filter(n=>n.asset===asset);
   for(const n of pre){const i=toIssue.indexOf(n.amount);if(i>=0){toIssue.splice(i,1);reused.push({amount:n.amount,commitment:n.commitment,position:n.position});}else{baseline.A.add(n.commitment);baselineSum.A+=BigInt(n.amount);}}
   for(const n of B.status().notes.filter(n=>n.asset===asset)){baseline.B.add(n.commitment);baselineSum.B+=BigInt(n.amount);}
   const recs=Object.entries(A.status().records).map(([id,r])=>({recordId:id,txid:r.txid,height:r.height,status:r.status,kind:r.kind,confirmations:r.confirmations}));
   if(reused.length||baseline.A.size||baseline.B.size)step('resume',{reusedCredits:reused,stillToIssue:toIssue,baselineA:[...pre.filter(n=>baseline.A.has(n.commitment)).map(n=>({amount:n.amount,commitment:n.commitment}))],baselineB:[...baseline.B],recordsSeenByA:recs,note:'notes left by earlier attempts: planned amounts are reused (no replacement credit, no extra issuer fee); the rest are baseline notes this run never spends or counts'});}
  // On stagenet the issuer may hold only one or two faucet outputs: a credit's change relocks for CONFIRMATIONS blocks, so the
  // retry budget there is one block per attempt for CONFIRMATIONS+3 attempts (the local fakechain keeps its 4 attempts).
  const creditAttempts=mode==='local'?4:CONFIRMATIONS+3;
  const credits=reused.map(r=>({...r,reused:true}));for(const amount of toIssue){let c=null;for(let attempt=0;attempt<creditAttempts&&!c;attempt++){try{c=await roles.credit({to:A.address(),asset,amount,binding:hex(randomBytes(32))});}catch(e){if(!/native input|NotEnoughFunds|decoy selection|unlocked|too young|rejected/i.test(e.message)||attempt===creditAttempts-1)throw e;step('credit-retry',{amount,attempt,reason:e.message.slice(0,200)});await advance(1,'issuer input unlock / decoy retry');}}
   credits.push({amount,txid:c.txid,recordId:c.recordId,issuerFee:c.fee,extraBytes:c.extraBytes,nativeBytes:c.nativeBytes});step('credit',{amount,txid:c.txid,recordId:c.recordId,issuerFee:c.fee,extraBytes:c.extraBytes,nativeBytes:c.nativeBytes,note:'issuer-funded carrier (issuer fee, not holder fee)'});
   await publicRelay('credit '+amount,c.txid);}
  {// Confirmations: freshly issued credits need CONFIRMATIONS blocks; reused credits only need whatever is still missing.
   let need=CONFIRMATIONS;if(toIssue.length===0){const confs=Object.values(A.status().records).filter(r=>r.status==='accepted').map(r=>Number(r.confirmations));need=Math.max(0,CONFIRMATIONS-(confs.length?Math.min(...confs):0));}
   if(need>0)await advance(need,'credits confirm');}step('sync',await syncAll());
  for(const c of credits){if(c.reused)continue;const v=await publicView(c.txid);if(v)step('public-confirmation',{label:'credit '+c.amount,txid:c.txid,...v});}
  const expectNotes=(k,amounts,why)=>{const st=wallets[k].status();const have=st.notes.filter(n=>n.asset===asset&&!baseline[k].has(n.commitment)).map(n=>n.amount).sort();const want=[...amounts].sort();const ok=JSON.stringify(have)===JSON.stringify(want)&&(st.balances[asset]||'0')===String(sum(amounts)+baselineSum[k]);
   const row=step('assert-notes',{wallet:k,why,expected:want,actual:have,balance:st.balances[asset]||'0',baselineExcluded:baselineSum[k].toString(),ok});if(!ok)throw Error(`balance/notes mismatch for ${k} (${why}): expected ${want} got ${have}`);return row;};
  expectNotes('A',CREDITS,'after three credits');expectNotes('B',[],'untouched');
  const indexerSaw=(pub,txid)=>(pub.events||[]).find(e=>e.txid===txid)?.result?.record||null;   // indexer scan: {tip, tipHash, state, events[{height,txid,result}], canonicalBlocks}
  {const pub=await roles.indexerScan();const issued=credits.filter(c=>!c.reused);const admitted=issued.map(c=>indexerSaw(pub,c.txid));
   const reusedAdmitted=reused.length?Object.values(A.status().records).filter(r=>r.status==='accepted').map(r=>({txid:r.txid,indexer:indexerSaw(pub,r.txid)})):[];
   step('indexer',{credits:credits.length,issuedNow:issued.length,admittedByIndexer:admitted,reusedRecordsByIndexer:reusedAdmitted,tip:pub.tip});if(!admitted.every(a=>a==='accepted'))throw Error('indexer did not admit every credit: '+JSON.stringify(admitted));}
  // ---- a transfer with exact change, holder-paid fee, uncertain-broadcast re-send ------------------------------------
  const transfer=async(fromK,toK,amount,wantInputs,label)=>{const from=wallets[fromK],to=wallets[toK];const st=from.status();
   const notes=st.notes.filter(n=>n.asset===asset&&!baseline[fromK].has(n.commitment)).sort((a,b)=>BigInt(b.amount)>BigInt(a.amount)?1:-1).slice(0,wantInputs);
   if(notes.length!==wantInputs)throw Error(`${label}: wanted ${wantInputs} notes, have ${notes.length}`);
   const total=sum(notes.map(n=>n.amount));const change=total-BigInt(amount);if(change<0n)throw Error(label+': amount exceeds inputs');
   // On stagenet the sender's only native output may still be locked (its change from the previous carrier unlocks CONFIRMATIONS
   // blocks after inclusion, and inclusion is not deterministic as on the fakechain): wait block by block until something is unlocked.
   for(let i=0;mode==='stagenet'&&BigInt(from.native().unlocked)===0n;i++){if(i>=CONFIRMATIONS+2)throw Error(label+': sender has no unlocked native XMR after waiting');step('wait-unlock',{label,wallet:fromK,locked:from.native().locked,outputs:from.native().outputs.length});await advance(1,label+' sender native unlock');await syncAll();}
   const nBefore=from.native();const totalBefore=BigInt(nBefore.unlocked)+BigInt(nBefore.locked);
   const tq=Date.now();const q=await from.quoteCarrier({kind:'send'});const quoteMs=Date.now()-tq;
   step('fee-review',{label,fee:q.fee,weight:q.weight,feePerWeight:q.feePerWeight,ringSize:q.ringSize,inputAmount:q.inputAmount,changeAmount:q.changeAmount,quoteMs,feeBasis:mode==='local'?'OFFLINE fakechain fee rate (not a real-network fee)':'stagenet dynamic fee rate (not a mainnet fee)',note:'the holder wallet pays this XMR fee from its own output; shown before approval'});
   const tp=Date.now();const built=await from.prove({kind:'send',to:to.address(),amount:String(amount),notes:notes.map(n=>n.commitment)});const provingMs=Date.now()-tp;
   const ts=Date.now();const carrier=from.signCarrier(q.quoteId,built.wire);const signMs=Date.now()-ts;
   const local=from.verify(built.wire).record;
   step('proof',{label,inputs:notes.length,inputAmounts:notes.map(n=>n.amount),amount:String(amount),change:change.toString(),recordId:built.recordId,recordBytes:built.bytes,provingMs,signMs,localAdmission:local,memoryBytes:from.memoryBytes()});
   if(local!=='accepted')throw Error(label+': record not admissible locally');
   const pub=await from.publish(carrier.blob);step('publish',{label,txid:carrier.txid,fee:carrier.fee,extraBytes:carrier.extraBytes,nativeBytes:carrier.nativeBytes,ok:pub.ok,status:pub.status,reason:pub.reason||null,sanityChecks:mode!=='local'});
   if(!pub.ok)throw Error(`${label}: native transaction refused by the daemon: ${pub.reason||pub.status} (token proof was valid locally)`);
   // Uncertain broadcast: the reply might have been lost; the SAME blob is re-sent. monerod accepts or reports it already known; never a second payment.
   const again=await from.publish(carrier.blob);const inPool=await from.inPool(carrier.txid);step('resend-same-blob',{label,txid:carrier.txid,ok:again.ok,status:again.status,reason:again.reason||null,inPool,note:'idempotent re-send after an uncertain broadcast; no new inputs, no second payment'});
   await publicRelay(label,carrier.txid);
   await advance(CONFIRMATIONS,label+' confirms');step('sync',await syncAll());
   {const v=await publicView(carrier.txid);if(v)step('public-confirmation',{label,txid:carrier.txid,...v});}
   const nAfter=from.native();const totalAfter=BigInt(nAfter.unlocked)+BigInt(nAfter.locked);const paid=(totalBefore-totalAfter).toString();
   const feeOk=paid===String(carrier.fee);step('fee-accounting',{label,wallet:fromK,nativeBefore:totalBefore.toString(),nativeAfter:totalAfter.toString(),paid,fee:String(carrier.fee),exact:feeOk,unlockedAfter:nAfter.unlocked,lockedAfter:nAfter.locked});
   if(!feeOk)throw Error(`${label}: native balance moved by ${paid}, fee was ${carrier.fee}`);
   const rec=from.status().records[built.recordId];const recTo=to.status().records[built.recordId];
   const idx=indexerSaw(await roles.indexerScan(),carrier.txid);
   step('admission',{label,recordId:built.recordId,sender:rec?.status||null,recipient:recTo?.status||null,indexer:idx});if(idx!=='accepted')throw Error(label+': indexer did not admit the record ('+idx+')');
   return {label,inputs:notes.length,amount:String(amount),change:change.toString(),fee:String(carrier.fee),txid:carrier.txid,recordId:built.recordId,provingMs,signMs,recordBytes:built.bytes,extraBytes:carrier.extraBytes,nativeBytes:carrier.nativeBytes};};
  const transfers=[];
  // T1: A -> B, ONE input (the 5,000,000 note), exact change 1,000,000.
  transfers.push(await transfer('A','B','4000000',1,'T1 one-input'));
  expectNotes('A',['3000000','2000000','1000000'],'after T1 (change 1,000,000 back to A)');expectNotes('B',['4000000'],'after T1');
  // ---- recovery from the roots in FRESH instances (nothing pending in a journal: this is phrase-style recovery) -------
  {const before={A:A.status(),B:B.status()};A.close();B.close();
   const t=Date.now();A=await open('A');B=await open('B');wallets.A=A;wallets.B=B;const s=await syncAll();
   for(const k of ['A','B']){const now=wallets[k].status();const same=JSON.stringify(now.balances)===JSON.stringify(before[k].balances)&&now.notes.length===before[k].notes.length;
    step('recovery',{wallet:k,fromRoot:true,balancesBefore:before[k].balances,balancesAfter:now.balances,notesBefore:before[k].notes.length,notesAfter:now.notes.length,same,sync:s[k],ms:Date.now()-t,note:'balances and notes rebuilt from the chain; a recovery root cannot reconstruct unpublished pending transactions (none were pending here)'});
    if(!same)throw Error('recovery mismatch for '+k);}}
  // T2: recovered A -> B, THREE inputs (3,000,000 + 2,000,000 + 1,000,000), exact change 500,000.
  transfers.push(await transfer('A','B','5500000',3,'T2 three-input (recovered A)'));
  expectNotes('A',['500000'],'after T2');expectNotes('B',['4000000','5500000'],'after T2');
  // T3: recovered B -> A, TWO inputs (4,000,000 + 5,500,000), exact change 500,000.
  transfers.push(await transfer('B','A','9000000',2,'T3 two-input (recovered B)'));
  expectNotes('A',['500000','9000000'],'after T3');expectNotes('B',['500000'],'after T3');
  // ---- summary -----------------------------------------------------------------------------------------------------
  report.summary={execution:report.execution,network:roles.network,startHeight:roles.startHeight,resumed:reused.length>0,credits,baselineNotesExcluded:{A:baselineSum.A.toString(),B:baselineSum.B.toString()},transfers,final:{A:A.status().balances,B:B.status().balances,nativeA:native('A'),nativeB:native('B')},
   fees:{basis:mode==='local'?'OFFLINE fakechain fee rate — not stagenet, not mainnet':'stagenet dynamic fee rate — not mainnet',holderPaid:transfers.map(t=>({label:t.label,fee:t.fee})),issuerPaid:credits.filter(c=>!c.reused).map(c=>({txid:c.txid,fee:c.issuerFee}))},
   inputCounts:transfers.map(t=>t.inputs),recoveryTested:'roots in fresh instances (both wallets) between T1 and T2',uncertainBroadcast:'same blob re-sent after every publish',
   independentObservation:publicRpc?{node:publicRpc,relay:report.steps.filter(s=>s.name==='public-relay').map(s=>({label:s.label,inPool:s.inPool??null,blockHeight:s.blockHeight??null,error:s.error||null})),confirmed:report.steps.filter(s=>s.name==='public-confirmation').map(s=>({label:s.label,blockHeight:s.blockHeight??null,confirmations:s.confirmations??null,error:s.error||null}))}:null,
   ownerNodeMining:report.steps.filter(s=>s.name==='mining-status').map(s=>({active:s.active??null,threads:s.threads??null})),gates:report.gates};
  step('done',{transfers:transfers.length,inputs:report.summary.inputCounts});
 }catch(e){report.failed={message:e.message,stack:(e.stack||'').split('\n').slice(0,6).join('\n')};step('failed',{message:e.message});}
 finally{for(const w of Object.values(wallets)){try{w.close();}catch{}}await stop();report.finishedAt=new Date().toISOString();await save();}
 return report;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const a=process.argv.slice(2);const opt=(k,d=null)=>{const i=a.indexOf('--'+k);return i>=0?a[i+1]:d;};
 const r=await runRehearsal({mode:opt('mode'),rpc:opt('rpc'),publicRpc:opt('public-rpc'),params:opt('params'),paramsDir:opt('params-dir'),manifest:opt('manifest'),walletDir:opt('wallet-dir'),out:opt('out'),wasm:opt('wasm'),startHeight:opt('start-height'),maxWaitMs:opt('max-wait-ms')?Number(opt('max-wait-ms')):undefined,
  ports:{rpcPort:Number(opt('rpc-port','30081')),p2pPort:Number(opt('p2p-port','30080')),paramPort:Number(opt('param-port','8951'))}});
 console.log(JSON.stringify({mode:r.mode,execution:r.execution,blocked:r.blocked?.reason||null,failed:r.failed?.message||null,transfers:r.summary?.transfers?.length||0,steps:r.steps.length}));
 process.exit(r.failed?1:r.blocked?3:0);}
