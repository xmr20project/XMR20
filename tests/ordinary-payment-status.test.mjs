import test from 'node:test';import assert from 'node:assert/strict';
import {ordinaryPaymentStatus,matchingOrdinaryReceipt} from '../src/ordinary-payment-status.js';
import {nativeFixture} from '../services/native-market/xn1/test-fixtures.mjs';
import {inspectTransactionBytes} from '../services/native-market/xn1/transaction-bytes.mjs';
const transaction=nativeFixture(null,{extra:Buffer.alloc(0)}).toString('hex'),hash=inspectTransactionBytes(transaction).txid;
const row={tx_hash:hash,as_hex:transaction,in_pool:true},response={status:'OK',txs:[row],missed_tx:[]};
test('status authenticates pending and confirmed payment bytes without submitting',()=>{
 assert.deepEqual(ordinaryPaymentStatus({hash,response,target:100,saved:true}),{hash,state:'pending',saved:true,confirmations:0});
 assert.deepEqual(ordinaryPaymentStatus({hash,response:{...response,txs:[{...row,in_pool:false,block_height:96}]},target:100}),{hash,state:'confirmed',saved:false,blockHeight:96,confirmations:4});
});
test('missing is not failed or permission to create a replacement payment',()=>{
 for(const saved of [true,false])assert.deepEqual(ordinaryPaymentStatus({hash,response:{status:'OK',missed_tx:[hash]},target:100,saved}),{hash,state:'not-found',saved});
});
test('incomplete, untrusted, mismatched and forged positive status fail closed',()=>{
 for(const value of [{status:'OK'},{...response,untrusted:true},{...response,missed_tx:[hash]},
  {...response,txs:[{...row,tx_hash:'aa'.repeat(32)}]},
  {...response,txs:[{...row,as_hex:transaction.slice(0,-2)+(transaction.endsWith('00')?'01':'00')}]},
  {...response,txs:[{...row,in_pool:false,block_height:100}]}])assert.throws(()=>ordinaryPaymentStatus({hash,response:value,target:100}));
});
test('pending matching normalizes exact atoms, isolates accounts and never blocks a different payment',()=>{
 const receipt={accountId:'a',chain:'monero',symbol:'XMR',to:'recipient',amount:'0.008',status:'Submission uncertain · check receipt'};
 const args={accountId:'a',to:'recipient',amountRaw:'8000000000'};
 assert.equal(matchingOrdinaryReceipt([receipt],args),receipt);
 assert.equal(matchingOrdinaryReceipt([{...receipt,amount:'0.008000000000'}],args)?.amount,'0.008000000000');
 for(const change of [{accountId:'b'},{chain:'solana'},{symbol:'OTHER'},{to:'other'},{amount:'0.008000000001'},{status:'Not submitted'}])assert.equal(matchingOrdinaryReceipt([{...receipt,...change}],args),undefined);
});
