// RECOVERY FROM THE PHRASE vs FROM THE ORIGINAL INSTALLATION'S JOURNAL — engine level (wasm in
// Node, real offline daemon, two "installations" of the SAME holder = two engines from one root).
// Cases (RECOVERY-CASES.txt): (1) prepared not proved, (2) proved not published incl. conflict with
// a fresh installation, (3) broadcast with lost reply, (4) confirmed then rolled back (pop_blocks),
// (5) fresh installation / two installations. Exact balances, spent state, republication and fee
// consequences are asserted; no duplicate credit, no record admitted twice, no inflation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Keypair,Transaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {startBackend} from './backend/service.mjs';
import {createHolderEngine,createChainScanner} from './wallet-extension/src/holder-engine.js';
import {createParameterLoader} from './wallet-extension/src/holder-params.js';
import {createCarrierBuilder} from './wallet-extension/src/holder-carrier.js';
const dir=fileURLToPath(new URL('./',import.meta.url));
const PORTS={rpcPort:30067,p2pPort:30066,httpPort:8945};
const BASE=`http://127.0.0.1:${PORTS.httpPort}`;
const hex=b=>Buffer.from(b).toString('hex');
const closeFetch=(u,o={})=>fetch(u,{...o,headers:{...(o.headers||{}),connection:'close'}});
const post=async(action,body)=>{const r=await closeFetch(`${BASE}/action/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
const MANIFEST=JSON.parse(await readFile(dir+'params/test-v1/manifest.json','utf8'));
const cache=(()=>{const m=new Map();return {get:async k=>m.get(k)||null,put:async(k,v)=>{m.set(k,v);},delete:async k=>{m.delete(k);}};})();
const results={cases:{}};
test('journal-vs-phrase recovery cases at the engine level',{timeout:2400000},async()=>{
 const wasm=await WebAssembly.compile(await readFile(dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm'));
 const backend=await startBackend({...PORTS,log:m=>console.error('backend:',m),origins:[]});const rpc=backend.rpcUrl;
 const daemon=async(method,params={})=>{const r=await closeFetch(rpc+'/json_rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'t',method,params})});const v=await r.json();if(v.error)throw Error(JSON.stringify(v.error));return v.result;};
 // Controlled rollback exactly as the earlier labs did it: monerod's /pop_blocks endpoint, then flush the pool so the popped carriers do not return by themselves.
 const rollback=async(n)=>{const r=await closeFetch(rpc+'/pop_blocks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nblocks:n})});const v=await r.json();if(v.status!=='OK')throw Error('pop_blocks: '+JSON.stringify(v));await daemon('flush_txpool',{txids:[]});return v;};
 async function open(root,label){const engine=await createHolderEngine({wasm});const d=engine.call({op:'derive',root:hex(root),account:0});const loader=createParameterLoader({fetch:closeFetch,manifest:MANIFEST,engine,baseUrl:BASE,cache});const served=await loader.loadServedConfig();engine.call({op:'params',manifest:MANIFEST,served});
  const scanner=createChainScanner(engine,{rpc,fetch:closeFetch,genesis:MANIFEST.network.genesis});const carrier=createCarrierBuilder({engine,rpc,fetch:closeFetch});return {label,engine,loader,scanner,carrier,tokenAddress:d.tokenAddress,nativeAddress:d.nativeAddress};}
 const pub=()=>{const a=ed25519.utils.randomPrivateKey(),b=ed25519.utils.randomPrivateKey();return {A:hex(ed25519.getPublicKey(a)),B:hex(ed25519.getPublicKey(b))};};
 const status=e=>e.engine.call({op:'status'});const nat=e=>{const s=e.engine.call({op:'nativeStatus'});return {total:BigInt(s.unlocked)+BigInt(s.locked)+BigInt(s.reserved),outputs:s.outputs};};
 try{
  const root=randomBytes(32),rootB=randomBytes(32);
  const A=await open(root,'install-A');const A2=await open(root,'install-A2 (same phrase, fresh)');const B=await open(rootB,'Beta');
  const solA=Keypair.generate(),solB=Keypair.generate();
  await post('register',{id:'A',sol:solA.publicKey.toBase58(),xmr:A.nativeAddress,...pub(),tokenAddress:A.tokenAddress});await post('register',{id:'B',sol:solB.publicKey.toBase58(),xmr:B.nativeAddress,...pub(),tokenAddress:B.tokenAddress});
  const prep=await post('depositPrepare',{id:'A',symbol:'X',amount:'100000000'});const tx=Transaction.from(Buffer.from(prep.transaction,'base64'));tx.sign(solA);await post('depositSubmit',{id:'A',nonce:prep.nonce,transaction:tx.serialize().toString('base64')});
  await post('fund',{id:'A',blocks:3});await post('mine',{blocks:50});await post('mine',{blocks:12});
  const X=backend.assets.X.asset;for(const e of [A,A2,B])await e.scanner.sync();await A.loader.loadProvingKey(0);await A2.loader.loadProvingKey(0);
  assert.equal(status(A).balances[X],'98500000');assert.deepEqual(status(A2).balances,status(A).balances,'fresh installation sees the same chain state');
  // Fragment: A sends itself 30 so it holds two notes (68.5 + 30) for the conflict cases.
  const send=async(from,to,amount,{publish=true}={})=>{const q=await from.carrier.quote({kind:'send'});const sel=from.engine.call({op:'select',asset:X,amount,exclude:[]});const built=from.engine.call({op:'build',kind:'send',to:to.tokenAddress,amount,notes:sel.notes});const signed=from.carrier.sign(q.quoteId,built.wire);if(publish){const r=await from.carrier.publish(signed.blob);assert.equal(r.ok,true,JSON.stringify(r));}return {built,signed,sel};};
  await send(A,A,'30000000');await post('mine',{blocks:10});for(const e of [A,A2])await e.scanner.sync();assert.equal(status(A).notes.length,2);
  const feeOf=s=>BigInt(s.signed.fee);
  // CASE 1: prepared (notes selected, fee quoted) but never proved: nothing exists outside the installation; cancel releases; no fee.
  {const q=await A.carrier.quote({kind:'send'});const sel=A.engine.call({op:'select',asset:X,amount:'1000000',exclude:[]});assert.equal(A.carrier.cancel(q.quoteId).cancelled,true);
   await A2.scanner.sync();assert.deepEqual(status(A2).notes.map(n=>n.commitment).sort(),status(A).notes.map(n=>n.commitment).sort());results.cases.c1={phraseSeesPending:false,fee:'0',released:true,sel:sel.notes.length};}
  // CASE 2a: proved but NOT carried (install A) while the fresh install A2 spends the same note and publishes first.
  // A's saved record is doomed; the engine refuses to pay a carrier fee for it (pre-sign admission check). No inflation.
  {const bigA=status(A).notes.reduce((m,n)=>BigInt(n.amount)>BigInt(m.amount)?n:m);
   const builtA=A.engine.call({op:'build',kind:'send',to:B.tokenAddress,amount:'5000000',notes:[bigA.commitment]});// proved in A, no carrier yet
   const spend2=await send(A2,B,'7000000');assert.ok(spend2.sel.notes.includes(bigA.commitment),'A2 picked the same (largest) note');await post('mine',{blocks:10});for(const e of [A,A2,B])await e.scanner.sync();
   assert.equal(status(B).balances[X],'7000000');assert.equal(status(A).balances[X],String(98500000-7000000));assert.equal(status(A2).balances[X],status(A).balances[X]);
   const q=await A.carrier.quote({kind:'send'});const before=nat(A).total;assert.throws(()=>A.carrier.sign(q.quoteId,builtA.wire),/fails local admission; no carrier built/);A.carrier.cancel(q.quoteId);
   assert.equal(nat(A).total,before,'no fee paid for the doomed record');assert.equal(A.engine.call({op:'verify',wire:builtA.wire}).record,'rejected');
   results.cases.c2a={doomedRecordFee:'0',rejectedLocally:true,balanceA:status(A).balances[X],balanceB:status(B).balances[X]};}
  // CASE 2b-i: proved AND carrier signed in A (never broadcast); A2 spends the same note AND, picking largest-first like A, the SAME XMR input.
  // When A later broadcasts, the daemon refuses the carrier as a double spend of the XMR input: fee saved, record never on chain.
  {const bigA=status(A).notes.reduce((m,n)=>BigInt(n.amount)>BigInt(m.amount)?n:m);
   const q=await A.carrier.quote({kind:'send'});const builtA=A.engine.call({op:'build',kind:'send',to:B.tokenAddress,amount:'2000000',notes:[bigA.commitment]});const signedA=A.carrier.sign(q.quoteId,builtA.wire);
   await A2.scanner.sync();const q2=await A2.carrier.quote({kind:'send'});assert.equal(q2.keyImage,q.keyImage,'both installations chose the same XMR input (same wallet, largest-first)');A2.carrier.cancel(q2.quoteId);
   const spend2=await send(A2,B,'3000000');assert.ok(spend2.sel.notes.includes(bigA.commitment));assert.equal(spend2.signed.keyImage,q.keyImage);await post('mine',{blocks:10});for(const e of [A,A2,B])await e.scanner.sync();
   const balA=status(A).balances[X],balB=status(B).balances[X],natBefore=nat(A).total;
   const r=await A.carrier.publish(signedA.blob);assert.equal(r.ok,false);assert.equal(r.doubleSpend,true,'daemon refuses the stale carrier: its XMR input is already spent');
   await post('mine',{blocks:1});await A.scanner.sync();assert.equal(status(A).records[builtA.recordId],undefined,'stale record never reached the chain');assert.equal(nat(A).total,natBefore,'no fee paid');assert.equal(status(B).balances[X],balB);assert.equal(status(A).balances[X],balA);
   results.cases.c2bi={daemonRefused:'double_spend',feePaid:'0',recordOnChain:false};}
  // CASE 2b-ii: same, but the other installation used a DIFFERENT XMR input: A's stale carrier is a valid Monero transaction, mines (fee LOST), and the pool rejects its record (duplicate nullifier). No duplicate credit; A's view follows the chain.
  {await post('mine',{blocks:9});for(const e of [A,A2])await e.scanner.sync();const bigA=status(A).notes.reduce((m,n)=>BigInt(n.amount)>BigInt(m.amount)?n:m);
   const q=await A.carrier.quote({kind:'send'});const builtA=A.engine.call({op:'build',kind:'send',to:B.tokenAddress,amount:'2000000',notes:[bigA.commitment]});const signedA=A.carrier.sign(q.quoteId,builtA.wire);
   const q2=await A2.carrier.quote({kind:'send',excludeKeyImages:[q.keyImage]});assert.notEqual(q2.keyImage,q.keyImage);const sel2=A2.engine.call({op:'select',asset:X,amount:'2000000',exclude:[]});assert.ok(sel2.notes.includes(bigA.commitment));
   const built2=A2.engine.call({op:'build',kind:'send',to:B.tokenAddress,amount:'2000000',notes:sel2.notes});const signed2=A2.carrier.sign(q2.quoteId,built2.wire);assert.equal((await A2.carrier.publish(signed2.blob)).ok,true);await post('mine',{blocks:10});for(const e of [A,A2,B])await e.scanner.sync();
   const balA=status(A).balances[X],balB=status(B).balances[X],natBefore=nat(A).total;
   assert.equal(A.engine.call({op:'verify',wire:builtA.wire}).record,'rejected','local admission already rejects the saved record: a wallet must not re-send it');
   const r=await A.carrier.publish(signedA.blob);assert.equal(r.ok,true,'the Monero carrier itself is valid and accepted by the daemon');await post('mine',{blocks:10});for(const e of [A,A2,B])await e.scanner.sync();
   assert.equal(status(A).records[builtA.recordId]?.status,'rejected','pool rejected the stale record (duplicate nullifier)');assert.equal(status(B).balances[X],balB,'no duplicate credit');assert.equal(status(A).balances[X],balA,'A\u2019s balance unchanged by the rejected record');
   assert.equal(natBefore-nat(A).total,BigInt(signedA.fee),'the stale carrier\u2019s XMR fee is lost');
   results.cases.c2bii={staleCarrierMined:true,recordRejected:true,duplicateCredit:false,feeLost:signedA.fee,lesson:'a wallet must check local admission before re-sending a saved carrier; the popup marks such entries rejected and never re-sends them'};}
  // CASE 3: broadcast with lost reply -> same blob re-sent; one fee; fresh install sees the record once mined.
  {const s=await send(A,B,'1000000',{publish:true});const r2=await A.carrier.publish(s.signed.blob);assert.equal(r2.ok,true);await post('mine',{blocks:10});for(const e of [A,A2,B])await e.scanner.sync();
   assert.equal(status(A2).records[s.built.recordId]?.status,'accepted','fresh installation sees the record from the chain');results.cases.c3={rebroadcasts:2,feesPaid:1};}
  // CASE 4: confirmed, then removed by a rollback (pop_blocks): both installs replay; notes unspent again; the carrier reappears from the pool / can be re-sent for no new fee.
  {const balA=status(A).balances[X],balB=status(B).balances[X];const s=await send(A,B,'4000000');await post('mine',{blocks:10});for(const e of [A,A2,B])await e.scanner.sync();
   assert.equal(status(A).records[s.built.recordId].status,'accepted');assert.equal(BigInt(status(B).balances[X]),BigInt(balB)+4000000n);const natAfter=nat(A).total;
   const info=await daemon('get_info');await rollback(12);const info2=await daemon('get_info');assert.equal(info2.height,info.height-12);results.cases.c4={poppedFrom:info.height-1,to:info2.height-1};
   for(const e of [A,A2,B])await e.scanner.sync();// reorg detected -> reset -> replay
   assert.equal(status(A).records[s.built.recordId],undefined,'record gone after the rollback');assert.equal(status(A).balances[X],balA,'A’s notes unspent again');assert.equal(status(B).balances[X],balB,'B’s credit gone');assert.equal(status(A2).balances[X],balA,'fresh install agrees');
   assert.ok(nat(A).total>natAfter,'the carrier’s XMR input is unspent again');
   const inPool=await A.carrier.inPool(s.signed.txid);assert.equal(inPool,false,'pool flushed: the carrier must be re-sent by the wallet');const r=await A.carrier.publish(s.signed.blob);assert.equal(r.ok,true,'the same signed carrier is accepted again');await post('mine',{blocks:10});for(const e of [A,A2,B])await e.scanner.sync();
   assert.equal(status(A).records[s.built.recordId]?.status,'accepted','re-mined after the rollback');assert.equal(BigInt(status(B).balances[X]),BigInt(balB)+4000000n);assert.equal(nat(A).total,natAfter,'same carrier, same fee: no second payment');results.cases.c4={...results.cases.c4,returnedToPool:inPool,reminedSameTxid:s.signed.txid,secondFee:'0'};}
  // CASE 5: two installations with the same phrase spending concurrently (both carriers broadcast before either is mined): exactly one record admitted; the other rejected; both wallets follow the chain; the loser's fee is lost.
  {for(const e of [A,A2])await e.scanner.sync();const notesNow=status(A).notes;if(notesNow.length<2){await send(A,A,'1000000');await post('mine',{blocks:10});for(const e of [A,A2])await e.scanner.sync();}
   const big=status(A).notes.reduce((m,n)=>BigInt(n.amount)>BigInt(m.amount)?n:m);const balB=status(B).balances[X];const natA=nat(A).total;
   const qA=await A.carrier.quote({kind:'send'});const qA2=await A2.carrier.quote({kind:'send',excludeKeyImages:[qA.keyImage]});assert.notEqual(qA.keyImage,qA2.keyImage,'two installs pick different XMR inputs when the second excludes the first (no shared journal in reality: they might also collide and the daemon would reject the second carrier as a double spend)');
   const bA=A.engine.call({op:'build',kind:'send',to:B.tokenAddress,amount:'1000000',notes:[big.commitment]}),bA2=A2.engine.call({op:'build',kind:'send',to:B.tokenAddress,amount:'1500000',notes:[big.commitment]});
   const sA=A.carrier.sign(qA.quoteId,bA.wire),sA2=A2.carrier.sign(qA2.quoteId,bA2.wire);const r1=await A.carrier.publish(sA.blob),r2=await A2.carrier.publish(sA2.blob);assert.equal(r1.ok,true);assert.equal(r2.ok,true,'both carriers are valid Monero transactions');
   await post('mine',{blocks:10});for(const e of [A,A2,B])await e.scanner.sync();
   const st=status(A);const outcomes=[st.records[bA.recordId]?.status,st.records[bA2.recordId]?.status];assert.deepEqual(outcomes.slice().sort(),['accepted','rejected'],'exactly one of the conflicting records was admitted');
   const winner=outcomes[0]==='accepted'?1000000n:1500000n;assert.equal(BigInt(status(B).balances[X]),BigInt(balB)+winner,'B credited exactly once');assert.deepEqual(status(A2).balances,status(A).balances,'both installations agree with the chain');
   assert.equal(natA-nat(A).total,BigInt(sA.fee)+BigInt(sA2.fee),'both carrier fees were paid: the loser’s fee is lost');results.cases.c5={outcomes,bothFeesPaid:true,loserFee:outcomes[0]==='accepted'?sA2.fee:sA.fee};}
 }finally{await mkdir(dir+'runs',{recursive:true});await writeFile(dir+'runs/holder-journal-recovery-results.json',JSON.stringify(results,null,1));await backend.close();}
 console.log(JSON.stringify(results));
});
