// PUBLIC STAGENET REHEARSAL of the unshielded-by-default format. TEST FUNDS ONLY (worthless stagenet XMR, synthetic tokens).
// Resumable: state lives in runs/stagenet-unshielded/state.json (synthetic holder roots created here — never real wallets,
// never published); every step is skipped once done, so a restart continues where it stopped. Waits for REAL stagenet
// confirmations (blocks every ~2 minutes); expect about two hours end to end.
//   node stagenet/run-unshielded.mjs            # run / resume
// Steps: register A,B · issuer pays A two and B one stagenet XMR outputs (test service; or faucet if the issuer is dry) ·
// issuer PUBLIC credit to A · public send A->B (1 tx) · shield (1 tx) · PRIVATE send A->B (2 txs) · B unshields (1 tx) ·
// B public burn (1 tx; no payout: there is no operator on stagenet) · replay/invariant/disclosure audit · results.json.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {startStagenetBackend} from '../backend/stagenet-service.mjs';
import {openTokenWallet,memoryCache} from '../wallet-lib/token-wallet.mjs';
const dir=fileURLToPath(new URL('../',import.meta.url));const RUN=dir+'runs/stagenet-unshielded/';await mkdir(RUN,{recursive:true});
const STATE=RUN+'state.json';let state={roots:{},steps:{},log:[]};try{state=JSON.parse(await readFile(STATE,'utf8'));}catch{}
const save=()=>writeFile(STATE,JSON.stringify(state,null,1));
const note=(m,x={})=>{const e={at:new Date().toISOString(),m,...x};state.log.push(e);console.error(JSON.stringify(e).slice(0,300));};
const hex=b=>Buffer.from(b).toString('hex');const closeFetch=(u,o={})=>fetch(u,{...o,headers:{...(o.headers||{}),connection:'close'}});
const EXPLORER='https://stagenet.xmrchain.net/tx/';const CONF=10;const PORT=8962;
const MANIFEST=JSON.parse(await readFile(dir+'params/stagenet-v1/manifest.json','utf8'));
if(MANIFEST.network.kind!=='stagenet')throw Error('stagenet manifest required');
const backend=await startStagenetBackend({httpPort:PORT,runDir:RUN+'backend',stateFile:RUN+'backend-state.json',log:m=>console.error('backend:',String(m).slice(0,200))});
const rpc=backend.rpcUrl,BASE=`http://127.0.0.1:${PORT}`;
const post=async(action,body)=>{const r=await closeFetch(`${BASE}/action/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
const other=async(path,body)=>(await closeFetch(rpc+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function confirmations(txid){const t=await other('/get_transactions',{txs_hashes:[txid],decode_as_json:false,prune:true});const x=(t.txs||[])[0];if(!x)return {known:false,confirmations:0};return {known:true,inPool:Boolean(x.in_pool),confirmations:x.in_pool?0:Number(x.confirmations||0)};}
async function waitConf(txid,n=CONF,label=''){for(let i=0;;i++){const c=await confirmations(txid);if(c.known&&c.confirmations>=n)return c;if(i%6===0)note('waiting for confirmations',{label,txid:txid.slice(0,16),have:c.confirmations,need:n,known:c.known});if(!c.known&&i>30)throw Error('carrier '+txid+' vanished from the node');await sleep(20000);}}
const cache=memoryCache();
async function open(name){if(!state.roots[name]){state.roots[name]=hex(randomBytes(32));await save();}return openTokenWallet({wasm:await WebAssembly.compile(await readFile(dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm')),manifest:MANIFEST,daemonRpc:rpc,parameterServer:BASE,cache,fetch:closeFetch,root:state.roots[name]});}
const done=k=>state.steps[k]?.done;const once=async(k,fn)=>{if(state.steps[k]?.checked)return;await fn();state.steps[k].checked=true;await save();};const mark=async(k,x={})=>{state.steps[k]={...(state.steps[k]||{}),...x,done:true,at:new Date().toISOString()};await save();};
const results={execution:'PUBLIC MONERO STAGENET (worthless test coins; synthetic tokens; Penumbra published keys)',explorer:EXPLORER,steps:[]};
const record=(k,x)=>{results.steps.push({step:k,...x});};
// Carrier through the real engine: plan -> quote -> sign -> publish (lookup-first), then wait for confirmations.
async function carry(w,kind,wire,part=0,label=kind){await w.sync();const len=wire.length/2;const q=await w.quoteCarrier({kind,wireLen:len});const s=w.signCarrier(q.quoteId,wire);if(s.fee!==q.fee)throw Error('fee differs from quote');const pub=await w.publishWithRecovery(s.blob,s.txid,{attempts:3});if(!pub.ok)throw Error('publish failed: '+JSON.stringify(pub).slice(0,300));
 note('carrier published',{label,part,txid:s.txid,fee:s.fee,recordBytes:len,extraBytes:s.extraBytes,nativeBytes:s.nativeBytes});return {txid:s.txid,fee:String(s.fee),recordBytes:len,extraBytes:s.extraBytes,nativeBytes:s.nativeBytes,explorer:EXPLORER+s.txid};}
try{
 const A=await open('A'),B=await open('B');
 for(const [id,w] of [['A',A],['B',B]])await post('register',{id,xmr:w.nativeAddress(),tokenAddress:w.address()});
 note('holders',{A:A.address().slice(0,24)+'…',B:B.address().slice(0,24)+'…',nativeA:A.nativeAddress(),nativeB:B.nativeAddress()});
 const asset=backend.asset;
 // 1. funding: the issuer's test wallet pays A two outputs and B one (0.02 sXMR each) in ONE stagenet transaction.
 if(!done('fund')){const iss=await backend.roles.issuerScan();const unlocked=BigInt(iss.issuerNative||'0');note('issuer stagenet balance',{unlocked:unlocked.toString()});
  // Three outputs of 0.002 sXMR (a stagenet carrier costs ~0.00005 sXMR at ~20,000 piconero/byte) fit one 0.01 sXMR faucet claim.
  if(unlocked<8_000_000_000n){if(!state.faucet?.txid){note('issuer below 0.008 sXMR: asking the public faucet for the issuer address (one claim per hour)');const out=await new Promise((res,rej)=>execFile('sh',[dir+'stagenet/faucet-claim.sh',backend.issuerNativeAddress,RUN+'faucet.jsonl'],{timeout:90000},(e,so,se)=>e?rej(Error(se||e.message)):res(so)));const r=JSON.parse(out.trim().split('\n').pop());if(!r.ok)throw Error('faucet refused: '+JSON.stringify(r).slice(0,200));state.faucet={txid:r.txid,at:r.at};await save();}
   await waitConf(state.faucet.txid,CONF,'faucet->issuer');await backend.roles.issuerScan();}
  const p=await backend.roles.pay([{address:A.nativeAddress(),amount:2_000_000_000n},{address:A.nativeAddress(),amount:2_000_000_000n},{address:B.nativeAddress(),amount:2_000_000_000n}]);note('issuer paid holders',p);await mark('fund',{txid:p.txid,fee:p.fee});}
 await waitConf(state.steps.fund.txid,CONF,'funding');record('fund',{txid:state.steps.fund.txid,explorer:EXPLORER+state.steps.fund.txid,outputs:'A x2, B x1 (0.02 sXMR each)',issuerFee:state.steps.fund.fee});
 await A.sync();await B.sync();note('native after funding',{A:A.native().unlocked,Aoutputs:A.native().outputs.length,B:B.native().unlocked});
 // 2. PUBLIC credit of 10 X to A by the issuer (issuer-paid carrier).
 if(!done('credit')){const c=await post('credit',{id:'A',symbol:'X'});await mark('credit',{txid:c.txid,amount:c.amount,fee:c.fee,recordId:c.recordId,extraBytes:c.extraBytes});}
 await waitConf(state.steps.credit.txid,CONF,'credit');await once('credit',async()=>{await A.sync();const pubA=A.status().public.balances[asset];if(pubA!==state.steps.credit.amount)throw Error('public credit not seen: '+pubA);});record('credit',{...state.steps.credit,explorer:EXPLORER+state.steps.credit.txid});
 // 3. public send 3 X A -> B (1 tx).
 if(!done('public')){const sel=A.selectPublic({asset,amount:'3000000'});const b=await A.build({kind:'public',asset,to:B.address(),amount:'3000000',notes:sel.notes});const c=await carry(A,'public',b.wire);await mark('public',{...c,recordId:b.recordId,change:b.change});}
 await waitConf(state.steps.public.txid,CONF,'public send');await once('public',async()=>{await A.sync();await B.sync();if(B.status().public.balances[asset]!=='3000000')throw Error('B public balance '+B.status().public.balances[asset]);});record('public send 3 X (1 tx)',state.steps.public);
 // 4. shield 5 X (A).
 if(!done('shield')){await A.sync();const sel=A.selectPublic({asset,amount:'5000000'});const b=await A.build({kind:'shield',asset,amount:'5000000',notes:sel.notes});const c=await carry(A,'shield',b.wire);await mark('shield',{...c,recordId:b.recordId,provingMs:b.provingMs});}
 await waitConf(state.steps.shield.txid,CONF,'shield');await once('shield',async()=>{await A.sync();if(A.status().shielded.balances[asset]!=='5000000')throw Error('shielded balance '+A.status().shielded.balances[asset]);});record('shield 5 X (1 tx)',state.steps.shield);
 // 5. PRIVATE send 2 X A -> B in TWO carriers (needs two spendable XMR outputs on A).
 if(!done('private')){await A.sync();const spendable=A.native().outputs.filter(o=>!o.spent&&!o.reserved&&A.native().tip>=o.unlockedAt).length;if(spendable<2){note('waiting for a second spendable XMR output on A',{spendable});await sleep(60000);throw Error('retry later: A has '+spendable+' spendable XMR outputs');}
  const sel=A.select({asset,amount:'2000000'});const b=await A.build({kind:'private',to:B.shieldedAddress(),amount:'2000000',notes:sel.notes});const ca=await carry(A,'private',b.wires[0],0,'private A');const cb=await carry(A,'private',b.wires[1],1,'private B');await mark('private',{a:ca,b:cb,op:b.op,recordIds:b.recordIds,provingMs:b.provingMs,change:b.change});}
 await waitConf(state.steps.private.a.txid,CONF,'private part A');await waitConf(state.steps.private.b.txid,CONF,'private part B');await once('private',async()=>{await A.sync();await B.sync();
 if(B.status().shielded.balances[asset]!=='2000000'||A.status().shielded.balances[asset]!=='3000000')throw Error('private transfer not applied: A '+A.status().shielded.balances[asset]+' B '+B.status().shielded.balances[asset]);});
 record('private send 2 X (2 txs)',state.steps.private);
 // 6. B unshields 1 X of its 2 X note (1 tx).
 if(!done('unshield')){await B.sync();const n=B.status().shielded.notes[0];const b=await B.build({kind:'unshield',amount:'1000000',notes:[n.commitment]});const c=await carry(B,'unshield',b.wire);await mark('unshield',{...c,recordId:b.recordId,provingMs:b.provingMs});}
 await waitConf(state.steps.unshield.txid,CONF,'unshield');await once('unshield',async()=>{await B.sync();if(B.status().public.balances[asset]!=='4000000'||B.status().shielded.balances[asset]!=='1000000')throw Error('unshield not applied');});record('unshield 1 X (1 tx)',state.steps.unshield);
 // 7. B burns 1 X publicly (no operator/payout on stagenet; the burn is recorded by the indexer).
 if(!done('burn')){await B.sync();const sel=B.selectPublic({asset,amount:'1000000'});const b=await B.build({kind:'burn',asset,amount:'1000000',binding:hex(randomBytes(32)),notes:sel.notes});const c=await carry(B,'burn',b.wire);await mark('burn',{...c,recordId:b.recordId});}
 await waitConf(state.steps.burn.txid,CONF,'burn');await once('burn',async()=>{await B.sync();if(B.status().public.balances[asset]!=='3000000')throw Error('burn not applied');});record('public burn 1 X (1 tx)',state.steps.burn);
 // 8. independent indexer vs holder replica, backing invariant, disclosure audit (both holders re-synced to the tip first; attempt 3 compared
 //    A's replica from before the unshield and the burn against the indexer and reported a mismatch that was the script's, not the ledger's).
 await A.sync();await B.sync();const st=await post('state',{id:'A'});const local=A.status().pool;const cmp={};for(const k of ['root','nullifiers','publicNotes','minted','burned','publicSupply','shieldedSupply','completedOperations'])cmp[k]=JSON.stringify(local[k])===JSON.stringify(st.pool[k]);
 if(Object.values(cmp).some(v=>!v))throw Error('indexer vs holder mismatch '+JSON.stringify(cmp));if(!st.pool.invariant.ok)throw Error('invariant broken');
 const needles=new Set();for(const w of [A,B])for(const o of w.native().outputs)needles.add(o.keyImage);const requests=await readFile(backend.run+'/requests.log','utf8').catch(()=>'');
 const wires=[];for(const k of ['public','shield','unshield','burn'])wires.push(state.steps[k].recordId);let leak=false;for(const n of needles)if(requests.toLowerCase().includes(n))leak=true;if(leak)throw Error('backend request log contains a native key image');
 results.audit={indexerEqualsHolder:cmp,invariant:st.pool.invariant,nativeKeyImagesChecked:needles.size,backendLogLeak:false};
 results.final={A:{public:A.status().public.balances[asset],shielded:A.status().shielded.balances[asset]},B:{public:B.status().public.balances[asset],shielded:B.status().shielded.balances[asset]},pool:st.pool,manifestSha256:backend.manifestSha256,startHeight:backend.startHeight};
 await writeFile(RUN+'results.json',JSON.stringify(results,null,1));note('STAGENET RUN COMPLETE',{results:RUN+'results.json'});await mark('complete');
}finally{await backend.close().catch(()=>{});}
