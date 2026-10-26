// H1 + H2 regressions for the SERVICE operator (bridge/operator.mjs), ported from the fix candidate's tests. Synthetic custody
// stub, durable journal, indexer summaries built by hand. No daemon, no network, no real funds.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Operator,redeemBindingFor} from '../bridge/operator.mjs';
const asset='11'.repeat(32),destination='11111111111111111111111111111111';
const txid=n=>n.toString(16).padStart(64,'0');
const summary=(tip,burns)=>({tip,state:{credits:[],redemptions:burns,minted:{[asset]:'1000'},burned:{[asset]:String(burns.reduce((n,b)=>n+Number(b.amount),0))},publicSupply:{},shieldedSupply:{}}});
async function fixture(inject=()=>{},{dir=null,custody=null}={}){
 dir??=await mkdtemp(fileURLToPath(new URL('../runs/operator-regression-',import.meta.url)));
 const receipts=custody?.receipts??new Map();
 const c=custody?.custody??{async receipts(){return [];},async redemptionReceipt(id){return receipts.get(id)||null;},async redeem(dest,amount,id){assert.equal(dest,destination);assert.ok(!receipts.has(id));const receipt={nonce:id,net:String(amount)};receipts.set(id,receipt);return {ok:true,receipt,logs:[],signature:null};},async reserve(){return '0';}};
 const op=await Operator.open({file:dir+'/operator.json',auditFile:dir+'/audit.log',custody:c,issuer:{},indexer:{},registry:null,asset,confirmations:10,exposure:{maxSinglePayout:'100',maxPaidPerWindow:'200',windowBlocks:20},inject});
 const burn=async(n,height,amount='100')=>{const request=txid(n+1000),binding=redeemBindingFor(destination,request);await op.registerRedemption(binding,destination,request);return {asset,amount,binding,txid:txid(n),height,owner:'00'.repeat(32)};};
 return {op,receipts,custody:c,burn,dir};
}
test('H1: paid burn leaving canonical history halts despite an earlier reorganisation incident; halt survives reload',async()=>{
 const {op,receipts,burn,dir,custody}=await fixture();
 try{const b=await burn(1,10);await op.reconcile(summary(19,[b]));await op.reconcile(summary(20,[{...b,height:11}]));assert.equal(op.state.paused,true);
  await op.resume('test');await op.payout(b.txid);assert.equal(receipts.size,1);
  await op.reconcile(summary(20,[]));assert.equal(op.state.halted,true);assert.equal(op.state.incidents.filter(i=>i.kind==='paidWithoutBurn').length,1);
  await op.reconcile(summary(21,[]));assert.equal(op.state.incidents.filter(i=>i.kind==='paidWithoutBurn').length,1);
  const again=await Operator.open({file:dir+'/operator.json',custody,issuer:{},indexer:{},asset,confirmations:10,exposure:op.exposure});assert.equal(again.state.halted,true);await assert.rejects(again.resume(),/halted/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('H2: interrupted submission keeps its reservation; cap holds; receipt recovery; concurrent requests serialized',async()=>{
 let once=true;const {op,receipts,burn,dir}=await fixture(stage=>{if(stage==='afterSubmit'&&once){once=false;throw Error('synthetic interruption after custody paid');}});
 try{const burns=[await burn(1,10),await burn(2,10),await burn(3,10),await burn(4,10)];await op.reconcile(summary(19,burns));
  await assert.rejects(op.payout(burns[0].txid),/synthetic interruption/);assert.equal(op.state.payouts[burns[0].txid].status,'submitting');assert.equal(op.exposureInWindow(19),100n);
  const results=await Promise.allSettled([op.payout(burns[1].txid),op.payout(burns[2].txid),op.payout(burns[3].txid)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&/window payout limit/.test(r.reason.message)).length,2);
  assert.equal(receipts.size,2);
  await op.recoverSubmissions();assert.equal(op.state.payouts[burns[0].txid].status,'paid');assert.equal(op.state.payouts[burns[0].txid].recovered,true);assert.equal(op.exposureInWindow(19),200n);
  await op.reconcile(summary(39,burns));await op.payout(burns[2].txid);await op.payout(burns[3].txid);assert.equal(receipts.size,4);
  assert.equal(Object.values(op.state.payouts).filter(p=>p.status==='paid').length,4);
  // definite refusal releases; uncertain exception keeps; abandonment after custody confirms no receipt
  const b5=await burn(5,10);await op.reconcile(summary(59,[...burns,b5]));const c=op.custody;c.redeem=async()=>({ok:false,logs:['program: insufficient reserve']});
  await assert.rejects(op.payout(b5.txid),/Custody refused/);assert.equal(op.state.payouts[b5.txid].status,'pending');
  c.redeem=async()=>{throw Error('timeout');};await assert.rejects(op.payout(b5.txid),/uncertain/);assert.equal(op.state.payouts[b5.txid].status,'submitting');assert.equal(op.exposureInWindow(59),100n);
  await op.abandonSubmission(b5.txid,'test');assert.equal(op.state.payouts[b5.txid].status,'pending');assert.equal(op.exposureInWindow(59),0n);
 }finally{await rm(dir,{recursive:true,force:true});}
});
