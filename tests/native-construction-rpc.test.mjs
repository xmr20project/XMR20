import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const source=readFileSync(new URL('../extension/vendor/native.worker.js',import.meta.url),'utf8');
function worker(){
 const messages=[],self={postMessage:value=>messages.push(value),fetch:async()=>({ok:true,json:async()=>({status:'OK',mainnet:true,nettype:'mainnet',height:100})}),XMLHttpRequest:class{},XMR20CarrierGuard:{classifyOwnedOutputs:()=>({protected:[],unknown:[]})}};
 const context=vm.createContext({self,console:{},URL,AbortSignal,Uint8Array,Map,Set,crypto:webcrypto});vm.runInContext(source,context);
 return {context,messages};
}
test('the wallet2 construction reads observed by the real browser engine pass the node filter',()=>{
 const {context}=worker();
 for(const [method,params] of [['hard_fork_info',{version:16}],['get_txpool_backlog',{}],['getblockheadersrange',{start_height:100,end_height:110}]]){
  const body=JSON.stringify({jsonrpc:'2.0',id:'0',method,params});
  assert.equal(vm.runInContext(`readRequest('https://api.xmr20.org/json_rpc',${JSON.stringify(body)})`,context),'/json_rpc');
 }
 assert.equal(vm.runInContext("readRequest('https://api.xmr20.org/get_output_distribution.bin')",context),'/get_output_distribution.bin');
 assert.equal(vm.runInContext("requestTimeout('/get_output_distribution.bin')",context),90000);
 for(const method of ['transfer','start_mining','stop_daemon','flush_txpool','set_log_level','get_wallet_info']){
  const body=JSON.stringify({method,params:{}});
  assert.throws(()=>vm.runInContext(`readRequest('https://api.xmr20.org/json_rpc',${JSON.stringify(body)})`,context),/blocked/);
 }
 assert.throws(()=>vm.runInContext("readRequest('https://api.xmr20.org/send_raw_transaction')",context),/approval/);
 assert.throws(()=>vm.runInContext("readRequest('https://example.com/get_output_distribution.bin')",context),/blocked/);
});
test('failed transaction construction reports no submission, while locked funds get a useful error',async()=>{
 for(const [action,reason,code] of [['prepare','no connection to daemon','xmr-build-failed'],['prepare','not enough unlocked money','xmr-insufficient-unlocked'],['prepareMax','not enough money','xmr-insufficient-unlocked']]){
  const {context,messages}=worker();context.reason=reason;
  vm.runInContext(`wallet={getPrimaryAddress:async()=>'4'+'1'.repeat(94),getHeight:async()=>100,getBalance:async()=>10000000000n,getUnlockedBalance:async()=>0n,getOutputs:async()=>[],createTx:async()=>{throw Error(reason)},sweepUnlocked:async()=>{throw Error(reason)}}`,context);
  await context.self.onmessage({data:{id:'fixture',action,node:'https://api.xmr20.org/monero',to:'4'+'2'.repeat(94),amountRaw:'6000000000'}});
  const result=messages.at(-1);assert.equal(result.code,code);assert.doesNotMatch(result.error,/saved receipt/);assert.match(result.error,code==='xmr-build-failed'?/Nothing was sent/:/unlocked XMR/);
 }
});
