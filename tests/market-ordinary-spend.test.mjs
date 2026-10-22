import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';import {webcrypto} from 'node:crypto';
import {patchMarketOrdinaryWorker} from '../patch-market-ordinary-worker.mjs';
import {verifyOrdinaryPayment} from '../src/ordinary-spend-guard.js';
import {nativeFixture} from '../services/native-market/xn1/test-fixtures.mjs';
import {inspectCarrier} from '../services/native-market/xn1/carrier.mjs';
const original=readFileSync(new URL('../extension/vendor/native.worker.js',import.meta.url),'utf8');
const worker=patchMarketOrdinaryWorker(original),carrier=readFileSync(new URL('../extension/vendor/native-carrier-guard.js',import.meta.url),'utf8');
const owner='4'+'1'.repeat(94),to='4'+'2'.repeat(94),image='aa'.repeat(32),hash='bb'.repeat(32);
function fixture(){
 const messages=[],frozen=new Set(),calls=[],relayUrls=[];let held=[],failRelay=false;
 const input={getKeyImage:()=>({getHex:()=>image})},tx={getInputs:()=>[input],getHash:()=>hash,getFee:()=>10n,getIsRelayed:()=>false,getOutgoingTransfer:()=>({getDestinations:()=>[{getAddress:()=>to,getAmount:()=>900n}]}),getOutgoingAmount:()=>900n};
 const wallet={getPrimaryAddress:async()=>owner,getHeight:async()=>100,getBalance:async()=>1000n,getUnlockedBalance:async()=>1000n,
  getOutputs:async()=>[{...input,getTx:()=>({getHash:()=>hash,getExtra:()=>Uint8Array.from([1,...Array(32).fill(0)])})}],
  freezeOutput:async k=>frozen.add(k),isOutputFrozen:async k=>frozen.has(k),createTx:async()=>tx,
  relayTx:async()=>{calls.push('relay');if(failRelay)throw Error('lost');return hash;},close:async()=>{}};
 const guard={freeze:async()=>held,relay:async(_tx,review,submit)=>{assert.equal(review.to,to);calls.push('reserve');if(held.includes(image))throw Error('held');return submit('00',hash);},
  reviewRecovery:async txid=>{assert.equal(txid,hash);return {hash,txid,to,amountRaw:'900',feeRaw:'10'};},relayRecovery:async(txid,submit)=>{calls.push('resume');return submit('00',txid);},
  recoveryStatus:async()=>({payments:[{txid:hash,to,amountRaw:'900',feeRaw:'10'}],recoveryOnly:false}),
  exportRecovery:async()=>Uint8Array.from([1,2,3]),importRecovery:async bytes=>{assert.deepEqual([...bytes],[1,2,3]);return {recoveryOnly:true};},close:()=>calls.push('close')};
 const self={postMessage:v=>messages.push(v),fetch:async(url,opts)=>{if(String(url).endsWith('/send_raw_transaction')){calls.push('raw-relay');relayUrls.push(String(url));assert.equal(JSON.parse(opts.body).tx_as_hex,'00');if(failRelay){failRelay=false;throw Error('lost');}return {ok:true,json:async()=>({status:'OK'})};}return {ok:true,json:async()=>({status:'OK',mainnet:true,nettype:'mainnet',height:100})};},XMLHttpRequest:class{},importScripts:file=>{if(file==='./native-carrier-guard.js')vm.runInContext(carrier,context);}};
 const context=vm.createContext({self,console:{},URL,AbortSignal,crypto:webcrypto,TextDecoder,Uint8Array,fakeWallet:wallet,fakeGuard:guard});
 vm.runInContext(worker+'\nwallet=fakeWallet;spendGuard=fakeGuard;self.importScripts("./native-carrier-guard.js");',context);
 return {calls,relayUrls,hold:()=>held=[image],loseReply:()=>failRelay=true,async call(action,data={}){await context.self.onmessage({data:{id:'request',action,node:'https://node.sethforprivacy.com',...data}});return messages.at(-1);}};
}
test('staged worker patch is explicit, idempotent and rejects changed integration seams',()=>{
 assert.equal(patchMarketOrdinaryWorker(worker),worker);assert.match(worker,/market-ordinary-guard/);
 assert.throws(()=>patchMarketOrdinaryWorker(original.replace("}else if(data.action==='relay'){","}else if(data.action==='changed'){")),/worker changed/);
});
test('ordinary relay enters durable protection before any node submission',async()=>{
 const f=fixture(),prepared=await f.call('prepare',{to,amountRaw:'900'});assert.ok(prepared.result);
 const sent=await f.call('relay',{reviewId:prepared.result.id});assert.equal(sent.result.hash,hash);assert.deepEqual(f.calls,['reserve','raw-relay']);
});
test('new reservation after ordinary review prevents broadcast',async()=>{
 const f=fixture(),prepared=await f.call('prepare',{to,amountRaw:'900'});f.hold();
 assert.equal((await f.call('relay',{reviewId:prepared.result.id})).code,'xmr-recovery-required');assert.deepEqual(f.calls,['reserve']);
});
test('uncertain relay requires a new explicit review of the exact saved transaction',async()=>{
 const f=fixture(),prepared=await f.call('prepare',{to,amountRaw:'900'});f.loseReply();
 assert.equal((await f.call('relay',{reviewId:prepared.result.id})).code,'xmr-submission-unknown');
 assert.equal((await f.call('relay',{reviewId:prepared.result.id})).code,'xmr-not-submitted');
 const recovered=await f.call('prepareRecovery',{txid:hash});assert.equal(recovered.result.recovery,true);
 assert.deepEqual(f.calls,['reserve','raw-relay']);
 const sent=await f.call('relay',{reviewId:recovered.result.id});assert.equal(sent.result.hash,hash);assert.deepEqual(f.calls,['reserve','raw-relay','resume','raw-relay']);
});
test('wrong review or changed node cannot submit a saved transaction',async()=>{
 const f=fixture(),r=await f.call('prepareRecovery',{txid:hash});
 assert.ok((await f.call('relay',{reviewId:r.result.id,node:'https://xmr-node.cakewallet.com:18081'})).error);assert.equal(f.calls.length,0);
});
test('saved payment recovery reviewed on the owned read-only node relays exact bytes once through the public node',async()=>{
 const f=fixture(),node='https://api.xmr20.org/monero';
 const review=await f.call('prepareRecovery',{node,txid:hash});assert.equal(review.error,undefined);
 const sent=await f.call('relay',{node,reviewId:review.result.id});assert.equal(sent.error,undefined);assert.equal(sent.result.hash,hash);
 assert.deepEqual(f.calls,['resume','raw-relay']);assert.deepEqual(f.relayUrls,['https://xmr-node.cakewallet.com:18081/send_raw_transaction']);
 assert.ok((await f.call('relay',{node,reviewId:review.result.id})).error);assert.equal(f.relayUrls.length,1);
});
test('recovery status and encrypted backup commands never relay or expose payment bytes',async()=>{
 const f=fixture(),status=await f.call('paymentRecoveryStatus');assert.equal(status.result.payments.length,1);assert.equal(status.result.payments[0].transaction,undefined);
 const exported=await f.call('exportPaymentRecovery');assert.deepEqual([...exported.result.packageBytes],[1,2,3]);
 const prepared=await f.call('prepareRecovery',{txid:hash});
 assert.equal((await f.call('importPaymentRecovery',{packageBytes:exported.result.packageBytes})).result.recoveryOnly,true);
 assert.ok((await f.call('relay',{reviewId:prepared.result.id})).error);assert.deepEqual(f.calls,[]);
});
test('ordinary receipt hash and input identities are derived from canonical bytes',()=>{
 const bytes=nativeFixture(null,{extra:Buffer.alloc(0)}),tx=inspectCarrier(bytes),value={transaction:bytes.toString('hex'),txid:tx.txid,keyImages:tx.inputs.map(i=>i.keyImage)};
 assert.doesNotThrow(()=>verifyOrdinaryPayment(value));
 assert.throws(()=>verifyOrdinaryPayment({...value,txid:hash}),/hash changed/);
 assert.throws(()=>verifyOrdinaryPayment({...value,keyImages:[image]}),/inputs changed/);
});
