// INDEPENDENT CHAIN OBSERVATION AS A GATE (not a log): the operator pays a confirmed burn only when every configured
// independent node reports the burn mined in the same block with CONFIRMATIONS; a disagreeing, unknowing or missing
// observer WITHHOLDS the payout. Three runs on the offline fakechain:
//   1. observer = a separate, unrelated fakechain (knows nothing)      -> payout withheld, redemption stays pending
//   2. requireObservers with no observer configured                     -> payout withheld
//   3. observer agrees (the primary node itself, as the only synced view available offline) -> paid exactly once
// LIMITATION (documented in CONFORMANCE.txt): offline there is no second node synced to the same fakechain, so agreement is
// demonstrated with the primary as observer; on public stagenet a third-party node's view was recorded by the rehearsal and
// recovery runs. Two honest nodes follow the same reorganisation: this gate does NOT remove counterexample A.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {Keypair,Transaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {startBackend} from '../backend/service.mjs';
import {startFakechain} from '../stagenet/roles.mjs';
import {createHolderEngine,createChainScanner} from '../wallet-extension/src/holder-engine.js';
import {createParameterLoader} from '../wallet-extension/src/holder-params.js';
import {createCarrierBuilder} from '../wallet-extension/src/holder-carrier.js';
const dir=fileURLToPath(new URL('../',import.meta.url));
const hex=b=>Buffer.from(b).toString('hex');
const closeFetch=(u,o={})=>fetch(u,{...o,headers:{...(o.headers||{}),connection:'close'}});
const MANIFEST=JSON.parse(await readFile(dir+'params/test-v1/manifest.json','utf8'));
const cache=(()=>{const m=new Map();return {get:async k=>m.get(k)||null,put:async(k,v)=>{m.set(k,v);},delete:async k=>{m.delete(k);}};})();
const pub=()=>{const a=ed25519.utils.randomPrivateKey(),b=ed25519.utils.randomPrivateKey();return {A:hex(ed25519.getPublicKey(a)),B:hex(ed25519.getPublicKey(b))};};
async function burnScenario(backend,wasm){const BASE=backend.url.replace(/\/$/,'');const rpc=backend.rpcUrl;
 const post=async(action,body)=>{const r=await closeFetch(`${BASE}/action/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
 const engine=await createHolderEngine({wasm});const d=engine.call({op:'derive',root:hex(randomBytes(32)),account:0});const loader=createParameterLoader({fetch:closeFetch,manifest:MANIFEST,engine,baseUrl:BASE,cache});engine.call({op:'params',manifest:MANIFEST,served:await loader.loadServedConfig()});
 const scanner=createChainScanner(engine,{rpc,fetch:closeFetch,genesis:MANIFEST.network.genesis});const carrier=createCarrierBuilder({engine,rpc,fetch:closeFetch});
 const sol=Keypair.generate();await post('register',{id:'A',sol:sol.publicKey.toBase58(),xmr:d.nativeAddress,...pub(),tokenAddress:d.tokenAddress});
 const prep=await post('depositPrepare',{id:'A',symbol:'X',amount:'50000000'});const tx=Transaction.from(Buffer.from(prep.transaction,'base64'));tx.sign(sol);await post('depositSubmit',{id:'A',nonce:prep.nonce,transaction:tx.serialize().toString('base64')});
 await post('fund',{id:'A',blocks:1});await post('mine',{blocks:50});await post('mine',{blocks:20});await scanner.sync();await loader.loadProvingKey(1);
 const X=backend.assets.X.asset;const note=engine.call({op:'status'}).notes.find(n=>n.asset===X);
 const rp=await post('redeemPrepare',{id:'A',symbol:'X'});const q=await carrier.quote({kind:'redeem'});const built=engine.call({op:'build',kind:'redeem',amount:note.amount,binding:rp.binding,notes:[note.commitment]});const burn=carrier.sign(q.quoteId,built.wire);assert.equal((await carrier.publish(burn.blob)).ok,true);
 await post('mine',{blocks:10});await scanner.sync();const st=await post('state',{id:'A'});const pay=st.assets.find(a=>a.symbol==='X').payouts.find(p=>p.txid===burn.txid);assert.ok(pay&&pay.confirmations>=10,'burn confirmed: '+JSON.stringify(pay));
 return {post,txid:burn.txid,amount:note.amount};}
test('independent observation gates payout admission',{timeout:1800000},async()=>{
 const wasm=await WebAssembly.compile(await readFile(dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm'));
 const evidence={execution:'SIMULATED (offline fakechains)',runs:[]};const run=await mkdtemp(path.join(dir,'runs','observer-gate-'));
 // An unrelated second fakechain = an observer that does not know the burn.
 const stranger=await startFakechain({rpcPort:30085,p2pPort:30084,dir:run+'/stranger'});
 try{
  // 1. Disagreeing observer -> withheld.
  {const b=await startBackend({rpcPort:30083,p2pPort:30082,httpPort:8953,origins:[],observers:[stranger.rpcUrl],log:()=>{}});try{const s=await burnScenario(b,wasm);
    const obs=await s.post('observe',{txid:s.txid});assert.equal(obs.ok,false);assert.match(obs.reason,/unknown/);
    await assert.rejects(s.post('payout',{symbol:'X',txid:s.txid}),/Payout withheld/);
    const after=(await s.post('state',{id:'A'})).assets.find(a=>a.symbol==='X').payouts.find(p=>p.txid===s.txid);assert.notEqual(after.status,'paid','nothing paid');
    evidence.runs.push({case:'disagreeing observer (unrelated chain)',observe:obs,payout:'withheld',status:after.status});}finally{await b.close();}}
  // 2. Observers required but none configured -> withheld.
  {const b=await startBackend({rpcPort:30083,p2pPort:30082,httpPort:8953,origins:[],observers:[],requireObservers:true,log:()=>{}});try{const s=await burnScenario(b,wasm);
    const obs=await s.post('observe',{txid:s.txid});assert.equal(obs.ok,false);assert.match(obs.reason,/no independent observer/);await assert.rejects(s.post('payout',{symbol:'X',txid:s.txid}),/Payout withheld/);
    evidence.runs.push({case:'observers required, none configured',observe:obs,payout:'withheld'});}finally{await b.close();}}
  // 3. Agreeing observer -> paid exactly once (repeat returns the same receipt, no second payout).
  {const b=await startBackend({rpcPort:30083,p2pPort:30082,httpPort:8953,origins:[],observers:['http://127.0.0.1:30083'],log:()=>{}});try{const s=await burnScenario(b,wasm);
    const obs=await s.post('observe',{txid:s.txid});assert.equal(obs.ok,true,JSON.stringify(obs));const p1=await s.post('payout',{symbol:'X',txid:s.txid});assert.equal(p1.status,'paid');const p2=await s.post('payout',{symbol:'X',txid:s.txid});assert.equal(p2.repeated,true,'second request repeats, does not pay again');
    evidence.runs.push({case:'agreeing observer',observe:{ok:obs.ok,height:obs.primary.height},payout:p1.status,repeat:p2.repeated,net:p1.net});}finally{await b.close();}}
  evidence.result='PASSED';
 }finally{await stranger.close();await mkdir(dir+'conformance/evidence',{recursive:true});await writeFile(dir+'conformance/evidence/observer-gated-payout-'+new Date().toISOString().slice(0,10)+'.json',JSON.stringify(evidence,null,1));}
});
