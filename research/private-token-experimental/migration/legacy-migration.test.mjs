// LEGACY MIGRATION OF A THIRD-PARTY XMR20 TOKEN ALREADY HELD ON MONERO — acceptance case (SYNTHETIC balances, offline fakechain,
// compiled Solana custody in LiteSVM with a stand-in mint for EXTREMIST):
//   a holder has 10,000 EXTREMIST in the legacy format and upgrades to EXACTLY 10,000 private EXTREMIST — same asset/mint/decimals,
//   backing preserved (reserve unchanged, rights bucket -> private-notes bucket), no round trip through Solana, no deposit fee,
//   no second bridge tax; the credit carrier's XMR fee is paid by the lab issuer and disclosed separately.
// Then: interrupted migration (operator crash after the credit is built, before publication) recovers without a second credit;
// duplicate claims refused (same installation and a fresh installation of the same phrase); cutoff ownership change (a different
// key cannot claim; a lot not in the cutover snapshot is unknown); wallet recovery from the phrase; no double redemption through
// the old path after cutover (legacy position moved to the private reserve once; a second migration is refused); then a private
// transfer of migrated EXTREMIST and a redemption back to the SAME Solana asset (payout on the EXTREMIST mint, not the XMR20 mint).
// The real EXTREMIST mint/decimals are recorded from the native-market configuration (migration/third-party-assets.json) and
// compared for decimals only; the VM mint here is a stand-in. Nothing touches real holdings.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Keypair,PublicKey,Transaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {keccak_256} from '@noble/hashes/sha3';
import {getAssociatedTokenAddressSync,TOKEN_2022_PROGRAM_ID as TOKEN} from '@solana/spl-token';
import {startBackend} from '../backend/service.mjs';
import {createHolderEngine,createChainScanner} from '../wallet-extension/src/holder-engine.js';
import {createParameterLoader} from '../wallet-extension/src/holder-params.js';
import {createCarrierBuilder} from '../wallet-extension/src/holder-carrier.js';
import {ORDER} from '../website/services/native-market/xn1/proofs.mjs';
import {le} from '../website/services/native-market/xn1/bytes.mjs';
const dir=fileURLToPath(new URL('../',import.meta.url));
const PORTS={rpcPort:30087,p2pPort:30086,httpPort:8955};const BASE=`http://127.0.0.1:${PORTS.httpPort}`;
const hex=b=>Buffer.from(b).toString('hex');const closeFetch=(u,o={})=>fetch(u,{...o,headers:{...(o.headers||{}),connection:'close'}});
const post=async(action,body)=>{const r=await closeFetch(`${BASE}/action/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
const MANIFEST=JSON.parse(await readFile(dir+'params/test-v1/manifest.json','utf8'));
const cache=(()=>{const m=new Map();return {get:async k=>m.get(k)||null,put:async(k,v)=>{m.set(k,v);},delete:async k=>{m.delete(k);}};})();
// Legacy one-time keys exactly as the shipping format derives them: P = Hs(8 r A || i) G + B; the holder's private x = Hs(8 a R || i) + b.
const G=ed25519.ExtendedPoint.BASE;const Hs=b=>le(keccak_256(b))%ORDER;const varint=n=>{const out=[];let x=BigInt(n);while(x>=0x80n){out.push(Number(x&0x7fn)|0x80);x>>=7n;}out.push(Number(x));return Buffer.from(out);};
const uint=(n,len)=>{const b=Buffer.alloc(len);let x=BigInt(n);for(let i=0;i<len;i++){b[i]=Number(x&0xffn);x>>=8n;}return b;};
const scalar=()=>{let k;do{k=le(randomBytes(64))%ORDER;}while(!k);return k;};
function legacyKeys(){const a=scalar(),b=scalar();return {a,b,A:hex(G.multiply(a).toRawBytes()),B:hex(G.multiply(b).toRawBytes())};}
function legacyPrivate(keys,R,index){const D=ed25519.ExtendedPoint.fromHex(R,false).multiply(8n).multiply(keys.a).toRawBytes();return (Hs(Buffer.concat([Buffer.from(D),varint(index)]))+keys.b)%ORDER;}
// Schnorr-style legacy authorization matching verifyLegacyAuthorization: c = Hs(msg || P || R), r = nonce - c x.
function signLegacy(messageHash,x){const P=G.multiply(x).toRawBytes();let nonce,c,r;do{nonce=scalar();const R=G.multiply(nonce).toRawBytes();c=Hs(Buffer.concat([Buffer.from(messageHash,'hex'),Buffer.from(P),Buffer.from(R)]));r=((nonce-c*x)%ORDER+ORDER)%ORDER;}while(!c||!r);return Buffer.concat([uint(c,32),uint(r,32)]).toString('hex');}
test('10,000 legacy EXTREMIST -> exactly 10,000 private EXTREMIST; interrupted/duplicate/cutoff/recovery; transfer; redemption to the same mint',{timeout:1800000},async()=>{
 const wasm=await WebAssembly.compile(await readFile(dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm'));
 const backend=await startBackend({...PORTS,log:m=>console.error('backend:',m),origins:[]});const rpc=backend.rpcUrl;
 const ev={execution:'SIMULATED (offline fakechain, LiteSVM custody, synthetic EXTREMIST mint stand-in)',steps:[]};const step=(name,x={})=>{ev.steps.push({at:new Date().toISOString(),name,...x});console.error(JSON.stringify({step:name,...x}).slice(0,300));};
 async function open(root){const engine=await createHolderEngine({wasm});const d=engine.call({op:'derive',root:hex(root),account:0});const loader=createParameterLoader({fetch:closeFetch,manifest:MANIFEST,engine,baseUrl:BASE,cache});engine.call({op:'params',manifest:MANIFEST,served:await loader.loadServedConfig()});
  const scanner=createChainScanner(engine,{rpc,fetch:closeFetch,genesis:MANIFEST.network.genesis});const carrier=createCarrierBuilder({engine,rpc,fetch:closeFetch});return {engine,loader,scanner,carrier,tokenAddress:d.tokenAddress,nativeAddress:d.nativeAddress};}
 const status=e=>e.engine.call({op:'status'});
 try{
  const catalog=JSON.parse(await readFile(dir+'migration/third-party-assets.json','utf8'));const real=catalog.assets.find(a=>(a.key||a.symbol)==='EXTREMIST');
  // 0. EVERY catalog token (all XMR20 launches in the snapshot) maps to a unique asset id by the same rule; nothing is per-symbol.
  const ids=new Map();for(const c of catalog.assets){const id=(await backend.indexer.call({op:'asset',denom:'uxmr20private'+c.mint.toLowerCase().replace(/[^a-z0-9]/g,'')})).asset;assert.ok(!ids.has(id),'duplicate asset id');ids.set(id,c.symbol);}
  assert.equal(ids.size,catalog.assets.length);step('catalog: every launched token has a unique derived asset id',{tokens:catalog.assets.length,instantiatedNow:catalog.testInstances,future:catalog.futureTokenForTest});
  const rootH=randomBytes(32),rootK=randomBytes(32);const H=await open(rootH),K=await open(rootK);const kH=legacyKeys(),kK=legacyKeys();const solH=Keypair.generate(),solK=Keypair.generate();
  const regH=await post('register',{id:'H',sol:solH.publicKey.toBase58(),xmr:H.nativeAddress,A:kH.A,B:kH.B,tokenAddress:H.tokenAddress});const regK=await post('register',{id:'K',sol:solK.publicKey.toBase58(),xmr:K.nativeAddress,A:kK.A,B:kK.B,tokenAddress:K.tokenAddress});
  for(const sym of catalog.testInstances){assert.equal(regH.legacyLots[sym],'10000000000','lot for '+sym);assert.equal(regK.legacyLots[sym],'10000000000');}
  await post('fund',{id:'H',blocks:2});await post('mine',{blocks:50});await post('mine',{blocks:20});
  const st0=await post('state',{id:'H'});const E0=st0.assets.find(a=>a.symbol==='EXTREMIST');const X0=st0.assets.find(a=>a.symbol==='X');
  assert.equal(E0.decimals,real.decimals,'synthetic custody mint carries the catalog decimals');assert.equal(E0.mint,real.mint,'custody state lives at the REAL EXTREMIST mint address (synthetic data)');assert.notEqual(E0.mint,X0.mint,'distinct from the XMR20 mint');
  const lot=E0.legacy.find(l=>!l.claimed);assert.equal(lot.amount,'10000000000','10,000 EXTREMIST at 6 decimals');assert.equal(BigInt(lot.amount),10000n*10n**BigInt(E0.decimals));
  step('legacy position visible',{asset:E0.asset,mintStandIn:E0.mint,realMint:real.mint,decimals:E0.decimals,lot:lot.amount});
  // 1. CLAIM: prepare (body bound to this holder's private address) -> sign with the legacy one-time key -> submit -> credit.
  const prep=await post('claimPrepare',{id:'H',claim:lot.claim,symbol:'EXTREMIST'});assert.equal(prep.body.owner,H.tokenAddress);assert.equal(prep.amount,lot.amount);assert.equal(prep.P,lot.P);
  const x=legacyPrivate(kH,prep.txPublicKey,prep.outputIndex);assert.equal(hex(G.multiply(x).toRawBytes()),lot.P,'derived legacy key matches the lot');
  const sig=signLegacy(prep.messageHash,x);
  const E_before=(await post('state',{id:'H'})).assets.find(a=>a.symbol==='EXTREMIST');const lb=E_before.liabilities;assert.equal(lb.ok,true);
  // Interrupted migration: the operator crashes AFTER the credit is built and journaled but BEFORE it is published.
  const op=backend.assets.EXTREMIST.operator;const origPublish=op.publishCredit.bind(op);let crashed=false;op.publishCredit=async()=>{crashed=true;throw Error('SIMULATED CRASH after the credit was journaled (built), before publication');};
  await assert.rejects(post('claimSubmit',{id:'H',symbol:'EXTREMIST',body:prep.body,legacySignature:sig}),/SIMULATED CRASH/);assert.equal(crashed,true);op.publishCredit=origPublish;
  const journaled=op.state.credits[lot.claim];assert.ok(journaled&&journaled.status==='built','credit journaled as built');assert.ok(op.registry.consumedIds().includes(lot.claim),'registry row consumed exactly once at build');
  // Recovery: a second submit must NOT build a second credit; the operator retries the journaled one (same txid).
  await assert.rejects(post('claimSubmit',{id:'H',symbol:'EXTREMIST',body:prep.body,legacySignature:sig}),/already credited|already/i,'duplicate submit refused by the journal');
  const scan=await backend.indexer.call({op:'scan'});const retry=await op.retryCredit(lot.claim,scan);assert.equal(retry.txid,journaled.txid,'the SAME credit was published, not a new one');
  await post('mine',{blocks:10});await H.scanner.sync();await K.scanner.sync();
  const E=backend.assets.EXTREMIST.asset;assert.equal(status(H).balances[E],'10000000000','EXACTLY 10,000 private EXTREMIST');assert.equal(status(H).notes.filter(n=>n.asset===E).length,1,'one note');
  const st1=await post('state',{id:'H'});const E1=st1.assets.find(a=>a.symbol==='EXTREMIST');const la=E1.liabilities;
  assert.equal(la.ok,true,'backing invariant holds after migration');assert.equal(la.reserve,lb.reserve,'reserve unchanged: no deposit, no round trip');
  assert.equal(BigInt(lb.buckets.unclaimedLegacyRights)-BigInt(la.buckets.unclaimedLegacyRights),10000000000n,'rights bucket fell by the lot');assert.equal(BigInt(la.buckets.outstandingPrivateNotes)-BigInt(lb.buckets.outstandingPrivateNotes),10000000000n,'private notes rose by the lot: no tax');
  assert.equal(E1.legacy.find(l=>l.claim===lot.claim).claimed,true);
  const creditTx=await (await closeFetch(rpc+'/get_transactions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({txs_hashes:[journaled.txid],decode_as_json:true})})).json();const creditFee=(()=>{try{return JSON.parse(creditTx.txs[0].as_json).rct_signatures.txnFee;}catch{return null;}})();
  step('migrated',{credit:journaled.txid,balance:status(H).balances[E],backing:la,issuerPaidCarrierFeePiconero:creditFee,holderPaidXmr:'0',interruptedThenRecovered:true});
  // 2. DUPLICATES: same claim again (this installation), and from a FRESH installation of the same phrase -> refused; lot shows claimed.
  await assert.rejects(post('claimSubmit',{id:'H',symbol:'EXTREMIST',body:prep.body,legacySignature:sig}),/already/i);
  const H2=await open(rootH);await post('register',{id:'H2',sol:solH.publicKey.toBase58(),xmr:H2.nativeAddress,A:kH.A,B:kH.B,tokenAddress:H2.tokenAddress});await H2.scanner.sync();
  assert.equal(status(H2).balances[E],'10000000000','fresh installation from the phrase sees the migrated 10,000');
  const st2=await post('state',{id:'H2'});assert.equal(st2.assets.find(a=>a.symbol==='EXTREMIST').legacy.find(l=>l.claim===lot.claim).claimed,true,'second installation sees the lot as claimed');
  await assert.rejects(post('claimSubmit',{id:'H2',symbol:'EXTREMIST',body:prep.body,legacySignature:sig}),/already/i,'fresh installation cannot claim again');
  // 3. CUTOFF OWNERSHIP: K's lot signed by someone else's key is refused; a lot id not in the cutover snapshot is unknown; a late
  //    registrant (after the snapshot) gets no EXTREMIST lot at all.
  const lotK=(await post('state',{id:'K'})).assets.find(a=>a.symbol==='EXTREMIST').legacy[0];const prepK=await post('claimPrepare',{id:'K',claim:lotK.claim,symbol:'EXTREMIST'});
  const wrongX=legacyPrivate(kH,prepK.txPublicKey,prepK.outputIndex);await assert.rejects(post('claimSubmit',{id:'K',symbol:'EXTREMIST',body:prepK.body,legacySignature:signLegacy(prepK.messageHash,wrongX)}),/signature rejected|authorization invalid|invalid/i,'another key cannot claim K’s lot');
  await assert.rejects(post('claimPrepare',{id:'K',claim:createHash('sha256').update('moved after cutoff').digest('hex'),symbol:'EXTREMIST'}),/Unknown legacy lot/,'a lot moved after the cutoff is not in the snapshot');
  const L=await open(randomBytes(32));const kL=legacyKeys();const regL=await post('register',{id:'L',sol:Keypair.generate().publicKey.toBase58(),xmr:L.nativeAddress,A:kL.A,B:kL.B,tokenAddress:L.tokenAddress});assert.equal(regL.legacyLots.EXTREMIST,'0','late registration after the cutover snapshot: no lot');assert.equal(regL.lateRegistration,true);
  // Old path closed: the legacy position was moved to the private reserve ONCE at cutover; a second migration is refused.
  assert.equal(E1.cutover.legacyPositionAfter,'0','legacy on-chain position is zero after cutover (no old-path redemption possible)');const br=backend.assets.EXTREMIST.bridge;const sBefore=br.state();let m2=null;try{m2=br.migrateLegacy();}catch(e){m2={ok:false,error:String(e.message).slice(0,120)};}const sAfter=br.state();assert.equal(sAfter.reserve,sBefore.reserve,'a second cutover migration does not change the reserve');assert.equal(sAfter.legacyPosition,'0','legacy position stays zero: no old-path issuance');ev.secondMigrationAttempt={ok:m2?.ok??null,error:m2?.error??null,reserveBefore:sBefore.reserve,reserveAfter:sAfter.reserve};
  step('duplicates, cutoff ownership, late registration, old path closed',{lateRegistrant:regL.legacyLots,cutover:E1.cutover});
  // 4. PRIVATE TRANSFER of migrated EXTREMIST: H -> K 2,500 (change 7,500 exact), carrier paid by H's XMR.
  await H.loader.loadProvingKey(0);const q=await H.carrier.quote({kind:'send'});const sel=H.engine.call({op:'select',asset:E,amount:'2500000000',exclude:[]});const built=H.engine.call({op:'build',kind:'send',to:K.tokenAddress,amount:'2500000000',notes:sel.notes});const s=H.carrier.sign(q.quoteId,built.wire);assert.equal((await H.carrier.publish(s.blob)).ok,true);
  await post('mine',{blocks:10});await H.scanner.sync();await K.scanner.sync();assert.equal(status(K).balances[E],'2500000000');assert.equal(status(H).balances[E],'7500000000');assert.equal(built.change,'7500000000');
  step('private transfer of migrated tokens',{txid:s.txid,feePiconero:String(s.fee),change:built.change});
  // 5. REDEMPTION back to the SAME Solana asset: H burns 100 EXTREMIST -> payout on the EXTREMIST mint to H's Solana address.
  const ata=getAssociatedTokenAddressSync(new PublicKey(E1.mint),solH.publicKey,false,TOKEN);const bridge=backend.assets.EXTREMIST.bridge;const solBefore=BigInt(bridge.tokenBalance(ata));const xmr20Before=BigInt(backend.assets.X.bridge.tokenBalance(getAssociatedTokenAddressSync(new PublicKey(X0.mint),solH.publicKey,false,TOKEN)));
  await H.loader.loadProvingKey(1);const rp=await post('redeemPrepare',{id:'H',symbol:'EXTREMIST'});assert.equal(rp.destination,solH.publicKey.toBase58());const q2=await H.carrier.quote({kind:'redeem'});const sel2=H.engine.call({op:'select',asset:E,amount:'100000000',exclude:[]});const b2=H.engine.call({op:'build',kind:'redeem',amount:'100000000',binding:rp.binding,notes:sel2.notes});/* 100 EXTREMIST: the lab operator's single-payout exposure limit is 100 units (a control kept intact, not raised) */const burn=H.carrier.sign(q2.quoteId,b2.wire);assert.equal((await H.carrier.publish(burn.blob)).ok,true);
  await post('mine',{blocks:10});await H.scanner.sync();const paid=await post('payout',{symbol:'EXTREMIST',txid:burn.txid});assert.equal(paid.status,'paid');
  const solAfter=BigInt(bridge.tokenBalance(ata));assert.equal(solAfter-solBefore,BigInt(paid.net),'payout landed on the EXTREMIST mint');assert.equal(E1.feeBps,real.mintAccount.onChainTransferFeeBps||0,'custody fee policy = the token’s on-chain transfer-fee setting');assert.equal(paid.feeBps,E1.feeBps);assert.equal(paid.net,E1.feeBps===0?'100000000':String(100000000n-(100000000n*BigInt(E1.feeBps)+9999n)/10000n),'redemption net follows EXTREMIST’s actual fee policy ('+E1.feeBps+' bps)');
  assert.equal(BigInt(backend.assets.X.bridge.tokenBalance(getAssociatedTokenAddressSync(new PublicKey(X0.mint),solH.publicKey,false,TOKEN))),xmr20Before,'XMR20 mint untouched');
  assert.equal(status(H).balances[E],'7400000000','7,500 - 100 redeemed, change exact');const lf=(await post('state',{id:'H'})).assets.find(a=>a.symbol==='EXTREMIST').liabilities;assert.equal(lf.ok,true,'backing holds after redemption');
  step('redeemed to the same Solana asset',{burn:burn.txid,net:paid.net,feeBps:paid.feeBps,mint:E1.mint,backing:lf});
  {const dp=await post('depositPrepare',{id:'H',symbol:'EXTREMIST',amount:'50000000'});assert.equal(dp.review.feeBps,E1.feeBps);const expect=E1.feeBps===0?'50000000':String(50000000n-(50000000n*BigInt(E1.feeBps)+9999n)/10000n);assert.equal(dp.review.net,expect);
   const dtx=Transaction.from(Buffer.from(dp.transaction,'base64'));dtx.sign(solH);const ds=await post('depositSubmit',{id:'H',nonce:dp.nonce,transaction:dtx.serialize().toString('base64')});assert.equal(ds.receipt.net,expect,'deposit credited per EXTREMIST policy');
   await post('mine',{blocks:10});await H.scanner.sync();assert.equal(status(H).balances[E],(7400000000n+BigInt(expect)).toString());const lf2=(await post('state',{id:'H'})).assets.find(a=>a.symbol==='EXTREMIST').liabilities;assert.equal(lf2.ok,true);
   step('deposit per EXTREMIST fee policy',{gross:'50000000',net:ds.receipt.net,feeBps:E1.feeBps,backing:lf2.ok});}
  // 6. THE SAME PATH FOR EVERY OTHER CATALOG TOKEN instantiated here, and for a token added AFTER startup (future launch).
  const migrate=async(sym,who,root,keys)=>{// who: 'H' (solH) or 'K' (solK)
const st=await post('state',{id:who});const row=st.assets.find(a=>a.symbol===sym);assert.ok(row,'asset '+sym);const l=row.legacy.find(x=>!x.claimed);assert.ok(l,'lot for '+sym);
   const c=catalog.assets.find(a=>(a.key||a.symbol)===sym);assert.equal(row.mint,c.mint,'custody at the real mint');assert.equal(row.decimals,c.decimals);assert.equal(BigInt(l.amount),10000n*10n**BigInt(c.decimals));
   const pr=await post('claimPrepare',{id:who,claim:l.claim,symbol:sym});const xx=legacyPrivate(keys,pr.txPublicKey,pr.outputIndex);const before=(await post('state',{id:who})).assets.find(a=>a.symbol===sym).liabilities;assert.equal(before.ok,true,sym+': backing holds at cutover');
   const sub=await post('claimSubmit',{id:who,symbol:sym,body:pr.body,legacySignature:signLegacy(pr.messageHash,xx)});await post('mine',{blocks:10});
   const w=await open(root);await w.scanner.sync();assert.equal(status(w).balances[row.asset],l.amount,sym+': exactly the lot, no tax');
   const after=(await post('state',{id:who})).assets.find(a=>a.symbol===sym).liabilities;assert.equal(after.ok,true);assert.equal(after.reserve,before.reserve,sym+': reserve unchanged');
   await assert.rejects(post('claimSubmit',{id:who,symbol:sym,body:pr.body,legacySignature:signLegacy(pr.messageHash,xx)}),/already/i,sym+': duplicate refused');
   // Fee policy of THIS token for later bridge operations: deposit 50 units and redeem 20 units; exact net per the mint's own
   // transfer-fee setting (150 bps or 0), backing invariant holds after each.
   const bps=row.feeBps;const feeOf=n=>(BigInt(n)*BigInt(bps)+9999n)/10000n;const netOf=n=>BigInt(n)-feeOf(n);const unit=10n**BigInt(c.decimals);
   const solKey=who==='K'?solK:solH;const dp=await post('depositPrepare',{id:who,symbol:sym,amount:(50n*unit).toString()});assert.equal(dp.review.feeBps,bps);assert.equal(dp.review.net,netOf(50n*unit).toString(),sym+': deposit net per policy');
   const dtx=Transaction.from(Buffer.from(dp.transaction,'base64'));dtx.sign(solKey);const ds=await post('depositSubmit',{id:who,nonce:dp.nonce,transaction:dtx.serialize().toString('base64')});assert.equal(ds.receipt.net,netOf(50n*unit).toString());
   await post('mine',{blocks:10});await w.scanner.sync();assert.equal(status(w).balances[row.asset],(BigInt(l.amount)+netOf(50n*unit)).toString(),sym+': lot + deposit net, exact');
   await w.loader.loadProvingKey(1);const rp=await post('redeemPrepare',{id:who,symbol:sym});const q=await w.carrier.quote({kind:'redeem'});const sel=w.engine.call({op:'select',asset:row.asset,amount:(20n*unit).toString(),exclude:[]});const b=w.engine.call({op:'build',kind:'redeem',amount:(20n*unit).toString(),binding:rp.binding,notes:sel.notes});const burn=w.carrier.sign(q.quoteId,b.wire);assert.equal((await w.carrier.publish(burn.blob)).ok,true);
   await post('mine',{blocks:10});await w.scanner.sync();const pay=await post('payout',{symbol:sym,txid:burn.txid});assert.equal(pay.status,'paid');assert.equal(pay.net,netOf(20n*unit).toString(),sym+': redemption net per policy');
   const fin=(await post('state',{id:who})).assets.find(a=>a.symbol===sym).liabilities;assert.equal(fin.ok,true,sym+': backing holds after deposit and redemption');
   w.engine.call({op:'close'});
   return {symbol:sym,asset:row.asset,mint:row.mint,decimals:row.decimals,feeBps:bps,credit:sub.txid,amount:l.amount,depositNet:ds.receipt.net,redeemed:(20n*unit).toString(),payoutNet:pay.net,backing:fin.ok};};
  // TEST SERVICE: K needs test XMR for its redemption carriers (coinbase matures after 60 blocks; at most 50 mined per call).
  await post('fund',{id:'K',blocks:4});await post('mine',{blocks:50});await post('mine',{blocks:12});
  const others=[];for(const sym of catalog.testInstances.filter(x=>x!=='EXTREMIST'))others.push(await migrate(sym,'K',rootK,kK));
  step('other catalog tokens migrated by the same path',{others});
  let future=null;if(catalog.futureTokenForTest){const added=await post('addAsset',{symbol:catalog.futureTokenForTest});assert.equal(added.holdersWithLots>=2,true,'existing holders got lots for the new token at its cutover');future=await migrate(catalog.futureTokenForTest,'K',rootK,kK);step('FUTURE token added after startup migrated by the same path',{added,future});}
  ev.result='PASSED';ev.summary={catalogTokens:catalog.assets.length,instantiated:catalog.testInstances,others,future,legacyLot:'10000000000',privateAfterMigration:'10000000000',tax:'none on migration; later deposits and redemptions follow each token’s on-chain transfer-fee setting (0 or 150 bps), exact',holderXmrFeeForMigration:'0 (issuer-paid credit carrier)',issuerCreditCarrierFeePiconero:creditFee,mintStandIn:E1.mint,realMint:real.mint,decimals:6};
 }finally{await backend.close();await mkdir(dir+'migration/evidence',{recursive:true});await writeFile(dir+'migration/evidence/legacy-migration-extremist-'+new Date().toISOString().slice(0,10)+'.json',JSON.stringify(ev,null,1));}
});
