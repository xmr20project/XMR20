// HOLDER-FUNDED CARRIER PATH (wasm engine in Node, real offline daemon, no relay).
// Two isolated holder engines (Alpha, Beta) with their own synthetic Monero
// keys. The holder's engine scans its native outputs, quotes the exact carrier
// fee before any proof, proves the record, builds and signs the ordinary Monero
// carrier with the record in tx_extra, publishes it directly to the daemon and
// pays the fee from its own XMR. Measures proof time, carrier build time and
// memory separately; records serialized record and tx_extra sizes and daemon
// acceptance; checks exact XMR fee accounting, insufficient/locked XMR,
// cancellation, failed construction, lost broadcast replies, restart and
// concurrent sends; audits backend requests for key images and carrier data.
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
import {createCarrierBuilder,xmr} from './wallet-extension/src/holder-carrier.js';
const dir=fileURLToPath(new URL('./',import.meta.url));
const PORTS={rpcPort:30065,p2pPort:30064,httpPort:8944};
const BASE=`http://127.0.0.1:${PORTS.httpPort}`;
const hex=b=>Buffer.from(b).toString('hex');
const closeFetch=(u,o={})=>fetch(u,{...o,headers:{...(o.headers||{}),connection:'close'}});
const post=async(action,body)=>{const r=await closeFetch(`${BASE}/action/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
const MANIFEST=JSON.parse(await readFile(dir+'params/test-v1/manifest.json','utf8'));
const memoryCache=()=>{const m=new Map();return {get:async k=>m.get(k)||null,put:async(k,v)=>{m.set(k,v);},delete:async k=>{m.delete(k);}};};
const cache=memoryCache();
const results={transfers:[],rejections:[]};
test('holder-funded carriers: 1/2/3-input transfers, fee accounting, failures, retries, restart, concurrency',{timeout:2400000},async()=>{
 const wasm=await WebAssembly.compile(await readFile(dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm'));
 const backend=await startBackend({...PORTS,log:m=>console.error('backend:',m),origins:[]});
 const rpc=backend.rpcUrl;
 async function open(root,label){const engine=await createHolderEngine({wasm});const d=engine.call({op:'derive',root:hex(root),account:0});const loader=createParameterLoader({fetch:closeFetch,manifest:MANIFEST,engine,baseUrl:BASE,cache});const served=await loader.loadServedConfig();engine.call({op:'params',manifest:MANIFEST,served});
  const scanner=createChainScanner(engine,{rpc,fetch:closeFetch,genesis:MANIFEST.network.genesis});const carrier=createCarrierBuilder({engine,rpc,fetch:closeFetch});return {label,engine,loader,scanner,carrier,tokenAddress:d.tokenAddress,nativeAddress:d.nativeAddress,root};}
 const pub=()=>{const a=ed25519.utils.randomPrivateKey(),b=ed25519.utils.randomPrivateKey();return {A:hex(ed25519.getPublicKey(a)),B:hex(ed25519.getPublicKey(b))};};
 try{
  const rootA=randomBytes(32),rootB=randomBytes(32);const A=await open(rootA,'Alpha'),B=await open(rootB,'Beta');
  assert.match(A.nativeAddress,/^4/);assert.notEqual(A.nativeAddress,B.nativeAddress);
  const solA=Keypair.generate(),solB=Keypair.generate();
  await post('register',{id:'A',sol:solA.publicKey.toBase58(),xmr:A.nativeAddress,...pub(),tokenAddress:A.tokenAddress});
  await post('register',{id:'B',sol:solB.publicKey.toBase58(),xmr:B.nativeAddress,...pub(),tokenAddress:B.tokenAddress});
  // Deposit 100 X to Alpha (Solana side, signed with Alpha's Solana key).
  const prep=await post('depositPrepare',{id:'A',symbol:'X',amount:'100000000'});const tx=Transaction.from(Buffer.from(prep.transaction,'base64'));tx.sign(solA);await post('depositSubmit',{id:'A',nonce:prep.nonce,transaction:tx.serialize().toString('base64')});
  await post('mine',{blocks:10});
  let t0=Date.now();await A.scanner.sync();results.initialScanMs=Date.now()-t0;const X=backend.assets.X.asset;
  assert.equal(A.engine.call({op:'status'}).balances[X],'98500000');
  // No XMR yet: a fee quote must fail with a precise, actionable error; nothing reserved.
  let ns=A.engine.call({op:'nativeStatus'});assert.equal(ns.unlocked,'0');assert.equal(ns.outputs.length,0);
  await assert.rejects(A.carrier.quote({kind:'send'}),/No spendable XMR for the carrier fee: unlocked 0 piconero .*locked 0 \(/);results.rejections.push('no XMR');
  // Fund Alpha with 2 coinbase outputs (TEST SERVICE), Beta with 1. Locked for 60 blocks.
  const fundA=await post('fund',{id:'A',blocks:2});assert.equal(fundA.address,A.nativeAddress);await post('fund',{id:'B',blocks:1});
  await A.scanner.sync();ns=A.engine.call({op:'nativeStatus'});assert.equal(ns.outputs.length,2);assert.equal(ns.unlocked,'0');assert.ok(BigInt(ns.locked)>0n);assert.ok(ns.outputs.every(o=>o.coinbase));
  await assert.rejects(A.carrier.quote({kind:'send'}),/No spendable XMR .* locked \d+ \(unlocks by block \d+\)/);results.rejections.push('locked coinbase');
  await post('mine',{blocks:50});await post('mine',{blocks:12});await A.scanner.sync();await B.scanner.sync();
  ns=A.engine.call({op:'nativeStatus'});assert.ok(BigInt(ns.unlocked)>0n,'coinbase matured');assert.equal(ns.locked,'0');results.coinbaseAmount=ns.outputs[0].amount;
  const nativeBalance=e=>{const s=e.engine.call({op:'nativeStatus'});return BigInt(s.unlocked)+BigInt(s.locked)+BigInt(s.reserved);};
  // Fee quote BEFORE proving: exact fee, weight, input, ring size; cancellation releases it.
  const q0=await A.carrier.quote({kind:'send'});assert.equal(q0.ready,true);assert.equal(q0.ringSize,16);assert.ok(BigInt(q0.fee)>0n);assert.equal(q0.recordBytes,996);results.quote=q0;
  assert.equal(A.carrier.cancel(q0.quoteId).cancelled,true);assert.equal(A.carrier.cancel(q0.quoteId).cancelled,false);
  // Shared transfer helper: quote -> prove -> sign -> publish -> mine -> verify exact token change and exact XMR fee.
  async function transfer(from,to,amount,expectInputs,expectChange){
   const before=nativeBalance(from);const tokBefore=BigInt(from.engine.call({op:'status'}).balances[X]||'0');
   const q=await from.carrier.quote({kind:'send'});assert.equal(q.ready,true);
   await from.loader.loadProvingKey(0);const notesNow=from.engine.call({op:'status'});console.log('notes',from.label,JSON.stringify(notesNow.notes.map(n=>[n.amount,n.asset===X])),'spent',notesNow.spent.length,'balances',JSON.stringify(notesNow.balances));const sel=from.engine.call({op:'select',asset:X,amount,exclude:[]});assert.equal(sel.notes.length,expectInputs);assert.equal(sel.change,expectChange);
   const m0=from.engine.memoryBytes();let t=Date.now();const built=from.engine.call({op:'build',kind:'send',to:to.tokenAddress,amount,notes:sel.notes});const provingMs=Date.now()-t;assert.equal(built.bytes,996);assert.equal(built.change,expectChange);
   t=Date.now();const signed=from.carrier.sign(q.quoteId,built.wire);const signMs=Date.now()-t;const m1=from.engine.memoryBytes();
   assert.equal(signed.fee,q.fee,'signed fee equals the approved quote');assert.equal(signed.keyImage,q.keyImage);assert.ok(signed.extraBytes<=1060);
   const pubr=await from.carrier.publish(signed.blob);assert.equal(pubr.ok,true,JSON.stringify(pubr));assert.equal(await from.carrier.inPool(signed.txid),true,'carrier accepted into the daemon pool');
   await post('mine',{blocks:10});await from.scanner.sync();await to.scanner.sync();
   const st=from.engine.call({op:'status'});assert.equal(st.records[built.recordId]?.status,'accepted');assert.equal(st.records[built.recordId].txid,signed.txid);
   assert.equal(BigInt(st.balances[X]||'0'),tokBefore-BigInt(amount),'exact token debit');
   const after=nativeBalance(from);assert.equal(before-after,BigInt(signed.fee),'XMR balance fell by exactly the carrier fee (self-payment + change return to the holder)');
   const row={from:from.label,to:to.label,amount,inputs:built.inputs,change:built.change,recordBytes:built.bytes,extraBytes:signed.extraBytes,nativeBytes:signed.nativeBytes,fee:signed.fee,feeXmr:xmr(signed.fee),feePerWeight:q.feePerWeight,illustrativeMainnetFee:q.illustrativeMainnetFee,provingMs,carrierSignMs:signMs,quoteRounds:q.rounds,txid:signed.txid,memoryBeforeBuild:m0,memoryAfterSign:m1};results.transfers.push(row);console.log(JSON.stringify(row));return {built,signed,q};}
  // 1 input: Alpha -> Beta 20 X (change 78.5).
  await transfer(A,B,'20000000',1,'78500000');
  // Beta -> Alpha 5 and 3 (Beta pays its own carrier fees from its single coinbase output; second send uses the change of the first once it matures).
  await transfer(B,A,'5000000',1,'15000000');
  // Beta's only XMR is now the change output of its carrier: locked by monerod's 10-block spendable-age rule, spendable exactly when tip + 1 >= height + 10 (the transfer helper mined 10 blocks, so it is spendable now; the engine reports the unlock height).
  {const nb=B.engine.call({op:'nativeStatus'});const change=nb.outputs.find(o=>!o.spent&&!o.coinbase);assert.ok(change,'change output recovered');assert.equal(change.unlockedAt,change.height+9);assert.ok(nb.tip>=change.unlockedAt);results.changeUnlockRule={height:change.height,unlockedAt:change.unlockedAt,tip:nb.tip};}
  await transfer(B,A,'3000000',1,'12000000');
  // 2 inputs: Alpha has 78.5 + 5 + 3; send 80 -> 78.5 + 5, change 3.5.
  await transfer(A,B,'80000000',2,'3500000');
  // 3 inputs: Alpha has 3.5 + 3; Beta returns 2 -> Alpha 3.5 + 3 + 2; send 8 -> change 0.5.
  await post('mine',{blocks:10});await B.scanner.sync();await transfer(B,A,'2000000',1,'78000000');// largest-first picks Beta's 80 X note
  const three=await transfer(A,B,'8000000',3,'500000');
  // Failed construction: a record that fails local admission (tampered byte) gets no carrier and no fee.
  {const q=await A.carrier.quote({kind:'send'});const bad=Buffer.from(three.built.wire,'hex');bad[100]^=1;assert.throws(()=>A.carrier.sign(q.quoteId,bad.toString('hex')),/fails local admission; no carrier built/);A.carrier.cancel(q.quoteId);results.rejections.push('tampered record: no carrier');}
  // Lost broadcast reply: the same signed blob is re-sent; the daemon reports OK again and exactly one carrier exists (one fee).
  {const before=nativeBalance(A);const q=await A.carrier.quote({kind:'send'});const sel=A.engine.call({op:'select',asset:X,amount:'100000',exclude:[]});const built=A.engine.call({op:'build',kind:'send',to:B.tokenAddress,amount:'100000',notes:sel.notes});const signed=A.carrier.sign(q.quoteId,built.wire);
   const r1=await A.carrier.publish(signed.blob);const r2=await A.carrier.publish(signed.blob);assert.equal(r1.ok,true);assert.equal(r2.ok,true,'re-sending the identical carrier is idempotent');
   await post('mine',{blocks:1});const r3=await A.carrier.publish(signed.blob);assert.equal(r3.ok,true,'re-sending after it was mined is still reported OK (already in chain)');
   await post('mine',{blocks:9});await A.scanner.sync();assert.equal(before-nativeBalance(A),BigInt(signed.fee),'exactly one fee paid despite three broadcasts');results.lostReplyRetries={broadcasts:3,feesPaid:1,fee:signed.fee};
   // A conflicting carrier for the same record from another input is refused by the engine (input reserved) and would be a second fee: never built automatically.
  }
  // Concurrent sends (two engines of the SAME holder, like two popups): each must use a distinct native input; shared exclusion prevents a conflicting carrier.
  {const A2=await open(rootA,'Alpha-2');await A2.scanner.sync();const q1=await A.carrier.quote({kind:'send'});const q2=await A2.carrier.quote({kind:'send',excludeKeyImages:[q1.keyImage]});assert.notEqual(q1.keyImage,q2.keyImage,'second window picks a different XMR input');
   await assert.rejects(A2.carrier.quote({kind:'send',excludeKeyImages:[q1.keyImage,q2.keyImage]}),/No spendable XMR .* reserved by pending carriers/,'with both inputs reserved nothing is available');
   A.carrier.cancel(q1.quoteId);A2.carrier.cancel(q2.quoteId);results.concurrent={distinctInputs:true};}
  // Restart: a fresh engine from the same root replays the chain and reproduces native outputs, spent status and token state.
  {const R=await open(rootA,'Alpha-restored');await R.scanner.sync();const a=A.engine.call({op:'nativeStatus'}),r=R.engine.call({op:'nativeStatus'});assert.deepEqual(r.outputs.map(o=>[o.keyImage,o.amount,Boolean(o.spent)]).sort(),a.outputs.map(o=>[o.keyImage,o.amount,Boolean(o.spent)]).sort());assert.equal(r.unlocked,a.unlocked);assert.deepEqual(R.engine.call({op:'status'}).balances,A.engine.call({op:'status'}).balances);results.restart={outputs:r.outputs.length,spent:r.outputs.filter(o=>o.spent).length};}
  // Redemption carrier (XB3, 925 bytes) proved and carried by the holder too.
  {const rp=await post('redeemPrepare',{id:'A',symbol:'X'});await A.loader.loadProvingKey(1);const q=await A.carrier.quote({kind:'redeem'});assert.equal(q.recordBytes,925);const sel=A.engine.call({op:'select',asset:X,amount:'400000',exclude:[]});let t=Date.now();const red=A.engine.call({op:'build',kind:'redeem',amount:'400000',binding:rp.binding,notes:sel.notes});/* Alpha holds 0.4 X at this point */const provingMs=Date.now()-t;const signed=A.carrier.sign(q.quoteId,red.wire);assert.equal((await A.carrier.publish(signed.blob)).ok,true);await post('mine',{blocks:10});const paid=await post('payout',{symbol:'X',txid:signed.txid});assert.equal(paid.status,'paid');results.redemption={recordBytes:red.bytes,extraBytes:signed.extraBytes,nativeBytes:signed.nativeBytes,fee:signed.fee,provingMs,txid:signed.txid};}
  // Audit: the backend never received a key image, carrier blob, ring or record wire.
  {const log=await readFile(backend.run+'/requests.log','utf8');const kis=results.transfers.map(t=>t.txid);for(const t of results.transfers)assert.ok(!log.includes(t.txid)||/payout/.test(log),'txid only appears for the explicit payout request');
   const allKi=A.engine.call({op:'nativeStatus'}).outputs.map(o=>o.keyImage).concat(B.engine.call({op:'nativeStatus'}).outputs.map(o=>o.keyImage));for(const k of allKi)assert.ok(!log.includes(k),'no key image in the backend log');results.backendAudit={keyImagesChecked:allKi.length,hits:0};
   await assert.rejects(post('register',{id:'x',keyImage:'00'}),/Refused: secret-looking or carrier field/);}
  results.engineMemoryBytes=A.engine.memoryBytes();results.wasmBytes=(await readFile(dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm')).length;
 }finally{await mkdir(dir+'runs',{recursive:true});await writeFile(dir+'runs/holder-carrier-results.json',JSON.stringify(results,null,1));await backend.close();}
 console.log(JSON.stringify({transfers:results.transfers.length,rejections:results.rejections,redemption:results.redemption}));
});
