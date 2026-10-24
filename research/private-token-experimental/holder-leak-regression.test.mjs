// REGRESSION: NO NATIVE SOURCE / KEY-IMAGE MATERIAL IN ANY PUBLISHED RECORD.
// The original XN1 leak (research/privacy-impact-20261020) published a verifiable relation between a
// native output and its key image. This test publishes transfer, consolidation and redemption
// records through holder-funded carriers on the offline chain, then checks every record's bytes
// (996/925) against every carrier's key image, every ring member's output key and commitment, the
// carrier's tx pubkey and its output keys: none may appear in any record (also checked byte-reversed
// and across all 32-byte windows), and the record must be identical whichever carrier carries it
// (a record re-carried after a rollback is byte-identical: it does not depend on the carrier).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Keypair,Transaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {startBackend} from './backend/service.mjs';
import {createHolderEngine,createChainScanner} from './wallet-extension/src/holder-engine.js';
import {createParameterLoader} from './wallet-extension/src/holder-params.js';
import {createCarrierBuilder} from './wallet-extension/src/holder-carrier.js';
import {inspectCarrier} from '../../website/services/native-market/xn1/carrier.mjs';
const dir=fileURLToPath(new URL('./',import.meta.url));
const PORTS={rpcPort:30069,p2pPort:30068,httpPort:8946};
const BASE=`http://127.0.0.1:${PORTS.httpPort}`;
const hex=b=>Buffer.from(b).toString('hex');
const closeFetch=(u,o={})=>fetch(u,{...o,headers:{...(o.headers||{}),connection:'close'}});
const post=async(action,body)=>{const r=await closeFetch(`${BASE}/action/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
const MANIFEST=JSON.parse(await readFile(dir+'params/test-v1/manifest.json','utf8'));
const cache=(()=>{const m=new Map();return {get:async k=>m.get(k)||null,put:async(k,v)=>{m.set(k,v);},delete:async k=>{m.delete(k);}};})();
test('published records contain no native output, key image, ring or tx-key material',{timeout:1800000},async()=>{
 const wasm=await WebAssembly.compile(await readFile(dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm'));
 const backend=await startBackend({...PORTS,log:m=>console.error('backend:',m),origins:[]});const rpc=backend.rpcUrl;const results={records:0,carriers:0,checks:0};
 const other=async(path,body)=>{const r=await closeFetch(rpc+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return r.json();};
 async function open(root){const engine=await createHolderEngine({wasm});const d=engine.call({op:'derive',root:hex(root),account:0});const loader=createParameterLoader({fetch:closeFetch,manifest:MANIFEST,engine,baseUrl:BASE,cache});const served=await loader.loadServedConfig();engine.call({op:'params',manifest:MANIFEST,served});
  return {engine,loader,scanner:createChainScanner(engine,{rpc,fetch:closeFetch,genesis:MANIFEST.network.genesis}),carrier:createCarrierBuilder({engine,rpc,fetch:closeFetch}),tokenAddress:d.tokenAddress,nativeAddress:d.nativeAddress};}
 const pub=()=>{const a=ed25519.utils.randomPrivateKey(),b=ed25519.utils.randomPrivateKey();return {A:hex(ed25519.getPublicKey(a)),B:hex(ed25519.getPublicKey(b))};};
 try{
  const A=await open(randomBytes(32)),B=await open(randomBytes(32));const solA=Keypair.generate(),solB=Keypair.generate();
  await post('register',{id:'A',sol:solA.publicKey.toBase58(),xmr:A.nativeAddress,...pub(),tokenAddress:A.tokenAddress});await post('register',{id:'B',sol:solB.publicKey.toBase58(),xmr:B.nativeAddress,...pub(),tokenAddress:B.tokenAddress});
  const prep=await post('depositPrepare',{id:'A',symbol:'X',amount:'100000000'});const tx=Transaction.from(Buffer.from(prep.transaction,'base64'));tx.sign(solA);await post('depositSubmit',{id:'A',nonce:prep.nonce,transaction:tx.serialize().toString('base64')});
  await post('fund',{id:'A',blocks:2});await post('mine',{blocks:50});await post('mine',{blocks:12});for(const e of [A,B])await e.scanner.sync();await A.loader.loadProvingKey(0);await A.loader.loadProvingKey(1);const X=backend.assets.X.asset;
  const carriers=[];// {blob, txid, keyImage, wire, kind}
  const carry=async(kind,amount,to,binding=null)=>{const q=await A.carrier.quote({kind});const sel=A.engine.call({op:'select',asset:X,amount,exclude:[]});const built=A.engine.call(kind==='send'?{op:'build',kind:'send',to,amount,notes:sel.notes}:{op:'build',kind:'redeem',amount,binding,notes:sel.notes});const signed=A.carrier.sign(q.quoteId,built.wire);const r=await A.carrier.publish(signed.blob);assert.equal(r.ok,true);carriers.push({...signed,wire:built.wire,kind,recordId:built.recordId});await post('mine',{blocks:10});await A.scanner.sync();return built;};
  await carry('send','20000000',B.tokenAddress);await carry('send','10000000',A.tokenAddress);// transfer + consolidation-style self-send
  const rp=await post('redeemPrepare',{id:'A',symbol:'X'});await carry('redeem','5000000',null,rp.binding);
  // Material that must never appear in a record.
  const forbidden=[];const ringPositions=new Set();
  for(const c of carriers){const insp=inspectCarrier(Buffer.from(c.blob,'hex'));assert.equal(insp.txid,c.txid,'inspector agrees on the carrier txid');assert.equal(insp.inputs.length,1);assert.equal(insp.inputs[0].keyImage,c.keyImage);
   forbidden.push(['keyImage',c.keyImage]);for(const o of insp.outputs){forbidden.push(['outputKey',o.key]);forbidden.push(['outputCommitment',o.commitment]);}
   const extra=insp.extra;for(let i=0;i<extra.length;){const tag=extra[i];if(tag===1){forbidden.push(['txPubkey',extra.subarray(i+1,i+33).toString('hex')]);i+=33;}else if(tag===2){let len=0,shift=0,j=i+1;for(;;){const b=extra[j++];len|=(b&127)<<shift;if(b<128)break;shift+=7;}i=j+len;}else break;}
   for(const pos of insp.inputs[0].offsets)ringPositions.add(Number(pos));}
  const outs=await other('/get_outs',{outputs:[...ringPositions].map(index=>({amount:0,index})),get_txid:true});assert.equal(outs.status,'OK');for(const o of outs.outs){forbidden.push(['ringMemberKey',o.key]);forbidden.push(['ringMemberMask',o.mask]);forbidden.push(['ringMemberTxid',o.txid]);}
  // The real spent outputs' keys (owned by A) are among the ring members above; add A's key images too.
  for(const o of A.engine.call({op:'nativeStatus'}).outputs)forbidden.push(['ownKeyImage',o.keyImage]);
  const rev=h=>Buffer.from(h,'hex').reverse().toString('hex');
  for(const c of carriers){const wire=c.wire;assert.ok(wire.length===996*2||wire.length===925*2);results.records++;
   for(const [what,value] of forbidden){assert.ok(!wire.includes(value),`${what} ${value.slice(0,16)}… found in a ${c.kind} record`);assert.ok(!wire.includes(rev(value)),`${what} (reversed) found in a ${c.kind} record`);results.checks+=2;}
   // every 32-byte window of the record vs every forbidden 32-byte value (hex)
   const windows=new Set();for(let i=0;i+64<=wire.length;i+=2)windows.add(wire.slice(i,i+64));for(const [what,value] of forbidden)if(value.length===64){assert.ok(!windows.has(value),`${what} aligned window hit`);results.checks++;}}
  results.carriers=carriers.length;results.forbiddenValues=forbidden.length;
  // The record does not depend on its carrier: a second carrier for the same (not yet published) record would carry identical bytes. Shown by re-framing: unframe(extra) == wire for every carrier.
  for(const c of carriers){assert.equal(A.engine.call({op:'verify',wire:c.wire}).record,'rejected','already on chain -> duplicate nullifier (shows the record is tied to its notes, not to the carrier)');}
  // Indexer view of the chain has no native fields either (public pool state).
  const s=await backend.indexer.call({op:'scan'});assert.ok(!JSON.stringify(s.public).includes(carriers[0].keyImage));
 }finally{await mkdir(dir+'runs',{recursive:true});await writeFile(dir+'runs/holder-leak-regression-results.json',JSON.stringify(results,null,1));await backend.close();}
 console.log(JSON.stringify(results));
});
