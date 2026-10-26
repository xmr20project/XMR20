// Review-only reproductions. Uses the unchanged candidate Operator with a synthetic,
// in-memory custody receipt stub. No daemon, wallets, external network, or real funds.
// Assertions confirm the observed defect, rather than claim the defect is safe.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Operator,bindingFor} from '../../backend/operator.mjs';

const asset='11'.repeat(32),destination='11111111111111111111111111111111';
const txid=n=>n.toString(16).padStart(64,'0');
const makeScan=(tip,burns)=>({public:{tip,state:{credits:[],redemptions:burns,minted:{[asset]:'1000'},burned:{[asset]:String(burns.reduce((n,b)=>n+Number(b.amount),0))}}}});
async function fixture(inject=()=>{}){
 const dir=await mkdtemp(fileURLToPath(new URL('./evidence-operator-',import.meta.url)));
 const receipts=new Map();
 const bridge={receipts:[],redemptionReceipt:id=>receipts.get(id),redeem(dest,amount,id){assert.equal(dest,destination);assert.ok(!receipts.has(id));const receipt={nonce:id,net:String(amount)};receipts.set(id,receipt);return {ok:true,receipt,logs:[]};}};
 const op=await Operator.open({file:dir+'/journal.json',bridge,node:{},registry:{consumedIds:()=>[]},asset,confirmations:10,exposure:{maxSinglePayout:'100',maxPaidPerWindow:'200',windowBlocks:20},inject});
 const burn=(n,height,amount='100')=>{const request=txid(n+1000),binding=bindingFor(destination,request);op.registerRedemption(binding,destination,request);return {asset,amount,binding,txid:txid(n),height};};
 return {op,receipts,burn,dir};
}

test('REPRO: prior burnReorganised incident suppresses later paidWithoutBurn halt',async()=>{
 const {op,receipts,burn,dir}=await fixture();
 const b=burn(1,10);
 await op.reconcile(makeScan(19,[b]));
 await op.reconcile(makeScan(20,[{...b,height:11}]));
 assert.equal(op.state.paused,true);
 await op.resume('synthetic reviewer resume after pending reorg');
 await op.payout(b.txid);
 assert.equal(receipts.size,1);
 await op.reconcile(makeScan(20,[]));
 assert.equal(op.state.payouts[b.txid].confirmations,0);
 assert.equal(op.state.halted,false,'Observed defect: confirmed loss did not halt');
 assert.equal(op.state.incidents.some(i=>i.kind==='paidWithoutBurn'),false);
 console.log(JSON.stringify({case:'suppressed-loss-halt',dir,halted:op.state.halted,incidents:op.state.incidents,actualPayouts:receipts.size}));
});

test('REPRO: post-submit interruption permits 300 payouts under a 200 window cap',async()=>{
 let once=true;
 const {op,receipts,burn,dir}=await fixture(stage=>{if(stage==='afterSubmit'&&once){once=false;throw Error('synthetic interruption after custody paid');}});
 const burns=[burn(1,10),burn(2,10),burn(3,10)];
 await op.reconcile(makeScan(19,burns));
 await assert.rejects(op.payout(burns[0].txid),/synthetic interruption/);
 assert.equal(op.state.payouts[burns[0].txid].status,'submitting');
 assert.equal(receipts.size,1);
 await op.payout(burns[1].txid);
 await op.payout(burns[2].txid);
 assert.equal(receipts.size,3);
 const actualPaid=[...receipts.values()].reduce((n,r)=>n+BigInt(r.net),0n);
 assert.equal(actualPaid,300n);
 assert.equal(op.paidInWindow(19),200n);
 console.log(JSON.stringify({case:'under-counted-paid-exposure',dir,windowCap:op.exposure.maxPaidPerWindow,journalCounted:String(op.paidInWindow(19)),actualPaid:String(actualPaid),statuses:Object.values(op.state.payouts).map(p=>p.status)}));
});
