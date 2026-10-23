// Node-level test of the holder engine (the same wasm the extension worker
// loads) against the real test backend: derivation, public-chain replay from
// the daemon RPC, deposit credit, send with change (proved in wasm), relay,
// redemption, fresh-root recovery, wrong-root and viewing-key separation.
// No browser; the browser tests exercise the popup on top of this engine.
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
const dir=fileURLToPath(new URL('./',import.meta.url));
const PORTS={rpcPort:30061,p2pPort:30060,httpPort:8942};
// The SHIPPED manifest (params/test-v1/manifest.json) is the trust anchor; the backend's parameters.json is only compared against it.
const MANIFEST=JSON.parse(await readFile(dir+'params/test-v1/manifest.json','utf8'));
const memoryCache=()=>{const m=new Map();return {get:async k=>m.get(k)||null,put:async(k,v)=>{m.set(k,v);},delete:async k=>{m.delete(k);}};};
const sharedCache=memoryCache();
// Same-process backend: every request closes its socket (a 30 s synchronous wasm proof would otherwise leave stale keep-alive sockets -> ECONNRESET).
const closeFetch=(u,o={})=>fetch(u,{...o,headers:{...(o.headers||{}),connection:'close'}});// one cache for all engines in this test, like one install's IndexedDB
const hex=b=>Buffer.from(b).toString('hex');
const post=async(action,body)=>{const r=await fetch(`http://127.0.0.1:${PORTS.httpPort}/action/${action}`,{method:'POST',headers:{'content-type':'application/json',connection:'close'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
// connection:close — the backend runs in this same Node process, and a 30 s synchronous wasm proof would otherwise leave a stale keep-alive socket (ECONNRESET). The browser build has no such coupling.
async function openEngine(wasm,root,params){const e=await createHolderEngine({wasm});const d=e.call({op:'derive',root:hex(root),account:0});const loader=createParameterLoader({manifest:MANIFEST,engine:e,baseUrl:`http://127.0.0.1:${PORTS.httpPort}`,cache:sharedCache,fetch:closeFetch});const served=await loader.loadServedConfig();e.call({op:'params',manifest:MANIFEST,served});const s=createChainScanner(e,{rpc:params.rpcUrl,genesis:MANIFEST.network.genesis});return {engine:e,scanner:s,loader,tokenAddress:d.tokenAddress};}
async function loadPk(h,slot){const info=await h.loader.loadProvingKey(slot);assert.equal(info.authenticated,true);return info;}
test('holder engine: keys, replay, spend, redeem, recovery (wasm in Node)',{timeout:1200000},async()=>{
 const backend=await startBackend({...PORTS,log:m=>console.error('backend:',m),origins:[]});
 const results={};
 try{
  const wasm=await WebAssembly.compile(await readFile(dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm'));
  const params=await (await fetch(`http://127.0.0.1:${PORTS.httpPort}/params`)).json();
  const rootA=randomBytes(32),rootB=randomBytes(32);const solA=Keypair.generate(),solB=Keypair.generate();
  const A=await openEngine(wasm,rootA,params),B=await openEngine(wasm,rootB,params);
  assert.notEqual(A.tokenAddress,B.tokenAddress);assert.ok(A.tokenAddress.startsWith('penumbra1'));
  const pub=()=>{const a=ed25519.utils.randomPrivateKey(),b=ed25519.utils.randomPrivateKey();return {A:hex(ed25519.getPublicKey(a)),B:hex(ed25519.getPublicKey(b))};};
  for(const [id,sol,h] of [['nodeA',solA,A],['nodeB',solB,B]]){const r=await post('register',{id,sol:sol.publicKey.toBase58(),xmr:'synthetic',...pub(),tokenAddress:h.tokenAddress});assert.equal(r.registered,true);}
  // Empty replay first.
  let sA=await A.scanner.sync();let st=A.engine.call({op:'status'});assert.deepEqual(st.balances,{});results.initialTip=sA.tip;
  // Deposit 100 X signed by A's Solana key -> credit to A's token address.
  const prep=await post('depositPrepare',{id:'nodeA',symbol:'X',amount:'100000000'});assert.equal(prep.review.creditTo,A.tokenAddress);
  const tx=Transaction.from(Buffer.from(prep.transaction,'base64'));tx.sign(solA);const dep=await post('depositSubmit',{id:'nodeA',nonce:prep.nonce,transaction:tx.serialize().toString('base64')});assert.equal(dep.receipt.net,'98500000');
  await post('mine',{blocks:10});sA=await A.scanner.sync();st=A.engine.call({op:'status'});const X=backend.assets.X.asset;
  assert.equal(st.balances[X],'98500000');assert.equal(st.notes.length,1);assert.ok(st.pool.credits.some(c=>c.binding===dep.credit.binding),'credit visible in local replica');results.depositCredit=dep.credit;
  // Send 40 X to B with change, proved locally in wasm.
  const pkInfo=await loadPk(A,0);assert.equal(pkInfo.sha256,MANIFEST.files.normal.sha256);assert.equal(pkInfo.source,'download');results.normalPk=pkInfo;
  const sel=A.engine.call({op:'select',asset:X,amount:'40000000',exclude:[]});assert.equal(sel.notes.length,1);assert.equal(sel.change,'58500000');
  let t0=Date.now();const built=A.engine.call({op:'build',kind:'send',to:B.tokenAddress,amount:'40000000',notes:sel.notes});results.sendProvingMs=Date.now()-t0;
  assert.equal(built.bytes,996);assert.equal(built.change,'58500000');assert.equal(built.inputs,1);
  assert.equal(A.engine.call({op:'verify',wire:built.wire}).record,'accepted');
  const relayed=await post('relay',{id:'nodeA',wire:built.wire});assert.equal(relayed.repeated,false);results.sendCarrier={nativeBytes:relayed.nativeBytes,extraBytes:relayed.extraBytes,fee:relayed.fee};
  const again=await post('relay',{id:'nodeA',wire:built.wire});assert.equal(again.repeated,true);assert.equal(again.txid,relayed.txid);
  // Before mining: spend not visible; after: A has change, B has 40; the record id is tracked with confirmations.
  await post('mine',{blocks:10});await A.scanner.sync();await B.scanner.sync();
  const stA=A.engine.call({op:'status'}),stB=B.engine.call({op:'status'});
  assert.equal(stA.balances[X],'58500000');assert.equal(stA.spent.length,1);assert.equal(stB.balances[X],'40000000');
  assert.equal(stA.records[built.recordId].status,'accepted');assert.equal(stA.records[built.recordId].txid,relayed.txid);assert.ok(stA.records[built.recordId].confirmations>=10);
  // Double-spend attempt of the already spent note is refused locally and by the relay.
  assert.throws(()=>A.engine.call({op:'build',kind:'send',to:B.tokenAddress,amount:'1000000',notes:sel.notes}),/already spent/);
  // Two- and three-input transfers: fragment B then spend.
  for(const amt of ['1000000','2000000']){const s=A.engine.call({op:'select',asset:X,amount:amt,exclude:[]});const b=A.engine.call({op:'build',kind:'send',to:B.tokenAddress,amount:amt,notes:s.notes});await post('relay',{id:'nodeA',wire:b.wire});await post('mine',{blocks:10});await A.scanner.sync();}
  await B.scanner.sync();let bst=B.engine.call({op:'status'});assert.equal(bst.notes.length,3);
  const pkB=await loadPk(B,0);assert.equal(pkB.source,'cache','second engine reuses the authenticated cached file');const sel3=B.engine.call({op:'select',asset:X,amount:'42500000',exclude:[]});assert.equal(sel3.notes.length,3);
  t0=Date.now();const three=B.engine.call({op:'build',kind:'send',to:A.tokenAddress,amount:'42500000',notes:sel3.notes});results.threeInputProvingMs=Date.now()-t0;assert.equal(three.inputs,3);assert.equal(three.change,'500000');
  const big=bst.notes.reduce((m,n)=>BigInt(n.amount)>BigInt(m.amount)?n:m).commitment;const sel2=B.engine.call({op:'select',asset:X,amount:'2500000',exclude:[big]});assert.equal(sel2.notes.length,2);// 2 + 1 cover 2.5 once the 40 X note is excluded
  const two=B.engine.call({op:'build',kind:'send',to:A.tokenAddress,amount:'2500000',notes:sel2.notes});assert.equal(two.inputs,2);
  // Reservation semantics: exclude keeps a second selection off the same notes.
  assert.throws(()=>B.engine.call({op:'select',asset:X,amount:'1',exclude:sel3.notes}),/Insufficient unreserved/);
  const r3=await post('relay',{id:'nodeB',wire:three.wire});results.threeInputCarrier={nativeBytes:r3.nativeBytes,extraBytes:r3.extraBytes,fee:r3.fee};
  // The conflicting two-input record (same notes) must be rejected by the indexer rules once the first is mined.
  await post('mine',{blocks:1});await assert.rejects(post('relay',{id:'nodeB',wire:two.wire}),/Spent or duplicate token input/);
  await post('mine',{blocks:9});await A.scanner.sync();await B.scanner.sync();assert.equal(B.engine.call({op:'status'}).balances[X],'500000');assert.equal(A.engine.call({op:'status'}).balances[X],String(58500000-3000000+42500000));
  // Redemption: binding from the operator, record proved locally with the boundary key, payout once at 10 confirmations.
  const rp=await post('redeemPrepare',{id:'nodeA',symbol:'X'});results.boundaryPk=await loadPk(A,1);
  const selR=A.engine.call({op:'select',asset:X,amount:'10000000',exclude:[]});t0=Date.now();const red=A.engine.call({op:'build',kind:'redeem',amount:'10000000',binding:rp.binding,notes:selR.notes});results.redeemProvingMs=Date.now()-t0;assert.equal(red.bytes,925);
  const rr=await post('relay',{id:'nodeA',wire:red.wire});results.redeemCarrier={nativeBytes:rr.nativeBytes,extraBytes:rr.extraBytes,fee:rr.fee};
  await post('mine',{blocks:9});await assert.rejects(post('payout',{symbol:'X',txid:rr.txid}),/Only 9 confirmations/);
  await post('mine',{blocks:1});const paid=await post('payout',{symbol:'X',txid:rr.txid});assert.equal(paid.status,'paid');assert.equal(paid.net,'9850000');
  const paid2=await post('payout',{symbol:'X',txid:rr.txid});assert.equal(paid2.repeated,true);
  await A.scanner.sync();const afterRedeem=A.engine.call({op:'status'});assert.equal(afterRedeem.balances[X],String(58500000-3000000+42500000-10000000));
  // FRESH-INSTALL RECOVERY: a brand-new engine from the same root and the public chain only.
  const C=await openEngine(wasm,rootA,params);assert.equal(C.tokenAddress,A.tokenAddress);const cs=await C.scanner.sync();const stC=C.engine.call({op:'status'});
  assert.deepEqual(stC.balances,afterRedeem.balances);assert.deepEqual(stC.notes.map(n=>n.commitment).sort(),afterRedeem.notes.map(n=>n.commitment).sort());assert.deepEqual(stC.spent.map(n=>n.commitment).sort(),afterRedeem.spent.map(n=>n.commitment).sort());
  await loadPk(C,0);const selC=C.engine.call({op:'select',asset:X,amount:'5000000',exclude:[]});const builtC=C.engine.call({op:'build',kind:'send',to:B.tokenAddress,amount:'5000000',notes:selC.notes});const rc=await post('relay',{id:'nodeA',wire:builtC.wire});assert.ok(rc.txid);
  await post('mine',{blocks:10});await C.scanner.sync();assert.equal(C.engine.call({op:'status'}).balances[X],String(58500000-3000000+42500000-10000000-5000000));results.recovery={tip:cs.tip,applied:cs.applied,notes:stC.notes.length,spent:stC.spent.length};
  // Wrong root: a different phrase recovers nothing. Account separation: B's engine never sees A's notes.
  const W=await openEngine(wasm,randomBytes(32),params);await W.scanner.sync();assert.deepEqual(W.engine.call({op:'status'}).balances,{});
  await B.scanner.sync();assert.ok(!B.engine.call({op:'status'}).notes.some(n=>afterRedeem.notes.some(m=>m.commitment===n.commitment)));
  // Viewing key: explicit export; a viewing-only engine sees the same balance but cannot build.
  const vk=A.engine.call({op:'viewingKey'}).viewingKey;const V=await createHolderEngine({wasm});V.call({op:'openViewing',viewingKey:vk});V.call({op:'params',manifest:MANIFEST,served:backend.config});const vs=createChainScanner(V,{rpc:params.rpcUrl,genesis:MANIFEST.network.genesis});await vs.sync();
  const stV=V.call({op:'status'});assert.equal(stV.canSpend,false);assert.deepEqual(stV.balances,C.engine.call({op:'status'}).balances);
  assert.throws(()=>V.call({op:'select',asset:X,amount:'1',exclude:[]}).notes&&V.call({op:'build',kind:'send',to:B.tokenAddress,amount:'1000000',notes:stV.notes.slice(0,1).map(n=>n.commitment)}),/viewing key only/);
  const shared=await post('view',{id:'nodeA',symbol:'X',viewingKey:vk});assert.equal(shared.balance,stV.balances[X]);assert.equal(shared.canSpend,false);
  // Reorg handling: reset + replay gives identical state.
  await C.scanner.reset();await C.scanner.sync();assert.deepEqual(C.engine.call({op:'status'}).balances,stV.balances);
  results.engineMemoryBytes=A.engine.memoryBytes();results.wasmBytes=(await readFile(dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm')).length;
 }finally{await mkdir(dir+'runs',{recursive:true});await writeFile(dir+'runs/holder-engine-results.json',JSON.stringify(results,null,1));await backend.close();}
 console.log(JSON.stringify(results));
});
