// PARAMETER AUTHENTICATION (wasm engine in Node, real test backend, fault
// injection in the parameter transport). Proves that the holder accepts only
// the complete, byte-exact parameter files pinned by the manifest shipped with
// the build, and rejects everything else BEFORE deserialization, proving or
// publication: missing, truncated, interrupted, corrupted (query vector altered,
// verifying key kept), foreign (another setup/ledger), swapped, corrupted cache,
// and a server announcing another version/ledger. Then a genuine proof is made
// with the authenticated parameters, and a restarted engine loads from the
// verified cache without a download.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Keypair,Transaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {startBackend} from './backend/service.mjs';
import {createHolderEngine,createChainScanner} from './wallet-extension/src/holder-engine.js';
import {createParameterLoader,checkManifest} from './wallet-extension/src/holder-params.js';
const dir=fileURLToPath(new URL('./',import.meta.url));
const PORTS={rpcPort:30063,p2pPort:30062,httpPort:8943};
const BASE=`http://127.0.0.1:${PORTS.httpPort}`;
const hex=b=>Buffer.from(b).toString('hex');
const post=async(action,body)=>{const r=await fetch(`${BASE}/action/${action}`,{method:'POST',headers:{'content-type':'application/json',connection:'close'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
const closeFetch=(u,o={})=>fetch(u,{...o,headers:{...(o.headers||{}),connection:'close'}});// same-process backend: no idle keep-alive sockets across synchronous proofs
const memoryCache=()=>{const m=new Map();return {m,get:async k=>m.get(k)||null,put:async(k,v)=>{m.set(k,new Uint8Array(v));},delete:async k=>{m.delete(k);}};};
const manifestBytes=await readFile(dir+'params/test-v1/manifest.json');
const MANIFEST=JSON.parse(manifestBytes);
const OTHER=JSON.parse(await readFile(dir+'params/test-other/manifest.json','utf8'));
const results={rejections:[],accepted:[]};
test('parameter authentication: shipped manifest is the only trust anchor',{timeout:1500000},async()=>{
 const wasm=await WebAssembly.compile(await readFile(dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm'));
 // Manifest self-checks (what the worker does before anything else).
 const checked=await checkManifest(manifestBytes,{expectedSha256:createHash('sha256').update(manifestBytes).digest('hex')});assert.equal(checked.manifest.ledgerDomain,MANIFEST.ledgerDomain);
 await assert.rejects(checkManifest(manifestBytes,{expectedSha256:'00'.repeat(32)}),/does not match the hash compiled into it/);
 const tampered=Buffer.from(JSON.stringify({...MANIFEST,files:{...MANIFEST.files,normal:{...MANIFEST.files.normal,sha256:'zz'}}}));await assert.rejects(checkManifest(tampered),/complete pin/);
 const backend=await startBackend({...PORTS,log:m=>console.error('backend:',m),origins:[]});
 try{
  const engine=await createHolderEngine({wasm});const root=randomBytes(32);const d=engine.call({op:'derive',root:hex(root),account:0});
  const cache=memoryCache();const events=[];
  const loader=createParameterLoader({manifest:MANIFEST,engine,baseUrl:BASE,cache,log:e=>events.push(e)});
  // 1. Served configuration must equal the shipped one. Foreign parameters.json -> refused; engine refuses a foreign config too.
  backend.faults.parameters='foreign';await assert.rejects(loader.loadServedConfig(),/another version or ledger/);
  backend.faults.parameters='truncate';await assert.rejects(loader.loadServedConfig(),/another version or ledger/);
  backend.faults.parameters='missing';await assert.rejects(loader.loadServedConfig(),/missing from the parameter server/);
  backend.faults.parameters=null;const served=await loader.loadServedConfig();assert.deepEqual(served,MANIFEST.config);
  assert.throws(()=>engine.call({op:'params',manifest:MANIFEST,served:OTHER.config}),/different ledger or version/);
  // The engine trusts whatever manifest its host hands it (OTHER is internally valid and would be accepted): the host is therefore responsible for pinning the manifest, which the worker does through the compiled-in sha256 (checked above). Documented in PARAMETERS.txt.
  {const probe=await createHolderEngine({wasm});probe.call({op:'params',manifest:OTHER});assert.throws(()=>probe.call({op:'params',manifest:OTHER,served}),/different ledger or version/,'but a served config from our ledger is refused under the other manifest');}
  engine.call({op:'params',manifest:MANIFEST,served});
  const version=engine.call({op:'version'});assert.equal(version.parameterManifest,'XMR20-PARAMS-1');assert.equal(version.parameters.normalLoaded,false);
  // 2. Proving-key file faults: each must be rejected before use, nothing loaded, nothing cached.
  const expectReject=async(fault,re,slot=0)=>{backend.faults[slot?'boundary':'normal']=fault;let err=null;try{await loader.loadProvingKey(slot);}catch(e){err=e;}assert.ok(err,fault+' must be rejected');assert.match(err.message,re);assert.equal(err.name,'ParameterRejected');
   assert.equal(engine.call({op:'version'}).parameters[slot?'boundaryLoaded':'normalLoaded'],false,'nothing loaded after '+fault);assert.equal(cache.m.size,0,'nothing cached after '+fault);results.rejections.push({fault,slot,reason:err.reason,received:err.received??null,message:err.message});backend.faults[slot?'boundary':'normal']=null;};
  await expectReject('missing',/missing from the parameter server/);
  await expectReject('truncate',/truncated or substituted/);
  await expectReject('abort-midway',/interrupted after \d+ bytes/);
  await expectReject('corrupt-query',/sha256 .* does not match the shipped manifest/);
  await expectReject('foreign',/sha256 .* does not match the shipped manifest/);
  await expectReject('swap',/truncated or substituted/);
  await expectReject('swap',/truncated or substituted/,1);
  await expectReject('corrupt-query',/sha256 .* does not match/,1);
  // The altered-query-vector file keeps the expected verifying key: show that the OLD check would have passed, by extracting the vk bytes region (identical prefix) from the corrupted stream.
  {backend.faults.normal='corrupt-query';const bad=new Uint8Array(await (await fetch(BASE+'/params/normal.public-pk')).arrayBuffer());backend.faults.normal=null;const good=await readFile(dir+'params/test-v1/normal.public-pk');
   assert.equal(bad.length,good.length);const diff=[];for(let i=0;i<bad.length;i++)if(bad[i]!==good[i])diff.push(i);assert.equal(diff.length,1);assert.ok(diff[0]>65536,'the flipped byte lies far beyond the verifying-key prefix (query vector region)');
   assert.ok(Buffer.compare(Buffer.from(bad.subarray(0,65536)),good.subarray(0,65536))===0,'verifying-key prefix identical');results.corruptQueryOffset=diff[0];
   // Direct engine upload of the corrupted bytes is refused by the engine itself too (second line of defence).
   assert.throws(()=>engine.blob(0,bad),/sha256 .* does not match the shipped manifest/);assert.equal(engine.call({op:'version'}).parameters.normalLoaded,false);}
  // 3. Build before any key is loaded fails without touching the network.
  assert.throws(()=>engine.call({op:'build',kind:'send',to:'penumbra1x',amount:'1',notes:[]}),/.+/);
  // 4. Genuine download: accepted, cached, loaded.
  let t0=Date.now();const info=await loader.loadProvingKey(0);results.normalLoadMs=Date.now()-t0;assert.equal(info.authenticated,true);assert.equal(info.sha256,MANIFEST.files.normal.sha256);assert.equal(info.source,'download');assert.equal(cache.m.size,1);results.accepted.push(info);
  // 5. Cache corruption: a second engine (restart) finds a corrupted cache entry, discards it and downloads again; a swapped cache entry (foreign file under the right key) is also discarded.
  const key=loader.cacheKey(0);const cached=cache.m.get(key);const corrupt=new Uint8Array(cached);corrupt[corrupt.length-5]^=0xff;cache.m.set(key,corrupt);
  const e2=await createHolderEngine({wasm});e2.call({op:'params',manifest:MANIFEST,served});const ev2=[];const l2=createParameterLoader({fetch:closeFetch,manifest:MANIFEST,engine:e2,baseUrl:BASE,cache,log:e=>ev2.push(e)});
  const i2=await l2.loadProvingKey(0);assert.equal(i2.source,'download');assert.ok(ev2.some(e=>e.event==='cache-rejected'&&e.reason==='sha256'),JSON.stringify(ev2));assert.equal(hex(createHash('sha256').update(cache.m.get(key)).digest()),MANIFEST.files.normal.sha256,'cache repaired with the authenticated file');
  cache.m.set(key,new Uint8Array(await readFile(dir+'params/test-other/normal.public-pk')));const e2b=await createHolderEngine({wasm});e2b.call({op:'params',manifest:MANIFEST,served});const ev2b=[];await createParameterLoader({fetch:closeFetch,manifest:MANIFEST,engine:e2b,baseUrl:BASE,cache,log:e=>ev2b.push(e)}).loadProvingKey(0);assert.ok(ev2b.some(e=>e.event==='cache-rejected'));
  cache.m.set(key,cached.subarray(0,1000));const e2c=await createHolderEngine({wasm});e2c.call({op:'params',manifest:MANIFEST,served});const ev2c=[];await createParameterLoader({fetch:closeFetch,manifest:MANIFEST,engine:e2c,baseUrl:BASE,cache,log:e=>ev2c.push(e)}).loadProvingKey(0);assert.ok(ev2c.some(e=>e.event==='cache-rejected'&&e.reason==='length'));
  // 6. Restart recovery: a fresh engine with the intact cache loads with NO download even while the server is faulty.
  backend.faults.normal='missing';const e3=await createHolderEngine({wasm});e3.call({op:'params',manifest:MANIFEST,served});const l3=createParameterLoader({fetch:closeFetch,manifest:MANIFEST,engine:e3,baseUrl:BASE,cache});t0=Date.now();const i3=await l3.loadProvingKey(0);results.cacheLoadMs=Date.now()-t0;assert.equal(i3.source,'cache');backend.faults.normal=null;
  // 7. Interrupted download leaves nothing behind; the retry succeeds (boundary key, slot 1).
  backend.faults.boundary='abort-midway';await assert.rejects(loader.loadProvingKey(1),/interrupted/);assert.equal(cache.m.size,1);backend.faults.boundary=null;const ib=await loader.loadProvingKey(1);assert.equal(ib.source,'download');assert.equal(cache.m.size,2);results.accepted.push(ib);
  // 8. The authenticated parameters actually work: deposit, replay, prove a transfer, publish.
  const sol=Keypair.generate();const pub=()=>{const a=ed25519.utils.randomPrivateKey(),b=ed25519.utils.randomPrivateKey();return {A:hex(ed25519.getPublicKey(a)),B:hex(ed25519.getPublicKey(b))};};
  await post('register',{id:'paramsA',sol:sol.publicKey.toBase58(),xmr:'synthetic',...pub(),tokenAddress:d.tokenAddress});
  const prep=await post('depositPrepare',{id:'paramsA',symbol:'X',amount:'50000000'});const tx=Transaction.from(Buffer.from(prep.transaction,'base64'));tx.sign(sol);await post('depositSubmit',{id:'paramsA',nonce:prep.nonce,transaction:tx.serialize().toString('base64')});await post('mine',{blocks:10});
  const scanner=createChainScanner(engine,{rpc:backend.rpcUrl,genesis:MANIFEST.network.genesis});await scanner.sync();const X=backend.assets.X.asset;assert.equal(engine.call({op:'status'}).balances[X],'49250000');
  const sel=engine.call({op:'select',asset:X,amount:'10000000',exclude:[]});t0=Date.now();const built=engine.call({op:'build',kind:'send',to:d.tokenAddress,amount:'10000000',notes:sel.notes});results.provingMs=Date.now()-t0;assert.equal(built.bytes,996);
  const rel=await post('relay',{id:'paramsA',wire:built.wire});assert.ok(rel.txid);await post('mine',{blocks:10});await scanner.sync();assert.equal(engine.call({op:'status'}).balances[X],'49250000');assert.equal(engine.call({op:'status'}).notes.length,2);
  results.events=events;
 }finally{await backend.close();}
 // 9. A backend serving ANOTHER ledger's parameters (another setup) is refused end to end: parameters.json differs, and its proving key would differ.
 const other=await startBackend({...PORTS,log:()=>{},origins:[],paramsSet:'test-other'});
 try{const e=await createHolderEngine({wasm});const l=createParameterLoader({fetch:closeFetch,manifest:MANIFEST,engine:e,baseUrl:BASE,cache:memoryCache()});await assert.rejects(l.loadServedConfig(),/another version or ledger/);
  // Even if a caller skipped the config check, the file itself is refused.
  const bytes=new Uint8Array(await (await fetch(BASE+'/params/normal.public-pk')).arrayBuffer());e.call({op:'params',manifest:MANIFEST});assert.throws(()=>e.blob(0,bytes),/sha256 .* does not match the shipped manifest/);results.otherLedgerRefused=true;}
 finally{await other.close();await mkdir(dir+'runs',{recursive:true});await writeFile(dir+'runs/holder-params-results.json',JSON.stringify(results,null,1));}
 console.log(JSON.stringify({rejections:results.rejections.length,accepted:results.accepted.length,provingMs:results.provingMs,normalLoadMs:results.normalLoadMs,cacheLoadMs:results.cacheLoadMs}));
});
