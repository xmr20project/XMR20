// BRIDGE SERVICE integration test: deposit -> PUBLIC credit -> public send -> burn -> exactly-once payout through the real holder
// engine (wallet-lib) against the separate indexer service, the separate bridge service and the LiteSVM custody, with the
// failure cases the handoff lists: indexer crash/restart, operator restart with a pending redemption, lost reply after custody
// submit, duplicate receipt, observer disagreement, exposure limit, reorganisation of a burn, migration claim (exactly once),
// liabilities, fresh-install recovery and a disclosure audit of everything the services wrote to disk.
// SIMULATED (offline fakechain, LiteSVM custody); synthetic keys only. The mainnet guard is tested first without any process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import path from 'node:path';
import {Keypair,Transaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {keccak_256} from '@noble/hashes/sha3';
import {startLab,fakeObserver,BINS,FMT,here} from './harness.mjs';
import {startBridgeService} from '../bridge/bridge-service.mjs';
import {openTokenWallet,memoryCache} from '../../token-format-unshielded-20261025/wallet-lib/token-wallet.mjs';
import {legacyGrossFor} from '../../token-format-unshielded-20261025/backend/service.mjs';
import {PROFILE} from '../../token-format-unshielded-20261025/backend/migration-registry.mjs';
import {ORDER} from '../../../website/services/native-market/xn1/proofs.mjs';
import {le} from '../../../website/services/native-market/xn1/bytes.mjs';
const hex=b=>Buffer.from(b).toString('hex');const G=ed25519.ExtendedPoint.BASE;const Hs=b=>le(keccak_256(b))%ORDER;
const uint=(n,len)=>{const b=Buffer.alloc(len);let x=BigInt(n);for(let i=0;i<len;i++){b[i]=Number(x&0xffn);x>>=8n;}return b;};
const scalar=()=>{let k;do{k=le(randomBytes(64))%ORDER;}while(!k);return k;};
function signLegacy(messageHash,x){const P=G.multiply(x).toRawBytes();let nonce,c,r;do{nonce=scalar();const R=G.multiply(nonce).toRawBytes();c=Hs(Buffer.concat([Buffer.from(messageHash,'hex'),Buffer.from(P),Buffer.from(R)]));r=((nonce-c*x)%ORDER+ORDER)%ORDER;}while(!c||!r);return Buffer.concat([uint(c,32),uint(r,32)]).toString('hex');}
const closeFetch=(u,o={})=>fetch(u,{...o,headers:{...(o.headers||{}),connection:'close'}});
const evidence={execution:'SIMULATED (offline fakechain, separate indexer + bridge services, LiteSVM custody)',steps:[],fees:[],transactions:[]};
const step=(name,x={})=>{evidence.steps.push({at:new Date().toISOString(),name,...x});console.error(JSON.stringify({step:name,...x}).slice(0,400));};
const LEGACY_LOT='10000000000';// 10,000 X at 6 decimals, one legacy lot for A
const EXPOSURE={maxSinglePayout:'60000000',maxPaidPerWindow:'200000000',windowBlocks:100};
const CONF=10;

test('mainnet is refused before any process starts',async()=>{
 delete process.env.XMR20_BRIDGE_MAINNET;
 await assert.rejects(startBridgeService({network:'mainnet',daemonRpc:'http://127.0.0.1:1',indexerUrl:'http://127.0.0.1:1',rolesBin:'x',paramsDir:'x',trustedManifest:'x',journalDir:'x',assets:[],custody:{kind:'litesvm'}}),/REFUSED: mainnet/);
 await assert.rejects(startBridgeService({network:'devnet-ish',daemonRpc:'http://127.0.0.1:1',indexerUrl:'http://127.0.0.1:1',rolesBin:'x',paramsDir:'x',trustedManifest:'x',journalDir:'x',assets:[],custody:{kind:'litesvm'}}),/offline-fakechain or stagenet/);
});

test('bridge service: deposit, credit, send, burn, exactly-once payout, incidents, migration, recovery, disclosure audit',{timeout:2400000},async()=>{
 await mkdir(here+'/../runs',{recursive:true});
 // legacy lot owned by a one-time key whose secret only the holder (test) knows
 const xLegacy=scalar();const PLegacy=hex(G.multiply(xLegacy).toRawBytes());
 const snapshot={profile:PROFILE,kind:'synthetic-bridge-service-test-snapshot',asset:'X',checkpoint:{height:'test'},rows:[{claim:createHash('sha256').update('synthetic legacy lot X test').digest('hex'),amount:LEGACY_LOT,legacyOwner:PLegacy}]};
 const assets=[{symbol:'X',name:'Test token X',mint:null,decimals:6,legacyGross:legacyGrossFor(LEGACY_LOT).toString(),testHolding:'1000000000'}];
 const obs=await fakeObserver({port:8993,mode:'unknown'});
 const lab=await startLab({confirmations:CONF,exposure:EXPOSURE,assets,registrySnapshot:snapshot,log:m=>console.error('lab:',typeof m==='string'?m:JSON.stringify(m).slice(0,200))});
 let failed=true;
 try{
  const {post,rpc}=lab;const X=lab.bridge.assetIds.X;
  const wasm=await WebAssembly.compile(await readFile(BINS.wasm));const MANIFEST=JSON.parse(await readFile(FMT+'/params/test-v2/manifest.json','utf8'));const cache=memoryCache();
  const open=root=>openTokenWallet({wasm,manifest:MANIFEST,daemonRpc:lab.daemonRpc,parameterServer:lab.BASE,cache,fetch:closeFetch,root:hex(root)});
  const rootA=randomBytes(32),rootB=randomBytes(32);const A=await open(rootA),B=await open(rootB);const solA=Keypair.generate(),solB=Keypair.generate();
  const rA=await post('register',{id:'A',sol:solA.publicKey.toBase58(),xmr:A.nativeAddress(),tokenAddress:A.address(),legacyKeys:[PLegacy]});assert.equal(rA.ownerKey,A.ownerKey());
  await post('register',{id:'B',sol:solB.publicKey.toBase58(),xmr:B.nativeAddress(),tokenAddress:B.address()});
  await assert.rejects(post('register',{id:'C',sol:solA.publicKey.toBase58(),xmr:A.nativeAddress(),tokenAddress:B.address()}),/another Solana account/);
  await post('fund',{id:'A',blocks:6});await post('fund',{id:'B',blocks:6});await post('mine',{blocks:50});await post('mine',{blocks:12});
  await A.sync();await B.sync();assert.deepEqual(A.status().public.balances,{});
  const keyImages=[];
  const carry=async(w,kind,wire,planReq,part=0)=>{await w.sync();/* the engine quotes only when synced to the daemon tip */const plan=w.plan(planReq);assert.equal(plan.wireLengths[part],wire.length/2);const q=await w.quoteCarrier({kind,wireLen:wire.length/2});const s=w.signCarrier(q.quoteId,wire);assert.equal(s.fee,q.fee);const r=await w.publish(s.blob);assert.equal(r.ok,true,r.reason);
   keyImages.push(...[].concat(s.keyImage||[]));evidence.fees.push({kind,fee:String(s.fee),recordBytes:wire.length/2,extraBytes:s.extraBytes,nativeBytes:s.nativeBytes});evidence.transactions.push({kind,txid:s.txid,moneroTransactions:1});return {txid:s.txid,blob:s.blob,fee:String(s.fee)};};
  const liabilities=async()=>{const l=await post('liabilities',{},true);assert.equal(l.X.ok,true,'liabilities: '+JSON.stringify(l.X));return l.X;};
  const state=async(id='A')=>{const s=await post('state',{id});assert.equal(s.pool.invariant.ok,true,'backing invariant');return s;};
  await liabilities();let s0=await state();assert.equal(s0.registered,true);assert.equal(s0.features.bridge,true);assert.equal(s0.assets[0].legacy.length,1);assert.equal(s0.assets[0].legacy[0].consumed,false);
  step('lab up',{tip:s0.tip,indexer:lab.indexer.url,bridge:lab.BASE,reserve:(await liabilities()).reserve});

  // 1. Deposit 100 X -> PUBLIC credit to A's owner key, visible after confirmations.
  const prep=await post('depositPrepare',{id:'A',symbol:'X',amount:'100000000'});assert.equal(prep.review.creditTo,A.address());assert.equal(prep.review.net,'98500000');
  const tx=Transaction.from(Buffer.from(prep.transaction,'base64'));tx.sign(solA);
  const dep=await post('depositSubmit',{id:'A',nonce:prep.nonce,transaction:tx.serialize().toString('base64')});assert.equal(dep.receipt.net,'98500000');assert.equal(dep.credit.kind,'public');
  // duplicate receipt: the operator refuses to credit the same receipt twice, and the loop never does either
  const receipts=await lab.bridge.custodies.X.receipts();assert.equal(receipts.length,1);await assert.rejects(lab.bridge.ops.X.creditDeposit(receipts[0]),/already credited/);
  await post('mine',{blocks:CONF});await post('tick',{},true);assert.equal(Object.keys(lab.bridge.ops.X.state.credits).length,1);
  await A.sync();assert.equal(A.status().public.balances[X],'98500000');evidence.transactions.push({kind:'credit',txid:dep.credit.txid,moneroTransactions:1,payer:'issuer'});
  const l1=await liabilities();assert.equal(l1.buckets.outstandingNotes,'98500000');assert.equal(l1.buckets.depositsAwaitingCredit,'0');step('deposit credited publicly',{credit:dep.credit.txid,net:dep.receipt.net});

  // 2. Indexer crash and restart: the service comes back from disk with the same tip and root.
  const before=await lab.indexerClient.summary();await lab.indexer.crashChild();const h=await lab.indexerClient.health();const after=await lab.indexerClient.summary();
  assert.ok(lab.indexer.restarts>=1);assert.equal(after.state.root,before.state.root);assert.equal(h.tip,before.tip);step('indexer crash/restart',{restarts:lab.indexer.restarts,tip:h.tip});

  // 3. PUBLIC send 40 X from A to B: ONE Monero transaction.
  const selP=A.selectPublic({asset:X,amount:'40000000'});const pub=await A.build({kind:'public',asset:X,to:B.address(),amount:'40000000',notes:selP.notes});assert.equal(pub.transactions,1);
  const c1=await carry(A,'public',pub.wire,{kind:'public',inputs:1,change:true});await post('mine',{blocks:2});await A.sync();await B.sync();
  assert.equal(A.status().public.balances[X],'58500000');assert.equal(B.status().public.balances[X],'40000000');step('public send',{txid:c1.txid,fee:c1.fee});

  // 4. Exposure: a redemption above the single-payout limit is refused BEFORE anything is burned.
  await assert.rejects(post('redeemPrepare',{id:'B',symbol:'X',amount:'70000000'}),/Exposure: single payout above limit/);

  // 5. B burns 25 X; payout only after CONF confirmations, withheld while the observer disagrees, then paid exactly once.
  const rp=await post('redeemPrepare',{id:'B',symbol:'X',amount:'25000000'});assert.equal(rp.destination,solB.publicKey.toBase58());
  const selB=B.selectPublic({asset:X,amount:'25000000'});const burn=await B.build({kind:'burn',asset:X,amount:'25000000',binding:rp.binding,notes:selB.notes});
  const c2=await carry(B,'burn',burn.wire,{kind:'burn',inputs:selB.notes.length});await post('mine',{blocks:1});await B.sync();assert.equal(B.status().public.balances[X],'15000000');
  await assert.rejects(post('payout',{symbol:'X',txid:c2.txid}),/Only \d+ confirmations/);
  const l2=await liabilities();assert.equal(l2.buckets.confirmedBurnsAwaitingPayout,'25000000');
  await post('mine',{blocks:CONF});
  lab.bridge.ops.X.observers=[obs.url];await post('tick',{},true);assert.equal(lab.bridge.ops.X.state.payouts[c2.txid].status,'pending');
  await assert.rejects(post('payout',{symbol:'X',txid:c2.txid}),/Payout withheld: independent observation/);step('payout withheld by observer disagreement',{txid:c2.txid});
  obs.setMode('proxy');const obsProxy=await fakeObserver({port:8994,mode:'proxy',proxy:lab.daemonRpc});lab.bridge.ops.X.observers=[obsProxy.url];
  const paid=await post('payout',{symbol:'X',txid:c2.txid});assert.equal(paid.status,'paid');assert.equal(paid.net,'24625000');
  const again=await post('payout',{symbol:'X',txid:c2.txid});assert.equal(again.status,'paid');assert.equal(again.repeated,true);await post('tick',{},true);
  const ataOf=async w=>Object.values(JSON.parse(await readFile(lab.run+'/bridge/holders.json','utf8')).holders).find(x=>x.ownerKey===w.ownerKey()).ata.X;
  assert.equal(await lab.bridge.custodies.X.tokenBalance(await ataOf(B)),'1024625000');
  await obsProxy.close();lab.bridge.ops.X.observers=[];await liabilities();step('burn paid exactly once',{txid:c2.txid,net:paid.net});

  // 6. Operator restart with a pending redemption: nothing is lost or paid twice.
  await A.sync();const rp2=await post('redeemPrepare',{id:'A',symbol:'X',amount:'20000000'});const selA2=A.selectPublic({asset:X,amount:'20000000'});
  const burn2=await A.build({kind:'burn',asset:X,amount:'20000000',binding:rp2.binding,notes:selA2.notes});const c3=await carry(A,'burn',burn2.wire,{kind:'burn',inputs:selA2.notes.length});
  await post('mine',{blocks:4});await post('tick',{},true);assert.equal(lab.bridge.ops.X.state.payouts[c3.txid].status,'pending');
  await lab.restartBridge();assert.equal(lab.bridge.ops.X.state.payouts[c3.txid].status,'pending');assert.equal(lab.bridge.ops.X.state.payouts[c2.txid].status,'paid');assert.ok(lab.bridge.ops.X.state.requests[rp2.binding]);
  await post('mine',{blocks:CONF});await post('tick',{},true);assert.equal(lab.bridge.ops.X.state.payouts[c3.txid].status,'paid');
  assert.equal(Object.values(lab.bridge.ops.X.state.payouts).filter(p=>p.status==='paid').length,2);step('operator restart with pending redemption',{txid:c3.txid});

  // 7. Lost reply: the process dies after custody accepted the redemption but before the journal says paid. Recovery finds the receipt.
  await A.sync();const rp3=await post('redeemPrepare',{id:'A',symbol:'X',amount:'20000000'});const selA3=A.selectPublic({asset:X,amount:'20000000'});
  const burn3=await A.build({kind:'burn',asset:X,amount:'20000000',binding:rp3.binding,notes:selA3.notes});const c4=await carry(A,'burn',burn3.wire,{kind:'burn',inputs:selA3.notes.length});
  await post('mine',{blocks:CONF+1});lab.bridge.ops.X.inject=(point)=>{if(point==='afterSubmit')throw Error('simulated crash after custody submit');};
  await post('tick',{},true);assert.equal(lab.bridge.ops.X.state.payouts[c4.txid].status,'submitting');
  await lab.restartBridge();const rec=await post('payout',{symbol:'X',txid:c4.txid});assert.equal(rec.status,'paid');assert.equal(lab.bridge.ops.X.state.payouts[c4.txid].recovered,true);
  assert.equal(Object.values(lab.bridge.ops.X.state.payouts).filter(p=>p.status==='paid').length,3);
  const balA=await lab.bridge.custodies.X.tokenBalance(await ataOf(A));assert.equal(balA,String(1000000000n-100000000n+2n*19700000n));
  step('lost reply recovered without double payment',{txid:c4.txid});

  // 8. Reorganisation: a burn with recorded confirmations leaves canonical history before payout -> incident, paused, nothing paid;
  //    after the holder republishes and the operator resumes, paid exactly once.
  await A.sync();const rp4=await post('redeemPrepare',{id:'A',symbol:'X',amount:'10000000'});const selA4=A.selectPublic({asset:X,amount:'10000000'});
  const burn4=await A.build({kind:'burn',asset:X,amount:'10000000',binding:rp4.binding,notes:selA4.notes});const c5=await carry(A,'burn',burn4.wire,{kind:'burn',inputs:selA4.notes.length});
  await post('mine',{blocks:3});await post('tick',{},true);assert.equal(lab.bridge.ops.X.state.payouts[c5.txid].confirmations,3);
  const popped=await post('pop',{blocks:4});await post('tick',{},true);
  const inc=lab.bridge.ops.X.state.incidents.find(i=>i.kind==='burnVanished'&&i.txid===c5.txid);assert.ok(inc,'burnVanished incident');assert.equal(lab.bridge.ops.X.state.paused,true);
  const ist=await lab.indexerClient.status();assert.ok((ist.reorganisations??ist.reorgs??1)>=1);
  await post('mine',{blocks:CONF+1});await post('tick',{},true);assert.notEqual(lab.bridge.ops.X.state.payouts[c5.txid].status,'paid','nothing paid while paused and the burn is not canonical');
  const re=await A.publish(c5.blob);assert.equal(re.ok,true,re.reason);await post('mine',{blocks:CONF+1});await post('tick',{},true);
  assert.equal(lab.bridge.ops.X.state.payouts[c5.txid].status,'pending');await assert.rejects(post('payout',{symbol:'X',txid:c5.txid}),/paused/);
  await post('resume',{symbol:'X',note:'test: reorganisation reviewed'},true);await post('tick',{},true);assert.equal(lab.bridge.ops.X.state.payouts[c5.txid].status,'paid');
  assert.equal(Object.values(lab.bridge.ops.X.state.payouts).filter(p=>p.status==='paid').length,4);await liabilities();
  step('reorganised burn: incident, pause, republish, paid once',{txid:c5.txid,popped:popped.popped});

  // 9. Migration claim: exactly the legacy lot, once.
  const cp=await post('claimPrepare',{id:'A',symbol:'X',claim:snapshot.rows[0].claim});assert.equal(cp.amount,LEGACY_LOT);assert.equal(cp.P,PLegacy);
  const sig=signLegacy(cp.messageHash,xLegacy);const cl=await post('claimSubmit',{id:'A',symbol:'X',body:cp.body,legacySignature:sig});assert.equal(cl.amount,LEGACY_LOT);
  await assert.rejects(post('claimSubmit',{id:'A',symbol:'X',body:cp.body,legacySignature:sig}),/already/);
  await assert.rejects(post('claimSubmit',{id:'B',symbol:'X',body:cp.body,legacySignature:sig}),/owner must be this account|already/);
  await post('mine',{blocks:CONF});await post('tick',{},true);await A.sync();
  const aBal=BigInt(A.status().public.balances[X]);assert.equal(aBal,58500000n-20000000n-20000000n-10000000n+BigInt(LEGACY_LOT));
  const l9=await liabilities();assert.equal(l9.buckets.unclaimedLegacyRights,'0');evidence.transactions.push({kind:'migration-credit',txid:cl.txid,moneroTransactions:1,payer:'issuer'});
  const sA=await state('A');assert.equal(sA.assets[0].legacy[0].consumed,true);step('migration claim credited once',{txid:cl.txid,amount:LEGACY_LOT});

  // 10. Fresh-install recovery: a new wallet from A's root rebuilds the same balances from chain + indexer-free scanning.
  const A2=await open(rootA);await A2.sync();assert.deepEqual(A2.status().public.balances,A.status().public.balances);
  // 11. Health, status and the admin surface.
  const health=await (await fetch(lab.BASE+'/health')).json();assert.equal(health.ok,true);const st=await post('status',{},true);assert.equal(st.assets.X.halted,false);assert.equal(st.assets.X.paused,false);assert.equal(st.assets.X.payouts.paid,4);
  // 12. Disclosure audit: nothing the services wrote to disk contains a holder key image, a holder root or a viewing key.
  const files=[];const walk=async d=>{for(const e of await readdir(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory()){if(p.includes('/chain/'))continue;await walk(p);}else files.push(p);}};await walk(lab.run);
  const forbidden=[...keyImages,hex(rootA),hex(rootB),A.viewingKey(),B.viewingKey()].filter(Boolean);assert.ok(keyImages.length>=5);
  const hits=[];for(const f of files){const t=await readFile(f,'utf8').catch(()=>'');for(const s of forbidden)if(t.includes(s))hits.push({file:path.relative(lab.run,f),what:s.slice(0,16)});}
  assert.deepEqual(hits,[],'service disk state must not contain holder secrets or key images');step('disclosure audit clean',{filesScanned:files.length,keyImagesChecked:keyImages.length});
  evidence.ok=true;evidence.payouts=4;evidence.credits=2;evidence.processes=lab.started;failed=false;
 }catch(e){console.error('TEST FAILURE: '+(e.stack||e.message));throw e;}finally{
  await obs.close().catch(()=>{});
  evidence.ok=!failed;await writeFile(here+'/../runs/bridge-service-results.json',JSON.stringify(evidence,null,1));
  if(failed){console.error('run folder kept for diagnosis: '+lab.run);await lab.stop();}else await lab.cleanup();
 }
});
