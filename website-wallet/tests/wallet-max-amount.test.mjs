import test from 'node:test';
import assert from 'node:assert/strict';
import {maxBridgeAmount,maxSendAmount,bridgeAmountDisplay} from '../src/bridge-amount.js';
import {units} from '../shared/xmr20/protocol.js';

test('send Max preserves all six decimals, including a single atomic token unit',()=>{
 for(const network of ['monero','solana']){
  assert.equal(maxSendAmount('1',network),'0.000001');
  assert.equal(maxSendAmount('9000123456',network),'9000.123456');
  assert.equal(maxSendAmount('9000000000',network),'9000');
  assert.equal(maxSendAmount('0',network),'0');
 }
 assert.equal(bridgeAmountDisplay('9000123456'),'9,000.123456');
 assert.equal(bridgeAmountDisplay('1'),'0.000001');
});

test('Monero Max respects the per-transfer protocol limit without rounding up',()=>{
 for(const raw of ['49999999999999','50000000000000','50000000000001','1000000000000000']){
  const amount=maxSendAmount(raw,'monero');
  assert.equal(units(amount),BigInt(raw)>50000000000000n?'50000000000000':raw);
  assert.equal(amount,maxBridgeAmount(raw));
 }
});

test('Solana Max uses the full token balance rather than the Monero transfer cap',()=>{
 assert.equal(maxSendAmount('50000000123456','solana'),'50000000.123456');
 assert.equal(maxSendAmount('999999999999999','solana'),'999999999.999999');
 assert.equal(maxSendAmount('1000000000000000','solana'),'1000000000');
});

test('Max keeps the gross amount so review deducts the token fee only once',()=>{
 for(const network of ['solana','monero'])assert.equal(maxSendAmount('1000000',network),'1');
 assert.equal(bridgeAmountDisplay('15000'),'0.015');
 assert.equal(bridgeAmountDisplay('985000'),'0.985');
});

test('invalid balances and unknown networks cannot produce a send amount',()=>{
 for(const raw of [undefined,null,NaN,1,'','-1','1.2','1e6','1000000000000001']){
  for(const network of ['monero','solana'])assert.throws(()=>maxSendAmount(raw,network),/Invalid token balance/);
 }
 assert.throws(()=>maxSendAmount('1','other'),/supported token network/);
});
