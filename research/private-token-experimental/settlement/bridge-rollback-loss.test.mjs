// COUNTEREXAMPLE A, REPRODUCED LIVE (controlled offline fakechain, lab roles, compiled Solana custody in LiteSVM):
//   a private-token burn is paid out on Solana after CONFIRMATIONS, a rollback deeper than CONFIRMATIONS removes the burn,
//   a wallet instance without the pending reservation (backup / second installation) re-spends the notes, and the operator's
//   backing is short by exactly the paid amount. The payout cannot be revoked. This test PASSES when the loss is reproduced:
//   it is a preserved counterexample, not a regression test of a fix. See SETTLEMENT-DESIGN.txt for which assumption fails.
// Nothing here changes validation; the burn record is valid when mined; the Solana payout is a real program execution in
// the simulator. Controlled rollback via monerod /pop_blocks, not a mined heavier fork; no mainnet probability is claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Keypair,Transaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {startBackend} from '../backend/service.mjs';
import {createHolderEngine,createChainScanner} from '../wallet-extension/src/holder-engine.js';
import {createParameterLoader} from '../wallet-extension/src/holder-params.js';
import {createCarrierBuilder} from '../wallet-extension/src/holder-carrier.js';
const dir=fileURLToPath(new URL('../',import.meta.url));
const PORTS={rpcPort:30075,p2pPort:30074,httpPort:8949};const BASE=`http://127.0.0.1:${PORTS.httpPort}`;
const hex=b=>Buffer.from(b).toString('hex');
const closeFetch=(u,o={})=>fetch(u,{...o,headers:{...(o.headers||{}),connection:'close'}});
const post=async(action,body)=>{const r=await closeFetch(`${BASE}/action/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
const MANIFEST=JSON.parse(await readFile(dir+'params/test-v1/manifest.json','utf8'));
const cache=(()=>{const m=new Map();return {get:async k=>m.get(k)||null,put:async(k,v)=>{m.set(k,v);},delete:async k=>{m.delete(k);}};})();
test('COUNTEREXAMPLE A (preserved): payout on a burn that a later rollback removes -> backing short by the paid amount',{timeout:1800000},async()=>{
 const wasm=await WebAssembly.compile(await readFile(dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm'));
 const backend=await startBackend({...PORTS,log:m=>console.error('backend:',m),origins:[]});const rpc=backend.rpcUrl;const CONF=backend.state&&10;
 const daemon=async(method,params={})=>{const r=await closeFetch(rpc+'/json_rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'t',method,params})});const v=await r.json();if(v.error)throw Error(JSON.stringify(v.error));return v.result;};
 const rollback=async(n)=>{const r=await closeFetch(rpc+'/pop_blocks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nblocks:n})});const v=await r.json();if(v.status!=='OK')throw Error('pop_blocks: '+JSON.stringify(v));await daemon('flush_txpool',{txids:[]});return v;};
 async function open(root,label){const engine=await createHolderEngine({wasm});const d=engine.call({op:'derive',root:hex(root),account:0});const loader=createParameterLoader({fetch:closeFetch,manifest:MANIFEST,engine,baseUrl:BASE,cache});const served=await loader.loadServedConfig();engine.call({op:'params',manifest:MANIFEST,served});
  const scanner=createChainScanner(engine,{rpc,fetch:closeFetch,genesis:MANIFEST.network.genesis});const carrier=createCarrierBuilder({engine,rpc,fetch:closeFetch});return {label,engine,loader,scanner,carrier,tokenAddress:d.tokenAddress,nativeAddress:d.nativeAddress};}
 const pub=()=>{const a=ed25519.utils.randomPrivateKey(),b=ed25519.utils.randomPrivateKey();return {A:hex(ed25519.getPublicKey(a)),B:hex(ed25519.getPublicKey(b))};};
 const status=e=>e.engine.call({op:'status'});
 const evidence={execution:'SIMULATED (offline zero-peer fakechain; controlled /pop_blocks rollback; LiteSVM Solana custody)',confirmations:10,steps:[]};const step=(name,x={})=>{evidence.steps.push({at:new Date().toISOString(),name,...x});console.error(JSON.stringify({step:name,...x}).slice(0,400));};
 try{
  const root=randomBytes(32),rootB=randomBytes(32);
  const A=await open(root,'A (installation that burns)');const A2=await open(root,'A2 (backup / second installation of the same phrase, no journal)');const B=await open(rootB,'B (recipient of the re-spend)');
  const solA=Keypair.generate(),solB=Keypair.generate();
  await post('register',{id:'A',sol:solA.publicKey.toBase58(),xmr:A.nativeAddress,...pub(),tokenAddress:A.tokenAddress});await post('register',{id:'B',sol:solB.publicKey.toBase58(),xmr:B.nativeAddress,...pub(),tokenAddress:B.tokenAddress});
  // Deposit 100 X on Solana (signed by A) -> private credit; fund A's XMR for carriers; mature.
  const prep=await post('depositPrepare',{id:'A',symbol:'X',amount:'100000000'});const tx=Transaction.from(Buffer.from(prep.transaction,'base64'));tx.sign(solA);const dep=await post('depositSubmit',{id:'A',nonce:prep.nonce,transaction:tx.serialize().toString('base64')});
  await post('fund',{id:'A',blocks:2});await post('mine',{blocks:50});await post('mine',{blocks:20});// coinbase matures after 60 blocks; the test service mines at most 50 per call
  const X=backend.assets.X.asset;for(const e of [A,A2,B])await e.scanner.sync();await A.loader.loadProvingKey(1);await A2.loader.loadProvingKey(0);
  assert.equal(status(A).balances[X],'98500000','100 X deposited, one 1.5% fee');step('deposited and credited',{credit:dep.credit.txid,balanceA:status(A).balances[X]});
  // Fragment so the burn spends exactly one note of 40 X: A sends itself 40 X.
  const sendSelf=async()=>{const q=await A.carrier.quote({kind:'send'});const sel=A.engine.call({op:'select',asset:X,amount:'40000000',exclude:[]});await A.loader.loadProvingKey(0);const built=A.engine.call({op:'build',kind:'send',to:A.tokenAddress,amount:'40000000',notes:sel.notes});const s=A.carrier.sign(q.quoteId,built.wire);const r=await A.carrier.publish(s.blob);assert.equal(r.ok,true);return s;};
  await sendSelf();await post('mine',{blocks:11});for(const e of [A,A2,B])await e.scanner.sync();
  const note40=status(A).notes.find(n=>n.amount==='40000000');assert.ok(note40,'A holds a 40 X note');
  const before=(await post('state',{id:'A'})).assets.find(a=>a.symbol==='X').liabilities;assert.equal(before.ok,true,'backing invariant holds before');step('backing before the burn',before);
  // Redemption (burn) of the 40 X note, proved by A, carried by A's own XMR, mined, CONFIRMATIONS blocks, paid out on Solana.
  const rp=await post('redeemPrepare',{id:'A',symbol:'X'});const q=await A.carrier.quote({kind:'redeem'});const built=A.engine.call({op:'build',kind:'redeem',amount:'40000000',binding:rp.binding,notes:[note40.commitment]});const burn=A.carrier.sign(q.quoteId,built.wire);const pr=await A.carrier.publish(burn.blob);assert.equal(pr.ok,true);
  await post('mine',{blocks:10});for(const e of [A,A2,B])await e.scanner.sync();
  const st1=await post('state',{id:'A'});const row1=st1.assets.find(a=>a.symbol==='X');const pay=row1.payouts.find(p=>p.txid===burn.txid);assert.ok(pay&&pay.confirmations>=10,'burn has CONFIRMATIONS: '+JSON.stringify(pay));
  const paid=await post('payout',{symbol:'X',txid:burn.txid});assert.equal(paid.status,'paid');const burnHeight=(await daemon('get_info')).height-1-9;
  const afterPay=(await post('state',{id:'A'})).assets.find(a=>a.symbol==='X').liabilities;assert.equal(afterPay.ok,true,'backing holds after the payout (burn is canonical)');
  step('burn paid out on Solana (irreversible program execution)',{burnTxid:burn.txid,burnHeight,payoutNet:paid.net,liabilities:afterPay});
  // ROLLBACK deeper than CONFIRMATIONS: the burn leaves canonical history. Both installations replay; the 40 X note is unspent again.
  const tipBefore=(await daemon('get_info')).height-1;await rollback(11);const tipAfter=(await daemon('get_info')).height-1;
  for(const e of [A,A2,B])await e.scanner.sync();assert.equal(status(A).records[built.recordId],undefined,'burn record gone');assert.ok(status(A2).notes.some(n=>n.commitment===note40.commitment),'backup installation sees the note unspent');
  step('rollback removed the burn',{popped:11,from:tipBefore,to:tipAfter});
  // The backup installation (no journal, no reservation) spends the same note to B. Honest wallets with the reservation would not; a backup does.
  const q2=await A2.carrier.quote({kind:'send'});const built2=A2.engine.call({op:'build',kind:'send',to:B.tokenAddress,amount:'40000000',notes:[note40.commitment]});const spend=A2.carrier.sign(q2.quoteId,built2.wire);const r2=await A2.carrier.publish(spend.blob);assert.equal(r2.ok,true);
  await post('mine',{blocks:10});for(const e of [A,A2,B])await e.scanner.sync();assert.equal(status(B).balances[X],'40000000','B received the re-spent 40 X');
  // Re-sending the saved burn carrier can no longer settle: the record's note is spent; local admission rejects it (nothing re-sent blindly).
  const v=A.engine.call({op:'verify',wire:built.wire});assert.notEqual(v.record,'accepted','the burn record fails admission after the conflicting spend');
  const after=(await post('state',{id:'A'})).assets.find(a=>a.symbol==='X').liabilities;const op=backend.assets.X.operator;
  assert.equal(after.ok,false,'backing invariant FAILS');assert.equal(after.shortfall,'40000000','shortfall equals the paid amount');assert.ok(op.state.incidents.some(i=>i.kind==='paidWithoutBurn'),'operator latched paidWithoutBurn');assert.equal(op.state.halted,true);
  step('COUNTEREXAMPLE REPRODUCED: payout final, burn gone, note re-spent, backing short',{liabilities:after,incident:op.state.incidents[0],respendTxid:spend.txid,burnVerifyAfter:v.record});
  evidence.reproduced=true;evidence.summary={paidAmount:'40000000',shortfall:after.shortfall,lossBearer:after.lossBearer,burnTxid:burn.txid,respendTxid:spend.txid,incident:op.state.incidents[0]?.kind,failingAssumption:'a burn with CONFIRMATIONS Monero confirmations is treated as final when releasing an IRREVERSIBLE Solana payout; Monero offers no finality and no maximum reorganisation depth, so the burn can leave canonical history after the payout and any instance without the local reservation can re-spend the notes'};
 }finally{await backend.close();await mkdir(dir+'settlement/evidence',{recursive:true});await writeFile(dir+'settlement/evidence/bridge-payout-then-rollback-live-'+new Date().toISOString().slice(0,10)+'.json',JSON.stringify(evidence,null,1));}
});
