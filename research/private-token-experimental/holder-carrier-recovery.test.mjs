// Focused regression test for the carrier module's lost-reply recovery and pool-aware input selection (no daemon, no
// engine: a scripted fetch and a scripted engine). Behaviour under test (holder-carrier.js):
//   - a TRANSPORT failure on send_raw_transaction is UNCERTAIN: the daemon is asked (get_transactions) before any retry
//   - the daemon knows the txid -> recovered without a re-send; unknown -> the SAME blob is re-sent (bounded)
//   - a daemon REFUSAL is final (no retry); all-uncertain -> status UNCERTAIN, never "accepted"
//   - onAttempt is called before every network call (so a journal can record 'broadcasting' first)
//   - quote() excludes key images the pool reports as spent, in addition to the caller's exclusions
import test from 'node:test';
import assert from 'node:assert/strict';
import {createCarrierBuilder} from './wallet-extension/src/holder-carrier.js';
const TXID='ab'.repeat(32);const BLOB='deadbeef';
function scripted(script){const calls=[];const f=async(url,o)=>{const path=new URL(url).pathname;const body=o?.body?JSON.parse(o.body):{};calls.push({path,method:body.method||null,body});
  const step=script.shift();if(!step)throw Error('unexpected call '+path);assert.equal(path,step.path,'call order');if(step.throw){const e=new TypeError('fetch failed');e.cause={code:step.throw};throw e;}
  return {ok:true,status:200,json:async()=>step.reply,text:async()=>JSON.stringify(step.reply)};};return {f,calls};}
const known={status:'OK',txs:[{tx_hash:TXID,in_pool:true,block_height:0,confirmations:0}]};const unknown={status:'OK',txs:[],missed_tx:[TXID]};
test('lost reply: daemon knows the txid -> recovered by lookup, nothing re-sent',async()=>{
 const {f,calls}=scripted([{path:'/send_raw_transaction',throw:'UND_ERR_SOCKET'},{path:'/get_transactions',reply:known}]);
 const c=createCarrierBuilder({engine:{call(){}},rpc:'http://127.0.0.1:1',fetch:f});const attempts=[];
 const r=await c.publishWithRecovery(BLOB,TXID,{onAttempt:async a=>{attempts.push(a.action);}});
 assert.equal(r.ok,true);assert.equal(r.recovered,true);assert.equal(r.resends,0);assert.equal(r.status,'KNOWN_IN_POOL');
 assert.deepEqual(calls.map(x=>x.path),['/send_raw_transaction','/get_transactions']);assert.deepEqual(attempts,['send','lookup']);
 assert.equal(r.trail[0].outcome,'uncertain');assert.equal(r.trail[1].known,true);});
test('lost request: daemon does not know the txid -> the SAME blob is re-sent once and accepted',async()=>{
 const {f,calls}=scripted([{path:'/send_raw_transaction',throw:'ECONNRESET'},{path:'/get_transactions',reply:unknown},{path:'/send_raw_transaction',reply:{status:'OK'}}]);
 const c=createCarrierBuilder({engine:{call(){}},rpc:'http://127.0.0.1:1',fetch:f});
 const r=await c.publishWithRecovery(BLOB,TXID,{delayMs:1});assert.equal(r.ok,true);assert.equal(r.resends,1);assert.equal(r.recovered,false);
 assert.equal(calls[2].body.tx_as_hex,BLOB,'identical blob re-sent');assert.equal(calls[0].body.tx_as_hex,BLOB);});
test('daemon refusal is final: no lookup, no retry, no "accepted"',async()=>{
 const {f,calls}=scripted([{path:'/send_raw_transaction',reply:{status:'Failed',reason:'double spend',double_spend:true}}]);
 const c=createCarrierBuilder({engine:{call(){}},rpc:'http://127.0.0.1:1',fetch:f});const r=await c.publishWithRecovery(BLOB,TXID);
 assert.equal(r.ok,false);assert.equal(r.doubleSpend,true);assert.equal(calls.length,1);});
test('everything uncertain -> UNCERTAIN, bounded attempts, never ok',async()=>{
 const script=[];for(let i=0;i<2;i++){script.push({path:'/send_raw_transaction',throw:'ETIMEDOUT'});for(let j=0;j<2;j++)script.push({path:'/get_transactions',throw:'ETIMEDOUT'});}
 const {f,calls}=scripted(script);const c=createCarrierBuilder({engine:{call(){}},rpc:'http://127.0.0.1:1',fetch:f});
 const r=await c.publishWithRecovery(BLOB,TXID,{attempts:2,lookupRetries:2,delayMs:1});assert.equal(r.ok,false);assert.equal(r.uncertain,true);assert.equal(r.status,'UNCERTAIN');assert.equal(calls.length,6);});
test('lookup distinguishes pool, chain and unknown',async()=>{
 const {f}=scripted([{path:'/get_transactions',reply:known},{path:'/get_transactions',reply:{status:'OK',txs:[{tx_hash:TXID,in_pool:false,block_height:120,confirmations:7}]}},{path:'/get_transactions',reply:unknown}]);
 const c=createCarrierBuilder({engine:{call(){}},rpc:'http://127.0.0.1:1',fetch:f});
 assert.deepEqual(await c.lookup(TXID),{known:true,inPool:true,blockHeight:null,confirmations:0,status:'OK'});
 assert.deepEqual(await c.lookup(TXID),{known:true,inPool:false,blockHeight:120,confirmations:7,status:'OK'});
 assert.equal((await c.lookup(TXID)).known,false);});
test('quote excludes key images spent in the daemon pool (pool-aware input selection)',async()=>{
 const spent='11'.repeat(32),mine='22'.repeat(32);let seen=null;
 const engine={call(req){if(req.op==='carrierQuote'){seen=req.exclude;return {ready:true,quoteId:'q',fee:'1'};}throw Error('unexpected '+req.op);}};
 const {f}=scripted([{path:'/json_rpc',reply:{result:{height:101}}},{path:'/json_rpc',reply:{result:{fee:20000,quantization_mask:10000}}},{path:'/json_rpc',reply:{result:{distributions:[{start_height:0,distribution:new Array(101).fill(5)}]}}},{path:'/get_transaction_pool',reply:{spent_key_images:[{id_hash:spent.toUpperCase(),txs_hashes:['x']}]}}]);
 const c=createCarrierBuilder({engine,rpc:'http://127.0.0.1:1',fetch:f});const q=await c.quote({kind:'send',excludeKeyImages:[mine]});
 assert.deepEqual([...seen].sort(),[spent,mine].sort(),'caller exclusions plus pool-spent key images, lowercased');assert.equal(q.poolSpentExcluded,1);});
