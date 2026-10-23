// Holder engine host: loads the wasm module built from holder-wasm/ (no
// wasm-bindgen; JSON over a C ABI) and replays the PUBLIC chain from a Monero
// daemon's JSON-RPC into it. Environment-agnostic (worker or Node tests): the
// caller supplies fetch and the wasm bytes. Nothing here ever sees the recovery
// phrase: the worker derives the 32-byte root and hands it to `derive` once.
const enc=new TextEncoder(),dec=new TextDecoder();
export async function createHolderEngine({wasm,random=b=>crypto.getRandomValues(b)}){
 let memory;
 const imports={env:{xmr20_random(ptr,len){try{random(new Uint8Array(memory.buffer,ptr,len));return 0;}catch{return 1;}}}};
 const {instance}=wasm instanceof WebAssembly.Module?{instance:await WebAssembly.instantiate(wasm,imports)}:await WebAssembly.instantiate(wasm,imports);
 const x=instance.exports;memory=x.memory;x.xmr20_init();
 const read=(ptr,len)=>dec.decode(new Uint8Array(memory.buffer,ptr,len));
 const panicText=()=>{const n=x.xmr20_panic_len();return n?read(x.xmr20_panic_ptr(),n):'';};
 const put=bytes=>{const ptr=x.xmr20_alloc(bytes.length);new Uint8Array(memory.buffer,ptr,bytes.length).set(bytes);return ptr;};
 const finish=len=>{const v=JSON.parse(read(x.xmr20_out_ptr(),len));if(v.error)throw Error(v.error);return v.result;};
 const guard=fn=>{try{return fn();}catch(e){if(e instanceof WebAssembly.RuntimeError)throw Error('Holder engine fault: '+(panicText()||e.message));throw e;}};
 return {
  call(request){return guard(()=>{const bytes=enc.encode(JSON.stringify(request));return finish(x.xmr20_call(put(bytes),bytes.length));});},
  blob(slot,bytes){return guard(()=>finish(x.xmr20_blob(slot,put(bytes),bytes.length)));},
  memoryBytes(){return memory.buffer.byteLength;},
 };
}
// Public-chain replay against monerod JSON-RPC. EVERY block is fetched as a
// blob with its transaction blobs and handed to the engine's `applyBlock`, which
// scans the holder's native outputs (view key, local RingCT index count), tracks
// key images seen in inputs, and applies each transaction's extra to the token
// pool. A hash mismatch at any cached height (reorganization) resets the engine
// and replays from genesis.
// `network`: 'offline-fakechain' (default: the daemon must report nettype fakechain AND offline) or 'stagenet' (nettype stagenet, online allowed). Taken from the manifest.
export function createChainScanner(engine,{rpc,fetch:f=globalThis.fetch,onProgress=()=>{},genesis,network='offline-fakechain'}){
 const json=async(method,params={})=>{const r=await f(rpc+'/json_rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'h',method,params})});if(!r.ok)throw Error('Daemon HTTP '+r.status);const v=await r.json();if(v.error)throw Error('Daemon: '+(v.error.message||JSON.stringify(v.error)));return v.result;};
 const other=async(path,body)=>{const r=await f(rpc+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error('Daemon HTTP '+r.status);return r.json();};
 const known=[];// index = height -> hash (genesis included)
 let applied=0,received=0;
 async function reset(){engine.call({op:'reset'});known.length=0;applied=0;received=0;}
 async function sync(){
  const info=await json('get_info');if(network==='stagenet'){if(info.nettype!=='stagenet')throw Error('Stagenet daemon required by the manifest (daemon reports '+info.nettype+').');}else if(info.nettype!=='fakechain'||info.offline!==true)throw Error('Offline fakechain required for this test build.');
  const tip=info.height-1;
  if(known.length){const h=known.length-1;const hdr=await json('get_block_header_by_height',{height:Math.min(h,tip)});if(h>tip||hdr.block_header.hash!==known[h]){await reset();}}
  for(let height=known.length;height<=tip;height++){
   const b=await json('get_block',{height});if(height===0&&b.block_header.hash!==genesis)throw Error('Daemon genesis does not match the public parameters.');
   if(height>0&&b.block_header.prev_hash!==known[height-1])throw Error('Chain changed during replay; retry');
   const hashes=b.tx_hashes||[];let txs=[];
   if(hashes.length){const t=await other('/get_transactions',{txs_hashes:hashes,decode_as_json:false,prune:false});const byHash=new Map((t.txs||[]).map(tx=>[tx.tx_hash,tx]));txs=hashes.map(id=>{const tx=byHash.get(id);if(!tx||!tx.as_hex)throw Error('Transaction missing from daemon reply');return {txid:id,hex:tx.as_hex};});}
   const r=engine.call({op:'applyBlock',height,block:b.blob,txs});applied+=r.records.length;received+=r.native?.received||0;
   known.push(b.block_header.hash);
   if(height%25===0||height===tip)onProgress({phase:'scan',height,target:tip});
  }
  engine.call({op:'tip',height:tip});
  return {tip,tipHash:known[tip]||null,applied,received};
 }
 return {sync,reset,get height(){return known.length;}};
}
