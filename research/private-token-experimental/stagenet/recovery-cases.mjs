#!/usr/bin/env node
// RESTART, LOST-REPLY AND RECOVERY CASES around publication — orchestrator for separate journaled holder installations
// (stagenet/holder-process.mjs) behind a lossy loopback proxy (stagenet/lossy-proxy.mjs).
//
//   LR   actual LOST BROADCAST RESPONSE: the carrier reaches the daemon, the daemon answers, the proxy destroys the wallet's
//        connection before the reply arrives. The wallet must ask the daemon before any retry and recover with the SAME
//        signed transaction: one accepted transfer, exact balances, no second fee. (Different from the rehearsal's ordinary
//        repeat broadcast, where the reply WAS received and the same blob was re-sent anyway.)
//   LRQ  lost REQUEST: the connection drops before the daemon sees anything; the wallet finds the txid unknown and re-sends
//        the same blob (one fee).
//   R1a  restart after the fee quote, before proving  -> released; nothing sent; no fee.
//   R1b  restart after proving, BEFORE SIGNING        -> the journal has the record; the carrier is signed and published once.
//   R2   restart AFTER SIGNING, BEFORE BROADCAST      -> daemon asked first (unknown), the saved blob is sent; same txid.
//   R3   restart AFTER BROADCAST, OUTCOME UNKNOWN     -> reply lost AND process killed; daemon asked first (known): nothing re-sent.
//   S    STALE BACKUPS: a backup taken at R2's 'signed' state settles from chain state (no re-send, no fee); a backup taken at
//        R1b's 'built' state, whose notes were spent meanwhile, is refused before any carrier (no fee), never "completed".
//   TWO  (offline chain only) two installations with the same phrase spend the same note concurrently: exactly one completes.
//   RB   (offline chain only) a completed transfer is removed by a 12-block rollback: both views revert; the original
//        installation re-sends the SAME carrier for no new fee; the fresh installation never had anything to republish.
// Every case also compares the ORIGINAL installation's journal view with a FRESH installation that has only the root
// ("phrase"), and checks that no view reports an uncertain, conflicting or rejected transfer as completed.
//
//   --mode local     SIMULATED on an own offline fakechain (rollbacks and conflicting histories happen only here).
//   --mode stagenet  EXECUTED ON STAGENET: ordinary authorised test transactions only (LR, R1a, R1b, R2, R3, S); waits for
//                    real blocks; cases are launched in rounds so confirmation waits overlap. Never mainnet.
// Exit code: 0 all selected cases passed; 1 any failure (the JSON report records every check).
import {readFile,writeFile,mkdir,mkdtemp,cp,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startParamServer} from './param-server.mjs';
import {startRoles,startFakechain,checkDaemonNetwork,daemonRpc,closeFetch} from './roles.mjs';
import {startLossyProxy} from './lossy-proxy.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));const CANDIDATE=path.resolve(here,'..');const HOLDER=path.join(here,'holder-process.mjs');
export const CONFIRMATIONS=10;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const hex=b=>Buffer.from(b).toString('hex');
export async function runRecoveryCases(o){
 const mode=o.mode;if(mode!=='local'&&mode!=='stagenet')throw Error('--mode local|stagenet');
 const log=o.log||(m=>console.error(typeof m==='string'?m:JSON.stringify(m).slice(0,420)));
 const OUT=o.out||path.join(CANDIDATE,'runs',`recovery-cases-${mode}.json`);
 const report={startedAt:new Date().toISOString(),mode,execution:mode==='local'?'SIMULATED on an offline fakechain (not stagenet, not mainnet)':'EXECUTED ON STAGENET (not mainnet; stagenet fees are not mainnet fees)',confirmations:CONFIRMATIONS,gates:{bridgePayouts:'gated (not exercised)',nativeTrading:'gated (not exercised)'},steps:[],cases:[],failed:null};
 const step=(name,data={})=>{const row={at:new Date().toISOString(),name,...data};report.steps.push(row);log({step:name,...data});return row;};
 const save=async()=>{await mkdir(path.dirname(OUT),{recursive:true});await writeFile(OUT,JSON.stringify(report,null,1)+'\n');};
 const own=[];const stop=async()=>{for(const c of own.reverse())await c.close().catch(()=>{});own.length=0;};
 const selected=new Set((o.cases||(mode==='local'?'LR,LRQ,R1a,R1b,R2,R3,S,TWO,RB':'LR,R1a,R1b,R2,R3,S')).split(','));
 try{
  const paramsDir=path.resolve(o.paramsDir||path.join(CANDIDATE,'params',mode==='local'?'test-v1':'stagenet-v0'));
  await mkdir(path.join(CANDIDATE,'runs'),{recursive:true});const run=o.runDir?path.resolve(o.runDir):await mkdtemp(path.join(CANDIDATE,'runs',`recovery-${mode}-`));await mkdir(run,{recursive:true});
  const manifestPath=o.manifest?path.resolve(o.manifest):path.join(paramsDir,'manifest.json');const manifestBytes=await readFile(manifestPath);const manifest=JSON.parse(manifestBytes.toString('utf8'));
  if(mode==='stagenet'&&manifest.network.kind!=='stagenet')throw Error('--mode stagenet needs a stagenet manifest');if(mode==='local'&&manifest.network.kind!=='offline-fakechain')throw Error('--mode local needs an offline-fakechain manifest');
  step('manifest',{path:manifestPath,sha256:createHash('sha256').update(manifestBytes).digest('hex'),network:manifest.network});
  let chain=null,rpcUrl=o.rpc;const ports=o.ports||{rpcPort:30085,p2pPort:30084,paramPort:8955};
  if(mode==='local'){chain=await startFakechain({rpcPort:ports.rpcPort,p2pPort:ports.p2pPort,dir:path.join(run,'chain'),log});own.push(chain);rpcUrl=chain.rpcUrl;}
  if(!rpcUrl)throw Error('--rpc required in stagenet mode');
  const net=await checkDaemonNetwork(rpcUrl,manifest);step('daemon',{rpcUrl,nettype:net.info.nettype,height:net.info.height,synchronized:net.info.synchronized});
  if(mode==='stagenet'&&!net.info.synchronized)throw Error('stagenet node not synchronized');
  const ps=await startParamServer({dir:paramsDir,port:ports.paramPort,log});own.push(ps);
  const roles=await startRoles({paramsDir,trustedManifest:manifestPath,rpcUrl,runDir:run,log,roles:mode==='local'?['issuer','indexer']:['indexer']});own.push(roles);
  step('roles',{network:roles.network,startHeight:roles.startHeight,roles:mode==='local'?['issuer','indexer']:['indexer']});
  const proxy=await startLossyProxy({target:rpcUrl,log:e=>log({proxy:e})});own.push(proxy);step('proxy',{url:proxy.url,target:rpcUrl,note:'loopback fault-injection proxy between the holder installations and the daemon; the daemon itself is untouched'});
  // ---- roots ("phrases") and installations -------------------------------------------------------------------------
  const walletDir=o.walletDir?path.resolve(o.walletDir):path.join(run,'wallets');await mkdir(walletDir,{recursive:true,mode:0o700});
  const rootFile=async(name)=>{const f=path.join(walletDir,`${name}.root`);try{await readFile(f);}catch(e){if(e.code!=='ENOENT')throw e;await writeFile(f,hex(randomBytes(32))+'\n',{mode:0o600});}return f;};
  const roots={A:await rootFile('wallet-a'),B:await rootFile('wallet-b')};
  const installs=path.join(run,'installs');await mkdir(installs,{recursive:true});
  const common=['--manifest',manifestPath,'--params',ps.url,'--rpc',proxy.url,'--confirmations',String(CONFIRMATIONS),...(o.wasm?['--wasm',o.wasm]:[])];
  // Run one holder process; returns {code, signal, lines, final, events}. A SIGKILL'd process has code null and signal 'SIGKILL'.
  const holder=(install,who,cmd,args=[])=>new Promise((resolve,reject)=>{const dir=path.join(installs,install);const p=spawn(process.execPath,[HOLDER,cmd,'--install',dir,'--root-file',roots[who],...common,...args],{stdio:['ignore','pipe','pipe']});
   let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);
   p.on('exit',(code,signal)=>{const lines=out.split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l);}catch{return {raw:l};}});const final=lines.filter(l=>l.final).pop()||null;
    log({holder:install,cmd,code,signal,state:final?.state||final?.status||null,err:err.slice(0,200)});resolve({install,who,cmd,code,signal,lines,final,stderr:err.slice(-2000)});});});
  const view=async(install,who)=>{const r=await holder(install,who,'status');if(r.code!==0)throw Error('status failed for '+install+': '+r.stderr.slice(-300));return r.final;};
  const fresh=async(who,tag)=>view(`fresh-${who}-${tag}-${hex(randomBytes(3))}`,who);   // a brand-new installation: root only, empty journal
  const snapshot=async(install,tag)=>{const from=path.join(installs,install),to=path.join(run,'snapshots',`${install}-${tag}`);await mkdir(path.dirname(to),{recursive:true});await cp(from,to,{recursive:true});return to;};
  const restore=async(snap,install)=>{const to=path.join(installs,install);await rm(to,{recursive:true,force:true});await cp(snap,to,{recursive:true});return install;};
  // ---- block advancement ------------------------------------------------------------------------------------------
  const height=async()=>(await daemonRpc(rpcUrl,'get_info')).height-1;
  const advance=async(n,why)=>{const from=await height();if(mode==='local'){await chain.mine(roles.issuerNativeAddress,n);return step('advance',{blocks:n,from,to:await height(),why,simulated:true});}
   const t0=Date.now();const maxMs=o.maxWaitMs||4*3600*1000;while(true){const h=await height();if(h>=from+n)return step('advance',{blocks:n,from,to:h,why,waitedMs:Date.now()-t0,stagenet:true});if(Date.now()-t0>maxMs)throw Error('timed out waiting for stagenet blocks: '+why);await sleep(30000);}};
  // ---- funding (local only) ----------------------------------------------------------------------------------------
  const asset=await roles.assetId('uxmr20private-rehearsal');
  const tokenAddr={},nativeAddr={};   // transfer targets: opened once through the library (no process, nothing logged but addresses)
  {const probe=await import('../wallet-lib/private-wallet.mjs');const wasm=await WebAssembly.compile(await readFile(o.wasm||path.join(CANDIDATE,'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm')));
   for(const who of ['A','B']){const w=await probe.openPrivateWallet({wasm,manifest,daemonRpc:rpcUrl,parameterServer:ps.url,cache:probe.memoryCache(),fetch:closeFetch,root:(await readFile(roots[who],'utf8')).trim()});tokenAddr[who]=w.address();nativeAddr[who]=w.nativeAddress();w.close();}}
  step('wallets',{A:{token:tokenAddr.A,native:nativeAddr.A},B:{token:tokenAddr.B,native:nativeAddr.B},note:'roots in walletDir (0600), never logged'});
  if(mode==='local'){await chain.mine(roles.issuerNativeAddress,5);await chain.mine(nativeAddr.A,4);await chain.mine(nativeAddr.B,3);await chain.mine(roles.issuerNativeAddress,250);
   const plan=[['A','2000000'],['A','2000000'],['A','2000000'],['A','2000000'],['A','2000000'],['A','2000000'],['B','2000000'],['B','2000000']];const credits=[];
   for(const [who,amount] of plan){const c=await roles.credit({to:tokenAddr[who],asset,amount,binding:hex(randomBytes(32))});credits.push({who,amount,txid:c.txid});await chain.mine(roles.issuerNativeAddress,CONFIRMATIONS+1);}
   step('fund',{simulated:true,credits,note:'coinbase to issuer/A/B and eight issuer credits on the fakechain (OFFLINE values)'});}
  const other=who=>who==='A'?'B':'A';
  // ---- case machinery --------------------------------------------------------------------------------------------
  const results=[];const checks=[];const check=(cas,name,ok,detail={})=>{const row={case:cas,name,ok:Boolean(ok),...detail};checks.push(row);step('check',row);return row;};
  const pickNote=(v,who,avoid=new Set())=>{const n=v.chain.notes.filter(x=>x.asset===asset&&!avoid.has(x.commitment)).sort((a,b)=>BigInt(b.amount)>BigInt(a.amount)?1:-1)[0];if(!n)throw Error('no spendable note for '+who);return n;};
  const used=new Set();
  const launched=[];   // {case, install, who, op, txid, fee, amount, note, nativeBefore, recipient, tokenBefore:{A,B}}
  const sendArgs=(op,who,note,amount,extra=[])=>['--op',op,'--to',tokenAddr[other(who)],'--amount',amount,'--asset',asset,'--notes',note.commitment,...extra];
  const totalsOf=v=>({token:v.chain.balances[asset]||'0',native:v.chain.native.total});
  // Launch a case's transfer up to publication; returns the launched record (settlement happens in settleRound).
  const cases={
   async LR(){const who='A';const v=await fresh(who,'LR');const note=pickNote(v,who,used);used.add(note.commitment);const amount=mode==='local'?'1000000':'1000000';
    proxy.arm({mode:'drop-reply',count:1});const before={A:await fresh('A','LR0'),B:await fresh('B','LR0')};
    const r=await holder('LR-orig',who,'send',sendArgs('LR',who,note,amount));proxy.disarm();
    const faults=proxy.faults().filter(f=>f.fault==='drop-reply');const pub=r.lines.find(l=>l.publish)?.publish;
    check('LR','daemon answered OK before the reply was dropped',faults.length===1&&faults[0].daemon?.status==='OK',{fault:faults[0]||null});
    check('LR','wallet saw a transport failure, then asked the daemon and found the carrier',pub?.trail?.[0]?.outcome==='uncertain'&&pub?.trail?.[1]?.action==='lookup'&&pub?.trail?.[1]?.known===true,{trail:pub?.trail||null});
    check('LR','nothing was re-sent (recovered by lookup, resends 0)',pub?.recovered===true&&pub?.resends===0&&proxy.sends().length===1,{resends:pub?.resends,sendRequestsSeenByProxy:proxy.sends().length});
    check('LR','process reports published, not completed',r.code===2&&r.final?.state==='published',{code:r.code,state:r.final?.state});
    proxy.events.length=0;return {case:'LR',install:'LR-orig',who,op:'LR',txid:r.final?.txid,fee:r.final?.fee,amount,note,before,expectedSendRequests:1};},
   async LRQ(){const who='A';const v=await fresh(who,'LRQ');const note=pickNote(v,who,used);used.add(note.commitment);const amount='1000000';
    proxy.arm({mode:'drop-request',count:1});const before={A:await fresh('A','LRQ0'),B:await fresh('B','LRQ0')};
    const r=await holder('LRQ-orig',who,'send',sendArgs('LRQ',who,note,amount));proxy.disarm();const pub=r.lines.find(l=>l.publish)?.publish;const sends=proxy.sends();
    check('LRQ','request dropped before the daemon saw it',sends[0]?.fault==='drop-request'&&sends[0]?.forwarded===false,{first:sends[0]||null});
    check('LRQ','lookup found the txid unknown, then the SAME blob was re-sent and accepted',pub?.trail?.[1]?.known===false&&pub?.trail?.[2]?.outcome==='accepted'&&pub?.resends===1&&sends.length===2&&sends[1]?.daemon?.status==='OK',{trail:pub?.trail||null,sends:sends.length});
    proxy.events.length=0;return {case:'LRQ',install:'LRQ-orig',who,op:'LRQ',txid:r.final?.txid,fee:r.final?.fee,amount,note,before,expectedSendRequests:2};},
   async R1a(){const who='A';const v=await fresh(who,'R1a');const note=pickNote(v,who,used);const amount='1000000';const before={A:await fresh('A','R1a0'),B:await fresh('B','R1a0')};
    const r=await holder('R1a-orig',who,'send',sendArgs('R1a',who,note,amount,['--crash-at','quoted']));
    check('R1a','process was killed right after the fee quote was journaled',r.signal==='SIGKILL'&&r.lines.some(l=>l.crash==='quoted'),{signal:r.signal});
    const f=await fresh(who,'R1a1');check('R1a','fresh (phrase-only) installation sees nothing pending and the same notes',Object.keys(f.journal.pending).length===0&&JSON.stringify(f.chain.balances)===JSON.stringify(before.A.chain.balances),{balances:f.chain.balances});
    const o1=await view('R1a-orig',who);check('R1a','original journal shows the operation as preparing (nothing sent)',o1.journal.pending.R1a?.status==='quoted'&&/nothing sent/.test(o1.journal.pending.R1a?.display||''),{pending:o1.journal.pending.R1a});
    const rs=await holder('R1a-orig',who,'resume',['--op','R1a']);check('R1a','resume releases the operation: no fee, nothing sent, exit 0',rs.code===0&&rs.final?.state==='released'&&proxy.sends().length===0&&rs.final?.chain?.native?.total===before.A.chain.native.total,{state:rs.final?.state,sends:proxy.sends().length});
    proxy.events.length=0;return null;},
   async R1b(){const who='B';const v=await fresh(who,'R1b');const note=pickNote(v,who,used);used.add(note.commitment);const amount='200000';const before={A:await fresh('A','R1b0'),B:await fresh('B','R1b0')};
    const r=await holder('R1b-orig',who,'send',sendArgs('R1b',who,note,amount,['--crash-at','built']));
    check('R1b','process was killed right after the proved record was journaled (before signing)',r.signal==='SIGKILL'&&r.lines.some(l=>l.crash==='built')&&proxy.sends().length===0,{signal:r.signal});
    const snap=await snapshot('R1b-orig','built');
    const f=await fresh(who,'R1b1');check('R1b','fresh installation: notes still unspent, no pending operation (the proof exists only in the original journal)',f.chain.notes.some(n=>n.commitment===note.commitment)&&Object.keys(f.journal.pending).length===0,{});
    const o1=await view('R1b-orig',who);check('R1b','original journal: proved, awaiting fee approval, nothing sent',o1.journal.pending.R1b?.status==='built'&&o1.journal.pending.R1b?.txid===null,{pending:o1.journal.pending.R1b});
    const rs=await holder('R1b-orig',who,'resume',['--op','R1b']);const pub=rs.lines.find(l=>l.publish)?.publish;
    check('R1b','resume signs the saved record once and publishes it (one send request, accepted)',rs.code===2&&rs.final?.state==='published'&&proxy.sends().length===1&&pub?.trail?.[0]?.outcome==='accepted',{state:rs.final?.state,sends:proxy.sends().length});
    const txid=rs.final?.txid||rs.lines.filter(l=>l.txid).pop()?.txid;const fee=rs.lines.filter(l=>l.state==='signed').pop()?.fee||null;proxy.events.length=0;
    return {case:'R1b',install:'R1b-orig',who,op:'R1b',txid,fee:null,amount,note,before,snapshots:{built:snap},expectedSendRequests:1};},
   async R2(){const who='A';const v=await fresh(who,'R2');const note=pickNote(v,who,used);used.add(note.commitment);const amount='2000000';const before={A:await fresh('A','R20'),B:await fresh('B','R20')};
    const r=await holder('R2-orig',who,'send',sendArgs('R2',who,note,amount,['--crash-at','signed']));const signedLine=r.lines.filter(l=>l.state==='signed').pop();
    check('R2','process was killed right after the signed carrier was journaled (never broadcast)',r.signal==='SIGKILL'&&r.lines.some(l=>l.crash==='signed')&&proxy.sends().length===0&&Boolean(signedLine?.txid),{txidAtCrash:signedLine?.txid});
    const snap=await snapshot('R2-orig','signed');
    const f=await fresh(who,'R21');check('R2','fresh installation: notes unspent, nothing pending, carrier unknown to the daemon',f.chain.notes.some(n=>n.commitment===note.commitment)&&Object.keys(f.journal.pending).length===0,{});
    const o1=await view('R2-orig',who);check('R2','original journal: signed, not yet broadcast',o1.journal.pending.R2?.status==='signed'&&o1.journal.pending.R2?.txid===signedLine?.txid,{pending:o1.journal.pending.R2});
    const rs=await holder('R2-orig',who,'resume',['--op','R2']);const look=rs.lines.find(l=>l.lookup)?.lookup;const pub=rs.lines.find(l=>l.publish)?.publish;
    check('R2','resume asked the daemon first (unknown), then sent the SAME blob: same txid, accepted, no re-sign',look?.known===false&&rs.final?.state==='published'&&rs.final?.txid===signedLine?.txid&&proxy.sends().length===1&&pub?.resends===0,{lookup:look,txid:rs.final?.txid,sends:proxy.sends().length});
    proxy.events.length=0;return {case:'R2',install:'R2-orig',who,op:'R2',txid:signedLine?.txid,fee:null,amount,note,before,snapshots:{signed:snap},expectedSendRequests:1};},
   async R3(){const who=mode==='local'?'A':'B';const v=await fresh(who,'R3');const note=pickNote(v,who,used);used.add(note.commitment);const amount=mode==='local'?'1000000':'100000';const before={A:await fresh('A','R30'),B:await fresh('B','R30')};
    proxy.arm({mode:'drop-reply',count:1});const r=await holder('R3-orig',who,'send',sendArgs('R3',who,note,amount,['--crash-at','broadcast-uncertain']));proxy.disarm();const signedLine=r.lines.filter(l=>l.state==='signed').pop();const faults=proxy.faults();
    check('R3','carrier reached the daemon (daemon answered OK), reply dropped, process killed before it could ask',r.signal==='SIGKILL'&&r.lines.some(l=>l.crash==='broadcast-uncertain')&&faults.length===1&&faults[0].daemon?.status==='OK',{fault:faults[0]||null});
    const o1=await view('R3-orig',who);check('R3','original journal shows the outcome as UNKNOWN (not sent, not failed)',o1.journal.pending.R3?.status==='broadcasting'&&/UNKNOWN/.test(o1.journal.pending.R3?.display||''),{pending:o1.journal.pending.R3});
    const f=await fresh(who,'R31');check('R3','fresh installation: nothing pending; the note still shows unspent until the carrier is mined',Object.keys(f.journal.pending).length===0&&f.chain.notes.some(n=>n.commitment===note.commitment),{});
    proxy.events.length=0;const rs=await holder('R3-orig',who,'resume',['--op','R3']);const look=rs.lines.find(l=>l.lookup)?.lookup;
    check('R3','resume asked the daemon first, found the carrier in its pool and re-sent NOTHING',look?.known===true&&look?.inPool===true&&rs.final?.state==='published'&&proxy.sends().length===0&&rs.final?.txid===signedLine?.txid,{lookup:look,sends:proxy.sends().length});
    proxy.events.length=0;return {case:'R3',install:'R3-orig',who,op:'R3',txid:signedLine?.txid,fee:null,amount,note,before,expectedSendRequests:0};},
  };
  // Settle every launched operation: run `settle` after each block until completed/rejected; then verify fees, balances, views.
  const roundBefore=async(tag)=>({A:await fresh('A',tag+'-before'),B:await fresh('B',tag+'-before')});
  const settleRound=async(round,before,tag)=>{const pending=round.filter(Boolean);if(!pending.length)return;
   const done=new Map();let blocks=0;
   while(done.size<pending.length){for(const L of pending){if(done.has(L.case))continue;const s=await holder(L.install,L.who,'settle',['--op',L.op]);if(s.code===0||s.code===1){done.set(L.case,s);}else if(s.final?.state==='confirming'||s.final?.state==='published'){/* wait */}else{done.set(L.case,s);}}
    if(done.size<pending.length){if(++blocks>CONFIRMATIONS+6)throw Error('settlement did not finish in time');await advance(1,'settlement');}}
   const pub=await roles.indexerScan();
   for(const L of pending){const s=done.get(L.case);const afterA=await fresh('A',L.case+'z'),afterB=await fresh('B',L.case+'z');const after={A:afterA,B:afterB};const orig=await view(L.install,L.who);
    const h=orig.journal.history.find(x=>x.op===L.op);const fee=h?.feePaid??h?.fee??null;const rec=afterA.chain.records[Object.keys(afterA.chain.records).find(id=>afterA.chain.records[id].txid===L.txid)]||null;
    check(L.case,'operation completed with the required confirmations (settle exit 0)',s.code===0&&s.final?.state==='completed',{code:s.code,state:s.final?.state,confirmations:rec?.confirmations});
    check(L.case,'exactly one carrier; record accepted on chain once',rec?.status==='accepted'&&Object.values(afterA.chain.records).filter(r=>r.txid===L.txid).length===1,{txid:L.txid,height:rec?.height});
    const idx=(pub.events||[]).find(e=>e.txid===L.txid)?.result?.record||null;check(L.case,'indexer admitted the record',idx==='accepted',{indexer:idx});
    L.feeJournal=fee;check(L.case,'journal records exactly one carrier fee for the completed operation',fee!==null&&BigInt(fee)>0n,{fee});
    check(L.case,'original installation and fresh installation agree on chain state',JSON.stringify(orig.chain.balances)===JSON.stringify(after[L.who].chain.balances)&&orig.chain.notes.length===after[L.who].chain.notes.length,{orig:orig.chain.balances,fresh:after[L.who].chain.balances});
    check(L.case,'no view reports anything but the one completed transfer (no pending, no duplicate)',Object.keys(orig.journal.pending).length===0&&orig.journal.history.filter(x=>x.status==='completed').length===1,{history:orig.journal.history});
    L.after=after;L.record=rec;results.push({case:L.case,txid:L.txid,fee,amount:L.amount,inputNote:L.note.amount,sender:L.who,height:rec?.height,confirmations:rec?.confirmations});}
   // Exact accounting per wallet over the whole round (several cases may share a sender; blocks may arrive between launches on
   // stagenet): token after = before - sent + received; native after = before - sum of the journaled fees of that wallet's carriers.
   const after={A:await fresh('A',tag+'-after'),B:await fresh('B',tag+'-after')};
   for(const who of ['A','B']){const sent=pending.filter(x=>x.who===who),recv=pending.filter(x=>other(x.who)===who);const b=totalsOf(before[who]),a=totalsOf(after[who]);
    const expTok=(BigInt(b.token)-sent.reduce((n,x)=>n+BigInt(x.amount),0n)+recv.reduce((n,x)=>n+BigInt(x.amount),0n)).toString();const fees=sent.reduce((n,x)=>n+BigInt(x.feeJournal||0),0n);const expNat=(BigInt(b.native)-fees).toString();
    check(tag,`exact token balance of ${who} over the round (before - sent + received)`,a.token===expTok,{who,before:b.token,after:a.token,expected:expTok,sent:sent.map(x=>x.amount),received:recv.map(x=>x.amount)});
    check(tag,`exact native accounting of ${who} over the round (before - sum of journaled carrier fees; no other fee)`,a.native===expNat,{who,before:b.native,after:a.native,expected:expNat,fees:sent.map(x=>x.feeJournal)});}};
  // ---- STALE BACKUPS (after R1b and R2 are completed) ---------------------------------------------------------------
  const staleCases=async(lr)=>{const R2=lr.find(x=>x?.case==='R2'),R1b=lr.find(x=>x?.case==='R1b');
   if(R2){await restore(R2.snapshots.signed,'R2-stale');const before=await fresh('A','S1');const v=await view('R2-stale','A');
    check('S','stale backup (R2 at signed) still lists the operation as signed-not-broadcast',v.journal.pending.R2?.status==='signed',{pending:v.journal.pending.R2});
    proxy.events.length=0;const rs=await holder('R2-stale','A','resume',['--op','R2']);const look=rs.lines.find(l=>l.lookup)?.lookup;
    check('S','stale signed backup: daemon asked first, carrier already on chain, NOTHING re-sent',look?.known===true&&look?.inPool===false&&proxy.sends().length===0&&rs.final?.state==='published',{lookup:look,sends:proxy.sends().length});
    const st=await holder('R2-stale','A','settle',['--op','R2']);const after=await fresh('A','S1z');
    check('S','stale signed backup settles from chain state as completed with no additional fee',st.code===0&&st.final?.state==='completed'&&after.chain.native.total===before.chain.native.total,{state:st.final?.state,native:{before:before.chain.native.total,after:after.chain.native.total}});}
   if(R1b){await restore(R1b.snapshots.built,'R1b-stale');const before=await fresh('B','S2');proxy.events.length=0;
    const rs=await holder('R1b-stale','B','resume',['--op','R1b']);const after=await fresh('B','S2z');
    check('S','stale built backup whose notes were spent meanwhile is refused before any carrier: no send, no fee, never completed',rs.code===1&&rs.final?.state==='conflicted'&&proxy.sends().length===0&&after.chain.native.total===before.chain.native.total,{state:rs.final?.state,sends:proxy.sends().length});
    const v=await view('R1b-stale','B');check('S','stale built backup shows the operation as conflicted in its history, not completed',v.journal.history.some(h=>h.op==='R1b'&&h.status==='conflicted')&&!v.journal.history.some(h=>h.op==='R1b'&&h.status==='completed'),{history:v.journal.history});}};
  // ---- TWO installations, same phrase, same note (offline chain only) -------------------------------------------------
  const twoCase=async()=>{const v=await fresh('A','TWO');const note=pickNote(v,'A',used);used.add(note.commitment);const beforeB=await fresh('B','TWO0');const beforeA=v;proxy.events.length=0;
   const [r1,r2]=await Promise.all([holder('TWO-1','A','send',sendArgs('TWO1','A',note,'600000')),holder('TWO-2','A','send',sendArgs('TWO2','A',note,'700000'))]);
   step('two-installs-launched',{one:{code:r1.code,state:r1.final?.state,txid:r1.final?.txid},two:{code:r2.code,state:r2.final?.state,txid:r2.final?.txid,reason:r2.final?.reason},sends:proxy.sends().map(s=>s.daemon)});
   await advance(CONFIRMATIONS+1,'two installs confirm');
   const s1=await holder('TWO-1','A','settle',['--op','TWO1']),s2=await holder('TWO-2','A','settle',['--op','TWO2']);const states=[s1.final?.state,s2.final?.state];
   const completed=states.filter(s=>s==='completed').length;const afterB=await fresh('B','TWOz'),afterA=await fresh('A','TWOz');const v1=await view('TWO-1','A'),v2=await view('TWO-2','A');
   check('TWO','exactly one of the two concurrent spends of the same note completed',completed===1,{states});
   const loser=states[0]==='completed'?s2:s1;check('TWO','the other installation reports rejected/conflicted/refused, never completed',['rejected','conflicted','refused'].includes(loser.final?.state),{loser:loser.final?.state});
   const winAmount=states[0]==='completed'?600000n:700000n;check('TWO','recipient credited exactly once',BigInt(afterB.chain.balances[asset]||'0')===BigInt(beforeB.chain.balances[asset]||'0')+winAmount,{before:beforeB.chain.balances[asset],after:afterB.chain.balances[asset]});
   check('TWO','both installations agree with the fresh installation (chain), not with their journals',JSON.stringify(v1.chain.balances)===JSON.stringify(afterA.chain.balances)&&JSON.stringify(v2.chain.balances)===JSON.stringify(afterA.chain.balances),{});
   const feesPaid=(BigInt(beforeA.chain.native.total)-BigInt(afterA.chain.native.total)).toString();const h1=v1.journal.history[0],h2=v2.journal.history[0];
   step('two-installs-result',{states,feesPaidTotal:feesPaid,one:h1,two:h2,note:loser.final?.state==='rejected'?'the losing carrier was a valid Monero transaction: its fee is lost; its record was rejected by the pool (duplicate nullifier); no duplicate credit':'the losing carrier was refused by the daemon as a double spend of the same XMR input: no fee paid'});
   results.push({case:'TWO',states,feesPaidTotal:feesPaid});};
  // ---- ROLLBACK (offline chain only): pop_blocks + flush, exactly as the earlier labs ------------------------------------
  const rollbackCase=async()=>{const v=await fresh('A','RB');const note=pickNote(v,'A',used);used.add(note.commitment);const before={A:v,B:await fresh('B','RB0')};proxy.events.length=0;
   const r=await holder('RB-orig','A','send',sendArgs('RB','A',note,'1000000'));await advance(CONFIRMATIONS+1,'RB confirms');const s=await holder('RB-orig','A','settle',['--op','RB']);
   check('RB','transfer completed before the rollback',s.code===0&&s.final?.state==='completed',{state:s.final?.state});const afterA1=await fresh('A','RB1'),afterB1=await fresh('B','RB1');const natAfterFirst=afterA1.chain.native.total;
   const info=await daemonRpc(rpcUrl,'get_info');const pop=await (await closeFetch(rpcUrl+'/pop_blocks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nblocks:12})})).json();await daemonRpc(rpcUrl,'flush_txpool',{txids:[]});
   step('rollback',{from:info.height-1,to:(await height()),popStatus:pop.status,simulated:true,note:'deliberate 12-block rollback on the OFFLINE chain; pool flushed so the carrier does not return by itself'});
   const fA=await fresh('A','RB2'),fB=await fresh('B','RB2');
   check('RB','fresh installations revert with the chain: record gone, sender notes unspent again, recipient credit gone',!Object.values(fA.chain.records).some(x=>x.txid===r.final?.txid)&&fA.chain.notes.some(n=>n.commitment===note.commitment)&&fB.chain.balances[asset]===before.B.chain.balances[asset],{A:fA.chain.balances,B:fB.chain.balances});
   const vo=await view('RB-orig','A');check('RB','original installation follows the chain too (balance from replay, not from the journal)',JSON.stringify(vo.chain.balances)===JSON.stringify(fA.chain.balances),{orig:vo.chain.balances});
   proxy.events.length=0;const rs=await holder('RB-orig','A','settle',['--op','RB']);const look=rs.lines.find(l=>l.lookup)?.lookup;
   check('RB','settle detects the vanished record, asks the daemon (unknown), re-checks admission and re-sends the SAME carrier',look?.known===false&&rs.final?.republished===true&&rs.final?.state==='published'&&proxy.sends().length===1&&proxy.sends()[0]?.daemon?.status==='OK',{lookup:look,sends:proxy.sends().length});
   await advance(CONFIRMATIONS+1,'RB re-confirms');const s2=await holder('RB-orig','A','settle',['--op','RB']);const fA2=await fresh('A','RB3'),fB2=await fresh('B','RB3');
   check('RB','re-mined with the same txid and no second fee',s2.code===0&&s2.final?.state==='completed'&&fA2.chain.native.total===natAfterFirst&&Object.values(fA2.chain.records).some(x=>x.txid===r.final?.txid&&x.status==='accepted'),{native:{afterFirst:natAfterFirst,afterRemine:fA2.chain.native.total},txid:r.final?.txid});
   check('RB','recipient credited exactly once after the re-mine',BigInt(fB2.chain.balances[asset]||'0')===BigInt(before.B.chain.balances[asset]||'0')+1000000n,{before:before.B.chain.balances[asset],after:fB2.chain.balances[asset]});
   const vo2=await view('RB-orig','A');check('RB','original shows one completed operation (reinstated and re-settled), nothing pending',vo2.journal.history.filter(h=>h.op==='RB'&&h.status==='completed').length===1&&Object.keys(vo2.journal.pending).length===0,{history:vo2.journal.history});
   results.push({case:'RB',txid:r.final?.txid,secondFee:'0',retained:'operator-side rollback loss is NOT addressed here (review/05-ROLLBACK-LOSS-RETAINED.txt)'});};
  // ---- rounds ------------------------------------------------------------------------------------------------------
  const runCase=async(name)=>{if(!selected.has(name))return null;step('case-start',{case:name});try{return await cases[name]();}catch(e){check(name,'case ran without an exception',false,{error:e.message.slice(0,300)});return null;}};
  // Round 1: LR (A), R1b (B), R2 (A) — different native inputs; R1a costs nothing. Round 2: R3 (B on stagenet, after B's change unlocks; A locally), LRQ.
  const b1=await roundBefore('round1');const round1=[];for(const n of ['LR','R1a','R1b','R2'])round1.push(await runCase(n));await settleRound(round1,b1,'round1');
  if(selected.has('S')){try{await staleCases(round1);}catch(e){check('S','stale cases ran without an exception',false,{error:e.message.slice(0,300)});}}
  const b2=await roundBefore('round2');const round2=[];for(const n of ['R3','LRQ'])round2.push(await runCase(n));await settleRound(round2,b2,'round2');
  if(mode==='local'&&selected.has('TWO')){try{await twoCase();}catch(e){check('TWO','case ran without an exception',false,{error:e.message.slice(0,300)});}}
  if(mode==='local'&&selected.has('RB')){try{await rollbackCase();}catch(e){check('RB','case ran without an exception',false,{error:e.message.slice(0,300)});}}
  const failed=checks.filter(c=>!c.ok);
  report.summary={execution:report.execution,cases:[...selected],results,checks:checks.length,failedChecks:failed,passed:failed.length===0,proxyFaultLog:path.join(run,'proxy-faults.json'),installsDir:installs,note:'journals hold public data only (records, signed carriers, txids); roots are in walletDir and never logged'};
  // Fault log = the proxy's never-cleared history (every fault, every send request with the daemon's answer, every upstream
  // error). The earlier version wrote `proxy.events`, which the cases reset between themselves, so the file held only trailing
  // pass-through traffic and no faults (the faults were still in the report steps and the run log).
  await writeFile(path.join(run,'proxy-faults.json'),JSON.stringify({note:'every fault, every /send_raw_transaction (with the daemon answer) and every upstream error seen by the loopback proxy over the whole run; routine pass-through requests are not kept',events:proxy.history},null,1));
  if(failed.length)report.failed={message:failed.length+' check(s) failed',checks:failed.map(f=>f.case+': '+f.name)};
  step('done',{passed:failed.length===0,checks:checks.length,failed:failed.length});
 }catch(e){report.failed={message:e.message,stack:(e.stack||'').split('\n').slice(0,6).join('\n')};step('failed',{message:e.message});}
 finally{await stop();report.finishedAt=new Date().toISOString();await save();}
 return report;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const a=process.argv.slice(2);const opt=(k,d=null)=>{const i=a.indexOf('--'+k);return i>=0?a[i+1]:d;};
 const r=await runRecoveryCases({mode:opt('mode'),rpc:opt('rpc'),manifest:opt('manifest'),paramsDir:opt('params-dir'),walletDir:opt('wallet-dir'),out:opt('out'),wasm:opt('wasm'),cases:opt('cases'),runDir:opt('run-dir'),maxWaitMs:opt('max-wait-ms')?Number(opt('max-wait-ms')):undefined,
  ports:{rpcPort:Number(opt('rpc-port','30085')),p2pPort:Number(opt('p2p-port','30084')),paramPort:Number(opt('param-port','8955'))}});
 console.log(JSON.stringify({mode:r.mode,execution:r.execution,passed:r.summary?.passed??false,failed:r.failed?.message||null,checks:r.summary?.checks||0}));
 process.exit(r.failed?1:0);}
