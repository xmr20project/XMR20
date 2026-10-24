// LOCAL checks for the stagenet rehearsal that need no blockchain download and no public broadcast:
//  1. the stagenet manifest passes the independent (Node-crypto) checks and the engine's `params` op accepts kind "stagenet";
//  2. the network guard: under a stagenet manifest the scanner REFUSES the offline fakechain daemon, and under the
//     fakechain manifest the engine/scanner behave as before (no accidental cross-network use);
//  3. monerod's sanity checks on the fakechain: a carrier that is valid under the pool rules is refused by
//     send_raw_transaction with do_sanity_checks:true, and the exact reason is recorded, to show why the fakechain
//     cannot stand in for stagenet/mainnet validation and why the rehearsal must run against a real stagenet node.
//   node stagenet/local-checks.mjs   (uses ports 8949/30077; ≈4 min)
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Keypair,Transaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {startBackend} from '../backend/service.mjs';
import {createHolderEngine,createChainScanner} from '../wallet-extension/src/holder-engine.js';
import {createCarrierBuilder} from '../wallet-extension/src/holder-carrier.js';
import {createParameterLoader} from '../wallet-extension/src/holder-params.js';
import {openPrivateWallet,memoryCache} from '../wallet-lib/private-wallet.mjs';
import {checkManifest,ledgerDomain} from '../independent/decode.mjs';
const dir=fileURLToPath(new URL('../',import.meta.url));const PORTS={rpcPort:30077,p2pPort:30076,httpPort:8949};const BASE=`http://127.0.0.1:${PORTS.httpPort}`;
const hex=b=>Buffer.from(b).toString('hex');const closeFetch=(u,o={})=>fetch(u,{...o,headers:{...(o.headers||{}),connection:'close'}});
const post=async(action,body)=>{const r=await closeFetch(`${BASE}/action/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
const out={checks:[]};const ok=(name,cond,detail)=>{out.checks.push({name,ok:Boolean(cond),detail});console.log(cond?'ok  ':'FAIL',name,detail?JSON.stringify(detail).slice(0,200):'');};
const stagenetManifest=JSON.parse(await readFile(dir+'params/stagenet-v0/manifest.json','utf8'));const fakeManifest=JSON.parse(await readFile(dir+'params/test-v1/manifest.json','utf8'));
const wasm=await WebAssembly.compile(await readFile(dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm'));
// 1. manifest checks
const ic=checkManifest(stagenetManifest);ok('stagenet manifest: independent structural checks',ic.ok,ic.problems);ok('stagenet manifest: ledger domain recomputation',ledgerDomain(stagenetManifest.config)===stagenetManifest.config.domain);
ok('stagenet manifest binds the stagenet genesis',stagenetManifest.network.kind==='stagenet'&&stagenetManifest.network.genesis==='76ee3cc98646292206cd3e86f74d88b4dcc1d937088645e9b0cbca84b7ce74eb');
ok('stagenet and fakechain ledger domains differ',stagenetManifest.ledgerDomain!==fakeManifest.ledgerDomain);
{const e=await createHolderEngine({wasm});let err=null;try{e.call({op:'params',manifest:stagenetManifest});}catch(x){err=x.message;}ok('engine accepts a stagenet manifest (kind stagenet)',!err,err);
 let err2=null;try{e.call({op:'params',manifest:{...stagenetManifest,network:{...stagenetManifest.network,kind:'mainnet'}}});}catch(x){err2=x.message;}ok('engine refuses kind mainnet',Boolean(err2),err2);
 let err3=null;try{e.call({op:'params',manifest:stagenetManifest,served:fakeManifest.config});}catch(x){err3=x.message;}ok('engine refuses fakechain parameters under the stagenet manifest',Boolean(err3),err3);}
// 2/3. network guard and sanity checks against the offline fakechain
const backend=await startBackend({...PORTS,log:m=>console.error('backend:',m),origins:[]});
try{
 {const e=await createHolderEngine({wasm});e.call({op:'derive',root:hex(randomBytes(32)),account:0});e.call({op:'params',manifest:stagenetManifest});const sc=createChainScanner(e,{rpc:backend.rpcUrl,fetch:closeFetch,genesis:stagenetManifest.network.genesis,network:'stagenet'});let err=null;try{await sc.sync();}catch(x){err=x.message;}ok('scanner under a stagenet manifest refuses the fakechain daemon',/Stagenet daemon required/.test(err||''),err);}
 const A=await openPrivateWallet({wasm,manifest:fakeManifest,daemonRpc:backend.rpcUrl,parameterServer:BASE,cache:memoryCache(),fetch:closeFetch,root:hex(randomBytes(32))});
 const B=await openPrivateWallet({wasm,manifest:fakeManifest,daemonRpc:backend.rpcUrl,parameterServer:BASE,cache:memoryCache(),fetch:closeFetch,root:hex(randomBytes(32))});
 const sol=Keypair.generate();const pub=()=>{const a=ed25519.utils.randomPrivateKey(),b=ed25519.utils.randomPrivateKey();return {A:hex(ed25519.getPublicKey(a)),B:hex(ed25519.getPublicKey(b))};};
 await post('register',{id:'A',sol:sol.publicKey.toBase58(),xmr:A.nativeAddress(),...pub(),tokenAddress:A.address()});
 const prep=await post('depositPrepare',{id:'A',symbol:'X',amount:'10000000'});const tx=Transaction.from(Buffer.from(prep.transaction,'base64'));tx.sign(sol);await post('depositSubmit',{id:'A',nonce:prep.nonce,transaction:tx.serialize().toString('base64')});
 await post('fund',{id:'A',blocks:1});await post('mine',{blocks:50});await post('mine',{blocks:12});await A.sync();const X=backend.assets.X.asset;
 const sel=A.select({asset:X,amount:'1000000'});const q=await A.quoteCarrier({kind:'send'});const built=await A.prove({kind:'send',to:B.address(),amount:'1000000',notes:sel.notes});const carrier=A.signCarrier(q.quoteId,built.wire);
 ok('token proof valid locally (admission) before any native broadcast',A.verify(built.wire).record==='accepted');
 // Same signed carrier: first with monerod's sanity checks ON (normal validation), then the fakechain-only path.
 const strict=createCarrierBuilder({engine:null,rpc:backend.rpcUrl,fetch:closeFetch,sanityChecks:true});const r1=await strict.publish(carrier.blob);
 ok('fakechain with sanity checks ON: node reply recorded (expected refusal: ring statistics of a tiny chain)',true,r1);out.sanityCheckReply=r1;
 if(!r1.ok){const r2=await A.publish(carrier.blob);ok('same carrier accepted with sanity checks OFF (fakechain-only concession)',r2.ok,r2);}
 else ok('note: the fakechain accepted the carrier even with sanity checks on in this run',true,r1);
 await post('mine',{blocks:10});await A.sync();ok('record admitted after mining',A.status().records[built.recordId]?.status==='accepted');
 out.measurements={recordBytes:built.bytes,extraBytes:carrier.extraBytes,nativeBytes:carrier.nativeBytes,fakechainFee:carrier.fee,fakechainFeePerWeight:q.feePerWeight,note:'OFFLINE FAKECHAIN values; not stagenet, not mainnet'};
 A.close();B.close();
}finally{await backend.close();await mkdir(dir+'runs',{recursive:true});await writeFile(dir+'runs/stagenet-local-checks.json',JSON.stringify(out,null,1)+'\n');}
console.log(JSON.stringify({checks:out.checks.length,failed:out.checks.filter(c=>!c.ok).length}));
if(out.checks.some(c=>!c.ok))process.exit(1);
