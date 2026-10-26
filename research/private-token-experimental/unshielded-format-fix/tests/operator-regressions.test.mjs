// H1 + H2 REGRESSIONS against the FIXED operator (backend/operator.mjs of this candidate). Same synthetic custody stub and
// durable journal as the review's reproduction (review-original/bridge-params/operator-security-repro.test.mjs), but the
// assertions now state the corrected behaviour. No daemon, no network, no real funds.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Operator,bindingFor} from '../backend/operator.mjs';
const asset='11'.repeat(32),destination='11111111111111111111111111111111';
const txid=n=>n.toString(16).padStart(64,'0');
const makeScan=(tip,burns)=>({public:{tip,state:{credits:[],redemptions:burns,minted:{[asset]:'1000'},burned:{[asset]:String(burns.reduce((n,b)=>n+Number(b.amount),0))}}}});
async function fixture(inject=()=>{},{dir=null,custody=null}={}){
 dir??=await mkdtemp(fileURLToPath(new URL('../runs/operator-regression-',import.meta.url)));
 const receipts=custody?.receipts??new Map();
 const bridge=custody?.bridge??{receipts:[],redemptionReceipt:id=>receipts.get(id),redeem(dest,amount,id){assert.equal(dest,destination);assert.ok(!receipts.has(id));const receipt={nonce:id,net:String(amount)};receipts.set(id,receipt);return {ok:true,receipt,logs:[]};}};
 const op=await Operator.open({file:dir+'/journal.json',bridge,node:{},registry:{consumedIds:()=>[]},asset,confirmations:10,exposure:{maxSinglePayout:'100',maxPaidPerWindow:'200',windowBlocks:20},inject});
 const burn=(n,height,amount='100')=>{const request=txid(n+1000),binding=bindingFor(destination,request);op.registerRedemption(binding,destination,request);return {asset,amount,binding,txid:txid(n),height};};
 return {op,receipts,bridge,burn,dir};
}

