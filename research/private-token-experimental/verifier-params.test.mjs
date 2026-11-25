// VERIFIER-SIDE PARAMETER AUTHENTICATION (issuer and indexer roles of the lab binary, hardened copy at
// research/privacy-verifier-params-20261023-lab). Every role now requires a trusted manifest path that is
// independent of its parameter directory, authenticates parameters.json and the proving keys (exact length and
// sha256) BEFORE parsing, checks protocol/circuit/ledger/network identity, and compares the daemon's genesis.
// Any failure aborts the role before it can accept records or issue credits (no silent fallback).
// Negative matrix: missing / truncated / corrupted / substituted / foreign parameter files, foreign or tampered or
// missing manifest, manifest hash pin mismatch; restart recovery (an on-disk file corrupted after a good run);
// then a complete synthetic deposit -> credit -> transfer flow with the hardened roles and a holder engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,copyFile,rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Keypair,Transaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {startBackend,PARAMS_ROOT} from './backend/service.mjs';
import {service} from '../privacy-integration-20261022/rpc.mjs';
import {openPrivateWallet,memoryCache} from './wallet-lib/private-wallet.mjs';
const dir=fileURLToPath(new URL('./',import.meta.url));
const PORTS={rpcPort:30075,p2pPort:30074,httpPort:8948};const BASE=`http://127.0.0.1:${PORTS.httpPort}`;
const hex=b=>Buffer.from(b).toString('hex');const closeFetch=(u,o={})=>fetch(u,{...o,headers:{...(o.headers||{}),connection:'close'}});
const post=async(action,body)=>{const r=await closeFetch(`${BASE}/action/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
const MANIFEST=JSON.parse(await readFile(dir+'params/test-v1/manifest.json','utf8'));
const results={refusals:[],flow:{}};
test('issuer and indexer refuse unauthenticated parameters and still complete a credit/transfer flow',{timeout:2400000},async()=>{
 // 1. Negative matrix: each fault must stop the roles from starting (startBackend throws ROLE REFUSED TO START with the reason).
 const matrix=[
  [{file:'normal',kind:'missing'},/normal.public-pk refused/],
  [{file:'normal',kind:'truncate'},/normal.public-pk refused: \d+ bytes, the trusted manifest pins/],
  [{file:'normal',kind:'corrupt-query'},/normal.public-pk refused: sha256 .* differs from the trusted manifest/],
  [{file:'boundary',kind:'foreign'},/boundary.public-pk refused: sha256 .* differs/],
  [{file:'normal',kind:'swap'},/normal.public-pk refused: \d+ bytes/],
  [{file:'parameters',kind:'foreign'},/parameters.json refused: sha256|another ledger or version/],
  [{file:'parameters',kind:'truncate'},/parameters.json refused: \d+ bytes/],
  [{manifest:'foreign'},/parameters.json refused: sha256|another ledger or version/],
  [{manifest:'tamper-genesis'},/genesis differs from its configuration/],
  [{manifest:'tamper-hash'},/normal.public-pk refused: sha256/],
  [{manifest:'missing'},/Trusted manifest .*: No such file/],
  [{manifest:'pin-mismatch'},/Trusted manifest sha256 .* does not match the pinned value/],
 ];
 for(const [roleFaults,re] of matrix){let err=null;let b=null;try{b=await startBackend({...PORTS,log:()=>{},origins:[],roleFaults});}catch(e){err=e;}finally{if(b)await b.close();}
  assert.ok(err,'roles must refuse to start with '+JSON.stringify(roleFaults));assert.match(err.message,/ROLE REFUSED TO START/);assert.match(err.message,re,JSON.stringify(roleFaults)+': '+err.message);
  results.refusals.push({roleFaults,message:err.message.replace(/\s+/g,' ').slice(0,220)});console.log('refused',JSON.stringify(roleFaults));}
 // The indexer alone (no proving keys needed) still refuses a bad parameters.json / manifest: covered above since startBackend starts the issuer first; check the indexer directly too.
 {const backend=await startBackend({...PORTS,log:()=>{},origins:[]});try{
   const tampered=backend.run+'/trusted-tampered.json';const m=JSON.parse(await readFile(backend.run+'/trusted/manifest.json','utf8'));m.protocol.records.transfer.bytes=997;await writeFile(tampered,JSON.stringify(m));
   await assert.rejects(service(backend.bin,['indexer',backend.run+'/parameters','--trusted-manifest',tampered],{env:{XMR20_INTEGRATION_LAB:'offline-synthetic-only',XMR20_INTEGRATION_RPC_PORT:String(PORTS.rpcPort)}}),/transfer circuit shape differs/);
   await assert.rejects(service(backend.bin,['indexer',backend.run+'/parameters'],{env:{XMR20_INTEGRATION_LAB:'offline-synthetic-only',XMR20_INTEGRATION_RPC_PORT:String(PORTS.rpcPort)}}),/--trusted-manifest <path> is required/);
   results.refusals.push({roleFaults:{indexer:'manifest circuit shape 997'},message:'transfer circuit shape differs from this binary'},{roleFaults:{indexer:'no --trusted-manifest'},message:'required; no unauthenticated parameter loading'});
  }finally{await backend.close();}}
 // 2. Valid set: roles start and report the trusted manifest; complete flow deposit -> credit (issuer signs with authenticated keys) -> transfer (holder) -> indexer admits -> redemption.
 const backend=await startBackend({...PORTS,log:m=>console.error('backend:',m),origins:[]});
 try{
  assert.equal(backend.roleManifests.issuer.sha256,backend.roleManifests.indexer.sha256);assert.match(backend.roleManifests.issuer.label,/DISPOSABLE TEST SETUP/);results.flow.roleManifest=backend.roleManifests.issuer;
  const wasm=await readFile(dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm');
  const A=await openPrivateWallet({wasm,manifest:MANIFEST,daemonRpc:backend.rpcUrl,parameterServer:BASE,cache:memoryCache(),fetch:closeFetch,root:hex(randomBytes(32))});
  const B=await openPrivateWallet({wasm,manifest:MANIFEST,daemonRpc:backend.rpcUrl,parameterServer:BASE,cache:memoryCache(),fetch:closeFetch,root:hex(randomBytes(32))});
  const sol=Keypair.generate();const pub=()=>{const a=ed25519.utils.randomPrivateKey(),b=ed25519.utils.randomPrivateKey();return {A:hex(ed25519.getPublicKey(a)),B:hex(ed25519.getPublicKey(b))};};
  await post('register',{id:'A',sol:sol.publicKey.toBase58(),xmr:A.nativeAddress(),...pub(),tokenAddress:A.address()});
  const prep=await post('depositPrepare',{id:'A',symbol:'X',amount:'30000000'});const tx=Transaction.from(Buffer.from(prep.transaction,'base64'));tx.sign(sol);const dep=await post('depositSubmit',{id:'A',nonce:prep.nonce,transaction:tx.serialize().toString('base64')});
  await post('fund',{id:'A',blocks:1});await post('mine',{blocks:50});await post('mine',{blocks:12});await A.sync();const X=backend.assets.X.asset;assert.equal(A.status().balances[X],'29550000','credit issued by the hardened issuer and admitted locally');
  const sel=A.select({asset:X,amount:'10000000'});const q=await A.quoteCarrier({kind:'send'});const built=await A.prove({kind:'send',to:B.address(),amount:'10000000',notes:sel.notes});const c=A.signCarrier(q.quoteId,built.wire);assert.equal((await A.publish(c.blob)).ok,true);await post('mine',{blocks:10});await A.sync();await B.sync();
  assert.equal(B.status().balances[X],'10000000');const scan=await backend.indexer.call({op:'scan'});assert.ok(scan.public.events.some(e=>e.txid===c.txid&&e.result?.record==='accepted'),'hardened indexer admitted the transfer');
  const rp=await post('redeemPrepare',{id:'A',symbol:'X'});const selR=A.select({asset:X,amount:'1000000'});const qR=await A.quoteCarrier({kind:'redeem'});const red=await A.prove({kind:'redeem',amount:'1000000',binding:rp.binding,notes:selR.notes});const cR=A.signCarrier(qR.quoteId,red.wire);assert.equal((await A.publish(cR.blob)).ok,true);await post('mine',{blocks:10});const paid=await post('payout',{symbol:'X',txid:cR.txid});assert.equal(paid.status,'paid');
  results.flow={...results.flow,credit:dep.credit.txid,transfer:c.txid,redemption:cR.txid,payout:paid.status,balanceA:A.status().balances[X],balanceB:B.status().balances[X]};
  // 3. Restart recovery: the roles' on-disk copy (their "cache") is corrupted after the good run; a restarted indexer refuses; restoring the file lets it start and replay the same pool state.
  const pd=backend.run+'/parameters';const trusted=backend.run+'/trusted/manifest.json';const env={XMR20_INTEGRATION_LAB:'offline-synthetic-only',XMR20_INTEGRATION_RPC_PORT:String(PORTS.rpcPort)};
  const good=await readFile(pd+'/parameters.json');const bad=Buffer.from(good);bad[bad.length-10]^=1;await writeFile(pd+'/parameters.json',bad);
  await assert.rejects(service(backend.bin,['indexer',pd,'--trusted-manifest',trusted],{env}),/parameters.json refused: sha256/);
  await rm(pd+'/normal.public-pk');await copyFile(PARAMS_ROOT+'/test-other/normal.public-pk',pd+'/normal.public-pk');await writeFile(pd+'/parameters.json',good);
  await assert.rejects(service(backend.bin,['issuer',pd,'--trusted-manifest',trusted],{env}),/normal.public-pk refused: sha256/);
  await rm(pd+'/normal.public-pk');await copyFile(PARAMS_ROOT+'/test-v1/normal.public-pk',pd+'/normal.public-pk');
  const restarted=await service(backend.bin,['indexer',pd,'--trusted-manifest',trusted],{env});try{const s2=await restarted.call({op:'scan'});assert.equal(s2.public.events.filter(e=>e.result?.record==='accepted').length,scan.public.events.filter(e=>e.result?.record==='accepted').length+1,'restarted indexer replays the same pool (plus the redemption)');results.flow.restartRecovered=true;}finally{await restarted.close();}
 }finally{await backend.close();await mkdir(dir+'runs',{recursive:true});await writeFile(dir+'runs/verifier-params-results.json',JSON.stringify(results,null,1));}
 console.log(JSON.stringify({refusals:results.refusals.length,flow:results.flow}));
});
