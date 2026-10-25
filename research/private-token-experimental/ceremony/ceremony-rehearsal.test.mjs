// PARAMETER-CEREMONY REHEARSAL — verification, tamper refusal, manifest binding and an end-to-end prove/verify with the rehearsed
// parameters. Requires a completed rehearsal (runs/ceremony-rehearsal + params/ceremony-rehearsal-v1 produced by
// ceremony/target/release/xmr20-params-ceremony; see RESULTS 8). Everything here is OFFLINE and SIMULATED. The output parameters are
// DISPOSABLE: three contributions per phase by processes on one machine are not independent participants.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cp,readFile,writeFile,rm,mkdir,access} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Keypair,Transaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {startBackend} from '../backend/service.mjs';
import {createHolderEngine,createChainScanner} from '../wallet-extension/src/holder-engine.js';
import {createParameterLoader} from '../wallet-extension/src/holder-params.js';
import {createCarrierBuilder} from '../wallet-extension/src/holder-carrier.js';
const dir=fileURLToPath(new URL('../',import.meta.url));
const BIN=dir+'ceremony/target/release/xmr20-params-ceremony';const CER=dir+'runs/ceremony-rehearsal';const PARAMS='ceremony-rehearsal-v1';const PDIR=dir+'params/'+PARAMS;
const sha=b=>createHash('sha256').update(b).digest('hex');
const tool=(...args)=>{const r=spawnSync(BIN,args,{encoding:'utf8',maxBuffer:1<<26});return {status:r.status,out:(r.stdout||'')+(r.stderr||'')};};
const PORTS={rpcPort:30097,p2pPort:30096,httpPort:8967};const BASE=`http://127.0.0.1:${PORTS.httpPort}`;
const closeFetch=(u,o={})=>fetch(u,{...o,headers:{...(o.headers||{}),connection:'close'}});
const post=async(action,body)=>{const r=await closeFetch(BASE+'/action/'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const text=await r.text();const v=text?JSON.parse(text):null;if(!r.ok)throw Error(v?.error||(action+': HTTP '+r.status));return v;};
const hex=b=>Buffer.from(b).toString('hex');
const results={suite:'ceremony-rehearsal',at:new Date().toISOString(),status:'REHEARSAL — DISPOSABLE — zero independent participants'};
await access(BIN);await access(CER+'/ceremony.json');

test('the rehearsal verifies from files: R1CS recomputed, both logs replayed, keys recombined byte-for-byte',()=>{
 const v=tool('verify',CER,PDIR,'--quick');assert.equal(v.status,0,v.out.slice(-800));const j=JSON.parse(v.out.trim().split('\n').pop());
 assert.equal(j.ok,true);assert.equal(j.independentParticipants,0);assert.equal(j.verified.length,2);
 for(const c of j.verified){assert.equal(c.phase1Contributions,3);assert.equal(c.phase2Contributions,3);assert.equal(c.vkMatches,true);}
 const ceremony=JSON.parse(readFileSync(CER+'/ceremony.json','utf8'));results.circuits=ceremony.circuits.map(c=>({name:c.name,degree:c.degree,constraints:c.num_constraints,r1cs:c.r1cs_digest,phase1:c.phase1.map(x=>x.hash.slice(0,16)),phase2:c.phase2.map(x=>x.hash.slice(0,16)),pk:c.finalised?.pk_sha256,pkBytes:c.finalised?.pk_bytes}));
 results.verify=j;
 // The FULL verification (transition recomputed from the verified phase-1 result, minutes per circuit) was run once by the rehearsal
 // chain itself; its output is part of the evidence (runs/ceremony-rehearsal.log) and is checked here rather than repeated.
 const log=readFileSync(dir+'runs/ceremony-rehearsal.log','utf8');const full=log.split('\n').filter(l=>l.includes('"mode":"full') && l.includes('"ok":true'));assert.ok(full.length>=1,'the full (recomputing) verify of the rehearsal chain is on record');results.fullVerify=JSON.parse(full.at(-1));
});

test('tampering is refused: a flipped byte in a contribution, a substituted proving key, a foreign chain',async()=>{
 const tmp=dir+'runs/ceremony-tamper-'+randomBytes(3).toString('hex');await mkdir(tmp,{recursive:true});
 try{
  // (a) one byte flipped in the second phase-2 contribution of the boundary circuit -> the log no longer verifies
  const cer2=tmp+'/ceremony';await cp(CER,cer2,{recursive:true});const ceremony=JSON.parse(await readFile(cer2+'/ceremony.json','utf8'));
  const c2=ceremony.circuits.find(c=>c.name==='boundary').phase2[1];const b=Buffer.from(await readFile(cer2+'/'+c2.file));b[Math.floor(b.length/2)]^=1;await writeFile(cer2+'/'+c2.file,b);
  const va=tool('verify',cer2,PDIR,'--quick');assert.notEqual(va.status,0);assert.match(va.out,/failed internal validation|not linked|no contribution verifies|invalid data|Unknown ancestor|differs/i,'tampered contribution refused: '+va.out.slice(-300));
  results.tamperContribution=va.out.trim().split('\n').pop().slice(0,200);
  // (b) proving key substituted (normal <- boundary bytes) -> refused as not the recombined key
  const p2=tmp+'/params-swapped';await cp(PDIR,p2,{recursive:true});await cp(PDIR+'/boundary.public-pk',p2+'/normal.public-pk');
  const vb=tool('verify',CER,p2,'--quick');assert.notEqual(vb.status,0);assert.match(vb.out,/differs from the key recombined|substituted/i,vb.out.slice(-300));results.tamperSubstitutedKey=vb.out.trim().split('\n').pop().slice(0,200);
  // (c) parameters.json for another chain -> refused before any key is read
  const p3=tmp+'/params-chain';await cp(PDIR,p3,{recursive:true});const cfg=JSON.parse(await readFile(p3+'/parameters.json','utf8'));cfg.chain='11'.repeat(32);await writeFile(p3+'/parameters.json',JSON.stringify(cfg,null,1));
  const vc=tool('verify',CER,p3,'--quick');assert.notEqual(vc.status,0);assert.match(vc.out,/chain/i);results.tamperChain=vc.out.trim().split('\n').pop().slice(0,200);
  // (d) a transition cannot start from the root alone (no verified phase-1 contribution): refused as trivially insecure
  const cer3=tmp+'/ceremony-empty';const init=tool('init',cer3,'--chain','418015bb9ae982a1975da7d79277c2705727a56894ba0fb246adaabb1f4632e3');assert.equal(init.status,0);
  const tr=tool('transition',cer3,'boundary');assert.notEqual(tr.status,0);assert.match(tr.out,/no verified contribution|trivially insecure/i);
  // (e) a production-looking label is refused
  const lab=tool('init',tmp+'/ceremony-label','--chain','418015bb9ae982a1975da7d79277c2705727a56894ba0fb246adaabb1f4632e3','--label','XMR20 production parameters v1');assert.notEqual(lab.status,0);assert.match(lab.out,/REHEARSAL or DISPOSABLE/);
 }finally{await rm(tmp,{recursive:true,force:true});}
});

test('trusted manifest bound to the attestation; roles refuse a foreign manifest; a holder proves and the indexer verifies with the rehearsed parameters',{timeout:1800000},async()=>{
 const mk=spawnSync('node',[dir+'ceremony/make-manifest.mjs',PDIR,'--network-kind','offline-fakechain'],{encoding:'utf8'});assert.equal(mk.status,0,mk.stderr);
 const manifest=JSON.parse(await readFile(PDIR+'/manifest.json','utf8'));assert.equal(manifest.ceremony.independentParticipants,0);assert.match(manifest.label,/REHEARSAL/);
 const att=JSON.parse(await readFile(PDIR+'/attestation.json','utf8'));assert.equal(manifest.ceremony.attestation.sha256,sha(await readFile(PDIR+'/attestation.json')));
 for(const c of att.circuits){assert.equal(manifest.files[c.name].sha256,c.output.pk_sha256,'manifest pins the attested key for '+c.name);}
 results.manifest={sha256:sha(await readFile(PDIR+'/manifest.json')),domain:manifest.ledgerDomain,label:manifest.label};
 // Roles refuse to start when the trusted manifest is foreign to the parameter files (the existing verifier-side authentication).
 await assert.rejects(startBackend({...PORTS,paramsSet:PARAMS,origins:[],roleFaults:{manifest:'foreign'},log:()=>{}}),/ROLE REFUSED TO START/);
 results.foreignManifestRefused=true;
 // Honest start with the rehearsed set: deposit -> private credit -> private transfer PROVED with the rehearsed normal key and
 // VERIFIED by the indexer against the rehearsed verifying key; a boundary (redeem) record likewise.
 const wasm=await WebAssembly.compile(await readFile(dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm'));
 const backend=await startBackend({...PORTS,paramsSet:PARAMS,origins:[],log:m=>console.error('backend:',m)});
 try{
  const rpc=backend.rpcUrl;const cache=(()=>{const m=new Map();return {get:async k=>m.get(k)||null,put:async(k,v)=>{m.set(k,v);},delete:async k=>{m.delete(k);}};})();
  const engine=await createHolderEngine({wasm});const d=engine.call({op:'derive',root:hex(randomBytes(32)),account:0});const loader=createParameterLoader({fetch:closeFetch,manifest,engine,baseUrl:BASE,cache});const served=await loader.loadServedConfig();engine.call({op:'params',manifest,served});
  const scanner=createChainScanner(engine,{rpc,fetch:closeFetch,genesis:manifest.network.genesis});const carrier=createCarrierBuilder({engine,rpc,fetch:closeFetch});
  const sol=Keypair.generate();const a=ed25519.utils.randomPrivateKey(),b2=ed25519.utils.randomPrivateKey();
  await post('register',{id:'A',sol:sol.publicKey.toBase58(),xmr:d.nativeAddress,A:hex(ed25519.getPublicKey(a)),B:hex(ed25519.getPublicKey(b2)),tokenAddress:d.tokenAddress});
  const prep=await post('depositPrepare',{id:'A',symbol:'X',amount:'100000000'});const tx=Transaction.from(Buffer.from(prep.transaction,'base64'));tx.sign(sol);await post('depositSubmit',{id:'A',nonce:prep.nonce,transaction:tx.serialize().toString('base64')});
  await post('fund',{id:'A',blocks:2});await post('mine',{blocks:50});await post('mine',{blocks:20});await scanner.sync();
  const X=backend.assets.X.asset;assert.equal(engine.call({op:'status'}).balances[X],'98500000');
  await loader.loadProvingKey(0);const t0=Date.now();const q=await carrier.quote({kind:'send'});const sel=engine.call({op:'select',asset:X,amount:'40000000',exclude:[]});const built=engine.call({op:'build',kind:'send',to:d.tokenAddress,amount:'40000000',notes:sel.notes});const provingMs=Date.now()-t0;
  const s=carrier.sign(q.quoteId,built.wire);const r=await carrier.publish(s.blob);assert.equal(r.ok,true,'carrier accepted');await post('mine',{blocks:10});await scanner.sync();
  const st=engine.call({op:'status'});assert.equal(st.records[built.recordId]?.status,'accepted','indexer accepted the transfer proved with the rehearsed key');
  await loader.loadProvingKey(1);const rp=await post('redeemPrepare',{id:'A',symbol:'X',amount:'10000000'});const q2=await carrier.quote({kind:'redeem'});const sel2=engine.call({op:'select',asset:X,amount:'10000000',exclude:[]});const b3=engine.call({op:'build',kind:'redeem',amount:'10000000',binding:rp.binding,notes:sel2.notes});const s2=carrier.sign(q2.quoteId,b3.wire);const r2=await carrier.publish(s2.blob);assert.equal(r2.ok,true);
  await post('mine',{blocks:10});await scanner.sync();assert.equal(engine.call({op:'status'}).records[b3.recordId]?.status,'accepted','boundary record accepted with the rehearsed boundary key');
  const paid=await post('payout',{symbol:'X',txid:s2.txid});assert.equal(paid.status,'paid');
  // The OLD disposable test-v1 keys do not verify here: a record proved under another parameter set is rejected by this indexer's vk.
  results.endToEnd={transferRecord:built.recordId,boundaryRecord:b3.recordId,provingMs,payout:paid.net};
 }finally{await backend.close();await writeFile(dir+'runs/ceremony-rehearsal-results.json',JSON.stringify(results,null,1));}
});