test('H1: a paid burn that leaves canonical history halts even after an earlier reorganisation incident, and the halt survives a journal reload',async()=>{
 const {op,receipts,burn,dir}=await fixture();
 try{
  const b=burn(1,10);
  await op.reconcile(makeScan(19,[b]));
  await op.reconcile(makeScan(20,[{...b,height:11}]));
  assert.equal(op.state.paused,true);assert.ok(op.state.incidents.some(i=>i.kind==='burnReorganised'&&i.txid===b.txid));
  await op.resume('reviewer resume after pending reorg');
  await op.payout(b.txid);assert.equal(receipts.size,1);
  await op.reconcile(makeScan(20,[]));
  assert.equal(op.state.payouts[b.txid].confirmations,0);
  assert.equal(op.state.halted,true,'loss latched despite the earlier incident');
  assert.equal(op.state.incidents.filter(i=>i.kind==='paidWithoutBurn'&&i.txid===b.txid).length,1);
  // repeated reconciliation does not duplicate the incident; the halt stays
  await op.reconcile(makeScan(21,[]));assert.equal(op.state.incidents.filter(i=>i.kind==='paidWithoutBurn').length,1);assert.equal(op.state.halted,true);
  await assert.rejects(op.payout(b.txid).then(()=>op.resume()),/halted/);
  // reload the journal from disk: still halted, still one incident
  const again=await Operator.open({file:dir+'/journal.json',bridge:op.bridge,node:{},registry:{consumedIds:()=>[]},asset,confirmations:10,exposure:op.exposure});
  assert.equal(again.state.halted,true);assert.equal(again.state.incidents.filter(i=>i.kind==='paidWithoutBurn').length,1);
  await assert.rejects(again.reconcile(makeScan(22,[])).then(()=>again.resume()),/halted/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('H2: an interrupted submission keeps its exposure reservation; the window cap holds; receipt recovery resolves it',async()=>{
 let once=true;
 const {op,receipts,burn,dir}=await fixture(stage=>{if(stage==='afterSubmit'&&once){once=false;throw Error('synthetic interruption after custody paid');}});
 try{
  const burns=[burn(1,10),burn(2,10),burn(3,10)];
  await op.reconcile(makeScan(19,burns));
  await assert.rejects(op.payout(burns[0].txid),/synthetic interruption/);
  assert.equal(op.state.payouts[burns[0].txid].status,'submitting');assert.equal(receipts.size,1);
  assert.equal(op.exposureInWindow(19),100n,'the unresolved submission counts');
  // second payout fits (100 + 100 = 200); the third must be refused: 300 would exceed the 200 window cap
  await op.payout(burns[1].txid);
  await assert.rejects(op.payout(burns[2].txid),/window payout limit/);
  assert.equal(receipts.size,2,'custody paid exactly what the cap allows');
  // but wait: recovery of the first submission makes it PAID (it was paid in custody); exposure unchanged (still 200)
  await op.recoverSubmissions();assert.equal(op.state.payouts[burns[0].txid].status,'paid');assert.equal(op.state.payouts[burns[0].txid].recovered,true);
  assert.equal(op.exposureInWindow(19),200n);
  await assert.rejects(op.payout(burns[2].txid),/window payout limit/);
  // after the window passes, the third is admitted
  await op.reconcile(makeScan(19+20,burns));await op.payout(burns[2].txid);assert.equal(receipts.size,3);
  const actualPaid=[...receipts.values()].reduce((n,r)=>n+BigInt(r.net),0n);assert.equal(actualPaid,300n);
  assert.deepEqual(Object.values(op.state.payouts).map(p=>p.status),['paid','paid','paid']);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('H2: a reservation persists across a journal reload and blocks new admissions until resolved; definite custody refusal releases it',async()=>{
 let once=true;
 const {op,receipts,burn,dir,bridge}=await fixture(stage=>{if(stage==='afterSubmit'&&once){once=false;throw Error('crash after submit');}});
 try{
  const burns=[burn(1,10),burn(2,10),burn(3,10)];await op.reconcile(makeScan(19,burns));
  await assert.rejects(op.payout(burns[0].txid),/crash after submit/);
  // "process restart": reopen the journal with a custody whose receipt for burn 1 is NOT visible yet (lost reply model)
  const hidden=new Map();const custody2={receipts:[],redemptionReceipt:id=>hidden.get(id),redeem(dest,amount,id){const receipt={nonce:id,net:String(amount)};hidden.set(id,receipt);return {ok:true,receipt,logs:[]};}};
  const op2=await Operator.open({file:dir+'/journal.json',bridge:custody2,node:{},registry:{consumedIds:()=>[]},asset,confirmations:10,exposure:op.exposure});
  for(const b of burns){const request=txid(parseInt(b.txid,16)+1000);op2.registerRedemption(b.binding,destination,request);}
  assert.equal(op2.state.payouts[burns[0].txid].status,'submitting');assert.equal(op2.exposureInWindow(19),100n,'reservation reloaded from disk');
  await op2.reconcile(makeScan(19,burns));
  await op2.payout(burns[1].txid);await assert.rejects(op2.payout(burns[2].txid),/window payout limit/);
  await assert.rejects(op2.payout(burns[0].txid),/Unresolved submission/,'an unresolved submission is never re-submitted blindly');
  // the receipt becomes visible: recovery marks it paid without a second payment
  hidden.set(burns[0].txid,receipts.get(burns[0].txid));await op2.recoverSubmissions();assert.equal(op2.state.payouts[burns[0].txid].status,'paid');assert.equal(hidden.size,2);
  // definite refusal by custody releases the reservation immediately
  const b4=burn(4,10);op2.registerRedemption(b4.binding,destination,txid(4+1000));await op2.reconcile(makeScan(19+20,[...burns,b4]));custody2.redeem=()=>({ok:false,receipt:null,logs:['program: insufficient reserve']});
  await assert.rejects(op2.payout(b4.txid),/Custody refused/);assert.equal(op2.state.payouts[b4.txid].status,'pending');assert.equal(op2.exposureInWindow(39),0n);
  // an uncertain custody exception keeps the reservation; abandonSubmission is refused while a receipt exists and allowed when none
  custody2.redeem=()=>{throw Error('timeout');};await assert.rejects(op2.payout(b4.txid),/uncertain/);assert.equal(op2.state.payouts[b4.txid].status,'submitting');assert.equal(op2.exposureInWindow(39),100n);
  await op2.abandonSubmission(b4.txid,'custody confirmed no receipt');assert.equal(op2.state.payouts[b4.txid].status,'pending');assert.ok(op2.state.incidents.some(i=>i.kind==='submissionAbandoned'&&i.txid===b4.txid));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('H2: concurrent payout requests are serialized; together they never exceed the window cap',async()=>{
 const {op,receipts,burn,dir}=await fixture();
 try{
  const burns=[burn(1,10),burn(2,10),burn(3,10),burn(4,10)];await op.reconcile(makeScan(19,burns));
  const results=await Promise.allSettled(burns.map(b=>op.payout(b.txid)));
  const paid=results.filter(r=>r.status==='fulfilled').length,refused=results.filter(r=>r.status==='rejected'&&/window payout limit/.test(r.reason.message)).length;
  assert.equal(paid,2);assert.equal(refused,2);assert.equal(receipts.size,2);assert.equal(op.exposureInWindow(19),200n);
 }finally{await rm(dir,{recursive:true,force:true});}
});
