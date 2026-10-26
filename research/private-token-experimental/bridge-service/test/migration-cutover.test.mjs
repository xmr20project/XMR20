// MIGRATION CUTOVER REHEARSAL (address-based entitlements, XMR20-CUTOVER-SNAPSHOT-2) on the fakechain lab with the real holder
// engine: a snapshot built by migration/holders-snapshot.mjs from a holders document in the PRODUCTION shape (xmr20-holders-v1)
// for two synthetic holders (their Monero addresses come from wallet-lib wallets, whose spend key is the wallet root);
// the bridge service loads it as the asset's registry; each holder claims by signing under its address's spend key; the credit
// is a PUBLIC note of exactly the legacy amount; a second claim, a claim by another account, and a tampered amount are refused;
// liabilities balance before and after. SIMULATED; synthetic keys only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {keccak_256} from '@noble/hashes/sha3';
import {startLab,BINS,FMT,here} from './harness.mjs';
import {openTokenWallet,memoryCache} from '../../token-format-unshielded-fix-20261026/wallet-lib/token-wallet.mjs';
import {legacyGrossFor} from '../../token-format-unshielded-fix-20261026/backend/service.mjs';
import {buildSnapshot} from '../../token-format-unshielded-fix-20261026/migration/holders-snapshot.mjs';
import {decodeMoneroAddress,encodeMoneroAddress} from '../../token-format-unshielded-fix-20261026/backend/monero-address.mjs';
import {ORDER} from '../../../website/services/native-market/xn1/proofs.mjs';
import {le} from '../../../website/services/native-market/xn1/bytes.mjs';
const hex=b=>Buffer.from(b).toString('hex');const G=ed25519.ExtendedPoint.BASE;const Hs=b=>le(keccak_256(b))%ORDER;
const uint=(n,len)=>{const b=Buffer.alloc(len);let x=BigInt(n);for(let i=0;i<len;i++){b[i]=Number(x&0xffn);x>>=8n;}return b;};
const scalar=()=>{let k;do{k=le(randomBytes(64))%ORDER;}while(!k);return k;};
// the same plain Schnorr signature the registry verifies: c = Hs(msg || P || R), r = k - c*x
function signWith(messageHash,x){const P=G.multiply(x).toRawBytes();let nonce,c,r;do{nonce=scalar();const R=G.multiply(nonce).toRawBytes();c=Hs(Buffer.concat([Buffer.from(messageHash,'hex'),Buffer.from(P),Buffer.from(R)]));r=((nonce-c*x)%ORDER+ORDER)%ORDER;}while(!c||!r);return Buffer.concat([uint(c,32),uint(r,32)]).toString('hex');}
const closeFetch=(u,o={})=>fetch(u,{...o,headers:{...(o.headers||{}),connection:'close'}});
const MANIFEST=JSON.parse(await readFile(FMT+'/params/test-v2/manifest.json','utf8'));
const legacyKeys=()=>({A:hex(G.multiply(scalar()).toRawBytes()),B:hex(G.multiply(scalar()).toRawBytes())});

