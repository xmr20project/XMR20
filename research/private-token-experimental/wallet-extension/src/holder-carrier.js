// Holder-funded carrier path (host side). The holder's engine (wasm) owns the
// Monero keys, the owned outputs, input selection and decoy sampling; this
// module only performs the daemon RPC calls the engine asks for and publishes
// the signed carrier. It talks to the daemon directly: no relay, no backend.
//
// What the daemon learns: exactly what any Monero wallet discloses to its node
// (the output indexes it asks `get_outs` for - the real one among the decoys,
// as monero-oxide does - and the signed transaction). Nothing here is sent to
// the test backend.
export function createCarrierBuilder({engine,rpc,fetch:f=globalThis.fetch,onProgress:initialProgress=()=>{}}){
 let onProgress=initialProgress;
 const json=async(method,params={})=>{const r=await f(rpc+'/json_rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'c',method,params}),signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error('Daemon HTTP '+r.status);const v=await r.json();if(v.error)throw Error('Daemon: '+(v.error.message||JSON.stringify(v.error)));return v.result;};
 const other=async(path,body)=>{const r=await f(rpc+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error('Daemon HTTP '+r.status);return r.json();};
 // Fee rate from the daemon (per byte + quantization mask). On the offline test
 // chain this is far above mainnet rates (tiny block-weight median); the engine
 // also reports an illustrative figure at a mainnet-like rate.
 async function feeRate(){const e=await json('get_fee_estimate',{grace_blocks:10});if(!(e.fee>0))throw Error('Daemon returned no fee estimate');return {perWeight:String(e.fee),mask:String(e.quantization_mask||1)};}
 // Cumulative RingCT output distribution per height 0..=tip (the engine checks
 // the last value against its own local count before trusting it for sampling).
 async function distribution(tip){const d=await json('get_output_distribution',{amounts:[0],from_height:0,to_height:tip,cumulative:true,binary:false});const row=(d.distributions||[])[0];if(!row)throw Error('Daemon returned no output distribution');const start=row.start_height||0;const out=new Array(tip+1).fill(0);for(let h=0;h<=tip;h++){const i=h-start;out[h]=i<0?0:Number(row.distribution[Math.min(i,row.distribution.length-1)]);}return out;}
 // Quote: pick the input in the engine, then satisfy its decoy-sampling needs.
 async function quote({kind,excludeKeyImages=[]}){
  onProgress({phase:'carrier',text:'Reading the fee rate and output distribution from the test daemon…'});
  const info=await json('get_info');const tip=info.height-1;const rate=await feeRate();const dist=await distribution(tip);
  let r=engine.call({op:'carrierQuote',kind,feeRate:rate,distribution:dist,exclude:excludeKeyImages});let rounds=0;
  while(!r.ready){if(++rounds>12)throw Error('Decoy selection did not converge');
   onProgress({phase:'carrier',text:`Sampling ring members for the carrier (round ${rounds}, ${r.need.length} outputs)…`});
   const got=await other('/get_outs',{outputs:r.need.map(index=>({amount:0,index})),get_txid:false});if(got.status!=='OK'||!Array.isArray(got.outs)||got.outs.length!==r.need.length)throw Error('Daemon get_outs failed: '+(got.status||'?'));
   r=engine.call({op:'carrierOuts',quoteId:r.quoteId,outs:got.outs.map((o,i)=>({index:r.need[i],key:o.key,mask:o.mask,unlocked:Boolean(o.unlocked)}))});}
  return {...r,feeRate:rate,tip,rounds};}
 function sign(quoteId,wire){const t0=Date.now();const out=engine.call({op:'carrierSign',quoteId,wire});return {...out,signMs:Date.now()-t0};}
 function cancel(quoteId){return engine.call({op:'carrierCancel',quoteId});}
 // Publish to the daemon. Re-sending the same blob is idempotent on monerod
 // (already-in-pool / already-in-chain are reported as OK), so a lost reply is
 // retried with the SAME transaction: never a second carrier, never a second fee.
 async function publish(blob){const r=await other('/send_raw_transaction',{tx_as_hex:blob,do_not_relay:false,do_sanity_checks:false});
  if(r.status==='OK')return {ok:true,status:'OK'};
  const reason=r.reason||r.status||'rejected';return {ok:false,status:r.status,reason,doubleSpend:Boolean(r.double_spend),invalidInput:Boolean(r.invalid_input),lowMixin:Boolean(r.low_mixin),tooBig:Boolean(r.too_big),feeTooLow:Boolean(r.fee_too_low),notRelayed:Boolean(r.not_relayed)};}
 async function inPool(txid){const p=await other('/get_transaction_pool_hashes',{});return (p.tx_hashes||[]).includes(txid);}
 return {quote,sign,cancel,publish,inPool,feeRate,set onProgress(fn){onProgress=fn;}};
}
export const PICONERO=1_000_000_000_000n;
export function xmr(piconero,digits=6){const n=BigInt(piconero);const whole=n/PICONERO,frac=n%PICONERO;return `${whole}.${frac.toString().padStart(12,'0').slice(0,digits)}`;}