test('cutover rehearsal: address-based snapshot -> registry -> signed claims -> exact public credits; refusals; liabilities',{timeout:900000},async()=>{
 await mkdir(here+'/../runs',{recursive:true});
 const wasm=await WebAssembly.compile(await readFile(BINS.wasm));const cache=memoryCache();
 // holders: wallets whose Monero spend key is the root (reduced mod l) — as the holder engine derives it
 const rootA=randomBytes(32),rootB=randomBytes(32),rootC=randomBytes(32);
 const bOf=root=>le(root)%ORDER;
 const MINT='TESTMINTADDRESS1111111111111111111111111111';const AMOUNT_A='10000000000',AMOUNT_B='2500000000';
 let lab=null;
 try{
  // the snapshot needs the holders' addresses: open the wallets against a throwaway lab-less daemon? No — addresses come from the engine, which
  // needs no daemon to derive; use a temporary engine via openTokenWallet with a dummy RPC (never contacted before sync)
  // addresses computed from the Monero key schedule the engine uses (spend b = root mod l, view a = keccak(root) mod l); the
  // engine's own nativeAddress() is compared with them once the lab is up (the engine needs the parameter server to open)
  const aOf=root=>le(keccak_256(root))%ORDER;
  const addrOf=root=>encodeMoneroAddress({spendPublicKey:hex(G.multiply(bOf(root)).toRawBytes()),viewPublicKey:hex(G.multiply(aOf(root)).toRawBytes())});
  const addrA=addrOf(rootA),addrB=addrOf(rootB);
  for(const [addr,root] of [[addrA,rootA],[addrB,rootB]]){const d=decodeMoneroAddress(addr);assert.equal(d.spendPublicKey,hex(G.multiply(bOf(root)).toRawBytes()));}
  // production-shaped documents
  const tokens=[{id:'11111111-1111-1111-1111-111111111111',mint:MINT,ticker:'X',name:'Test token X',xmrOutstanding:String(BigInt(AMOUNT_A)+BigInt(AMOUNT_B))}];
  const holders={[MINT]:{schema:'xmr20-holders-v1',id:tokens[0].id,mint:MINT,moneroNetwork:'mainnet',solanaNetwork:'mainnet-beta',state:'verified',checkedAt:1793000000000,decimals:6,moneroHeight:3792000,moneroConfirmations:10,moneroRaw:String(BigInt(AMOUNT_A)+BigInt(AMOUNT_B)),
   holders:[{address:addrA,amountRaw:AMOUNT_A,network:'monero',kind:'XMR20 address'},{address:addrB,amountRaw:AMOUNT_B,network:'monero',kind:'XMR20 address'},{address:Keypair.generate().publicKey.toBase58(),amountRaw:'1',network:'solana'}]}};
  const snapshot=buildSnapshot({tokens,holdersByMint:holders,takenAt:'2026-10-26T00:00:00.000Z',source:{api:'fixture'}});
  assert.equal(snapshot.summary.holders,2);assert.equal(snapshot.problems.length,0);const reg=snapshot.assets[0];assert.equal(reg.total,String(BigInt(AMOUNT_A)+BigInt(AMOUNT_B)));
  const again=buildSnapshot({tokens,holdersByMint:holders,takenAt:'2026-10-26T01:00:00.000Z',source:{api:'fixture'}});assert.equal(again.digest,snapshot.digest,'digest depends on rows and checkpoint only');
  const assets=[{symbol:'X',name:'Test token X',mint:null,decimals:6,legacyGross:legacyGrossFor(reg.total).toString(),testHolding:'1000000000'}];
  lab=await startLab({confirmations:10,assets,registrySnapshots:{X:reg},log:()=>{},name:'cutover'});
  const {post}=lab;const X=lab.bridge.assetIds.X;
  const open=root=>openTokenWallet({wasm,manifest:MANIFEST,daemonRpc:lab.daemonRpc,parameterServer:lab.BASE,cache,fetch:closeFetch,root:hex(root)});
  const A=await open(rootA),B=await open(rootB),C=await open(rootC);
  assert.equal(A.nativeAddress(),addrA,'engine address equals the computed address (codec + key schedule agree)');assert.equal(B.nativeAddress(),addrB);
  for(const [id,w] of [['A',A],['B',B],['C',C]]){const k=legacyKeys();const r=await post('register',{id,sol:Keypair.generate().publicKey.toBase58(),xmr:w.nativeAddress(),A:k.A,B:k.B,tokenAddress:w.address()});assert.equal(r.registered,true);}
  await post('mine',{blocks:12});
  const liabilities=async()=>{const l=await post('liabilities',{},true);assert.equal(l.X.ok,true,JSON.stringify(l.X));return l.X;};
  const l0=await liabilities();assert.equal(l0.buckets.unclaimedLegacyRights,reg.total);
  // the service shows each holder exactly its own row (matched by Monero address)
  const sA=await post('state',{id:'A'});assert.equal(sA.assets[0].legacy.length,1);assert.equal(sA.assets[0].legacy[0].amount,AMOUNT_A);assert.equal(sA.assets[0].legacy[0].address,addrA);
  const sC=await post('state',{id:'C'});assert.equal(sC.assets[0].legacy.length,0);
  // A claims: prepare -> sign under the address spend key -> submit -> credit
  const cp=await post('claimPrepare',{id:'A',symbol:'X',claim:sA.assets[0].legacy[0].claim});assert.equal(cp.signWith,'address-spend-key');assert.equal(cp.legacyOwner,decodeMoneroAddress(addrA).spendPublicKey);
  const sig=signWith(cp.messageHash,bOf(rootA));const cl=await post('claimSubmit',{id:'A',symbol:'X',body:cp.body,legacySignature:sig});assert.equal(cl.amount,AMOUNT_A);
  await post('mine',{blocks:10});await post('tick',{},true);await A.sync();assert.equal(A.status().public.balances[X],AMOUNT_A,'exactly the legacy amount, no fee');
  // refusals: duplicate, another account, tampered amount, wrong key
  await assert.rejects(post('claimSubmit',{id:'A',symbol:'X',body:cp.body,legacySignature:sig}),/already/);
  await assert.rejects(post('claimPrepare',{id:'C',symbol:'X',claim:cp.body.claim}),/another Monero address/);
  const cpB=await post('claimPrepare',{id:'B',symbol:'X',claim:(await post('state',{id:'B'})).assets[0].legacy[0].claim});
  await assert.rejects(post('claimSubmit',{id:'B',symbol:'X',body:{...cpB.body,amount:'9999999999'},legacySignature:signWith(cpB.messageHash,bOf(rootB))}),/amount|signature|rejected/i);
  await assert.rejects(post('claimSubmit',{id:'B',symbol:'X',body:cpB.body,legacySignature:signWith(cpB.messageHash,bOf(rootC))}),/signature/i);
  // B claims correctly
  const clB=await post('claimSubmit',{id:'B',symbol:'X',body:cpB.body,legacySignature:signWith(cpB.messageHash,bOf(rootB))});assert.equal(clB.amount,AMOUNT_B);
  await post('mine',{blocks:10});await post('tick',{},true);await B.sync();assert.equal(B.status().public.balances[X],AMOUNT_B);
  const l1=await liabilities();assert.equal(l1.buckets.unclaimedLegacyRights,'0');assert.equal(l1.buckets.outstandingNotes,String(BigInt(AMOUNT_A)+BigInt(AMOUNT_B)));
  // migrated tokens are ordinary public notes: A sends 1,000 X to C in one transaction (A needs test XMR for the carrier fee)
  await post('fund',{id:'A',blocks:3});await post('mine',{blocks:50});await post('mine',{blocks:12});await A.sync();const sel=A.selectPublic({asset:X,amount:'1000000000'});const pub=await A.build({kind:'public',asset:X,to:C.address(),amount:'1000000000',notes:sel.notes});
  const q=await A.quoteCarrier({kind:'public',wireLen:pub.wire.length/2});const s=A.signCarrier(q.quoteId,pub.wire);const r=await A.publish(s.blob);assert.equal(r.ok,true,r.reason);
  await post('mine',{blocks:2});await C.sync();assert.equal(C.status().public.balances[X],'1000000000');
  const evidence={ok:true,execution:'SIMULATED (fakechain lab, real holder engine, address-based snapshot)',snapshotDigest:snapshot.digest,registryId:lab.bridge.ops.X.registry.id,claims:[{txid:cl.txid,amount:AMOUNT_A},{txid:clB.txid,amount:AMOUNT_B}],liabilitiesAfter:l1};
  await writeFile(here+'/../runs/migration-cutover-results.json',JSON.stringify(evidence,null,1));console.error(JSON.stringify(evidence).slice(0,400));
  A.close();B.close();C.close();
 }finally{if(lab)await lab.cleanup();}
});
