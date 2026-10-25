// END-TO-END FLOW of the unshielded-by-default format through the REAL holder engine (wasm in Node via wallet-lib), the
// candidate's roles binary (indexer + issuer), the offline fakechain and the LiteSVM custody. SIMULATED; synthetic balances only.
//   deposit -> PUBLIC credit (XC1) -> public transfer with change (XP1, 1 tx) -> shield (XS1, 1 tx) -> PRIVATE transfer (XMA+XMB,
//   2 txs) -> recipient unshields one note (XU1, 1 tx) -> public burn (XR1) -> operator payout after D confirmations ->
//   legacy claim -> PUBLIC migration credit of exactly the lot -> fresh-root recovery -> rollback of part A before part B ->
//   backing invariant after every step -> disclosure audit of every record and every backend request.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Keypair,Transaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {keccak_256} from '@noble/hashes/sha3';
import {startBackend} from './backend/service.mjs';
import {openTokenWallet,memoryCache} from './wallet-lib/token-wallet.mjs';
import {ORDER} from '../../website/services/native-market/xn1/proofs.mjs';
import {le} from '../../website/services/native-market/xn1/bytes.mjs';
const dir=fileURLToPath(new URL('./',import.meta.url));
const PORTS={rpcPort:30121,p2pPort:30120,httpPort:8981};const BASE=`http://127.0.0.1:${PORTS.httpPort}`;
const hex=b=>Buffer.from(b).toString('hex');const closeFetch=(u,o={})=>fetch(u,{...o,headers:{...(o.headers||{}),connection:'close'}});
const post=async(action,body)=>{const r=await closeFetch(`${BASE}/action/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
const MANIFEST=JSON.parse(await readFile(dir+'params/test-v2/manifest.json','utf8'));
const cache=memoryCache();
// Legacy one-time keys exactly as the shipping format derives them: P = Hs(8 r A || i) G + B; x = Hs(8 a R || i) + b.
const G=ed25519.ExtendedPoint.BASE;const Hs=b=>le(keccak_256(b))%ORDER;const varint=n=>{const out=[];let x=BigInt(n);while(x>=0x80n){out.push(Number(x&0x7fn)|0x80);x>>=7n;}out.push(Number(x));return Buffer.from(out);};
const uint=(n,len)=>{const b=Buffer.alloc(len);let x=BigInt(n);for(let i=0;i<len;i++){b[i]=Number(x&0xffn);x>>=8n;}return b;};
const scalar=()=>{let k;do{k=le(randomBytes(64))%ORDER;}while(!k);return k;};
function legacyKeys(){const a=scalar(),b=scalar();return {a,b,A:hex(G.multiply(a).toRawBytes()),B:hex(G.multiply(b).toRawBytes())};}
function legacyPrivate(keys,R,index){const D=ed25519.ExtendedPoint.fromHex(R,false).multiply(8n).multiply(keys.a).toRawBytes();return (Hs(Buffer.concat([Buffer.from(D),varint(index)]))+keys.b)%ORDER;}
function signLegacy(messageHash,x){const P=G.multiply(x).toRawBytes();let nonce,c,r;do{nonce=scalar();const R=G.multiply(nonce).toRawBytes();c=Hs(Buffer.concat([Buffer.from(messageHash,'hex'),Buffer.from(P),Buffer.from(R)]));r=((nonce-c*x)%ORDER+ORDER)%ORDER;}while(!c||!r);return Buffer.concat([uint(c,32),uint(r,32)]).toString('hex');}
const evidence={execution:'SIMULATED (offline fakechain, roles binary, LiteSVM custody); Penumbra published keys',steps:[],sizes:[],fees:[]};
const step=(name,x={})=>{evidence.steps.push({at:new Date().toISOString(),name,...x});console.error(JSON.stringify({step:name,...x}).slice(0,400));};

test('unshielded-by-default: public credit, public send, shield, 2-tx private send, unshield, burn+payout, migration, recovery, rollback, disclosure audit',{timeout:2400000},async()=>{
 await mkdir(dir+'runs',{recursive:true});
 const backend=await startBackend({...PORTS,log:m=>console.error('backend:',m),origins:[]});const rpc=backend.rpcUrl;
 try{
  const wasm=await WebAssembly.compile(await readFile(dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm'));
  const open=async(root)=>openTokenWallet({wasm,manifest:MANIFEST,daemonRpc:rpc,parameterServer:BASE,cache,fetch:closeFetch,root:hex(root)});
  const rootA=randomBytes(32),rootB=randomBytes(32);const A=await open(rootA),B=await open(rootB);
  assert.ok(A.address().startsWith('xmr20t1'),A.address());assert.ok(A.shieldedAddress().startsWith('penumbra1'));assert.match(A.ownerKey(),/^[0-9a-f]{64}$/);assert.notEqual(A.address(),B.address());
  const solA=Keypair.generate(),solB=Keypair.generate();const kA=legacyKeys(),kB=legacyKeys();
  for(const [id,sol,w,k] of [['A',solA,A,kA],['B',solB,B,kB]]){const r=await post('register',{id,sol:sol.publicKey.toBase58(),xmr:w.nativeAddress(),A:k.A,B:k.B,tokenAddress:w.address()});assert.equal(r.registered,true);assert.equal(r.ownerKey,w.ownerKey());}
  // TEST SERVICE: XMR for carrier fees (several coinbase outputs each: a private transfer needs TWO spendable inputs).
  await post('fund',{id:'A',blocks:6});await post('fund',{id:'B',blocks:6});await post('mine',{blocks:50});await post('mine',{blocks:12});
  await A.sync();await B.sync();let st=A.status();assert.deepEqual(st.public.balances,{});assert.deepEqual(st.shielded.balances,{});
  const X=backend.assets.X.asset;
  const pool=async()=>{const s=await post('state',{id:'A'});assert.equal(s.pool.invariant.ok,true,'backing invariant: '+JSON.stringify(s.pool.invariant));return s;};
  // Carrier helper: plan -> quote (exact fee) -> sign -> publish; records sizes and fees.
  const carry=async(w,kind,wire,planReq,part=0)=>{const plan=w.plan(planReq);assert.equal(plan.wireLengths[part],wire.length/2,'planned length equals the built record');const q=await w.quoteCarrier({kind,wireLen:wire.length/2});const s=w.signCarrier(q.quoteId,wire);assert.equal(s.fee,q.fee,'fee paid = fee quoted');const r=await w.publish(s.blob);assert.equal(r.ok,true,r.reason);
   evidence.sizes.push({kind,recordBytes:wire.length/2,extraBytes:s.extraBytes,nativeBytes:s.nativeBytes});evidence.fees.push({kind,fee:String(s.fee)});return {txid:s.txid,blob:s.blob,fee:String(s.fee),extraBytes:s.extraBytes,keyImage:s.keyImage};};

  // 1. Deposit 100 X -> PUBLIC credit to A's owner key.
  const prep=await post('depositPrepare',{id:'A',symbol:'X',amount:'100000000'});assert.equal(prep.review.creditTo,A.address());
  const tx=Transaction.from(Buffer.from(prep.transaction,'base64'));tx.sign(solA);const dep=await post('depositSubmit',{id:'A',nonce:prep.nonce,transaction:tx.serialize().toString('base64')});assert.equal(dep.receipt.net,'98500000');assert.equal(dep.credit.kind,'public');
  await post('mine',{blocks:10});await A.sync();st=A.status();assert.equal(st.public.balances[X],'98500000');assert.equal(st.public.notes.length,1);assert.deepEqual(st.shielded.balances,{});
  step('deposit credited publicly',{net:dep.receipt.net,credit:dep.credit.txid});await pool();

  // 2. PUBLIC transfer 40 X to B (one transaction) with change.
  const selP=A.selectPublic({asset:X,amount:'40000000'});assert.equal(selP.notes.length,1);assert.equal(selP.change,'58500000');
  const pub=await A.build({kind:'public',asset:X,to:B.address(),amount:'40000000',notes:selP.notes});assert.equal(pub.transactions,1);assert.equal(pub.change,'58500000');
  assert.equal(A.verify(pub.wire).record,'accepted');
  const c1=await carry(A,'public',pub.wire,{kind:'public',inputs:1,change:true});
  await post('mine',{blocks:1});await A.sync();await B.sync();
  assert.equal(A.status().public.balances[X],'58500000');assert.equal(B.status().public.balances[X],'40000000');
  assert.equal(A.status().records[pub.recordId].status,'accepted');
  // replaying the same record is refused locally and never signed again
  assert.equal(A.verify(pub.wire).record,'rejected');await assert.rejects(A.quoteCarrier({kind:'public',wireLen:pub.bytes}).then(q=>A.signCarrier(q.quoteId,pub.wire)),/admission|spent|Unknown public input/);
  step('public transfer 40 X (1 tx)',{txid:c1.txid,fee:c1.fee,extraBytes:c1.extraBytes});await pool();

  // 3. A shields 50 of its 58.5 X (one transaction): public change 8.5, shielded note 50.
  const selS=A.selectPublic({asset:X,amount:'50000000'});
  const sh=await A.build({kind:'shield',asset:X,amount:'50000000',notes:selS.notes});assert.equal(sh.transactions,1);assert.equal(sh.change,'8500000');
  const c2=await carry(A,'shield',sh.wire,{kind:'shield',inputs:selS.notes.length});
  await post('mine',{blocks:1});await A.sync();st=A.status();assert.equal(st.public.balances[X],'8500000');assert.equal(st.shielded.balances[X],'50000000');assert.equal(st.shielded.notes.length,1);
  step('shield 50 X (1 tx)',{txid:c2.txid,fee:c2.fee,provingMs:sh.provingMs});const s3=await pool();assert.equal(s3.pool.shieldedSupply[X],'50000000');

  // 4. PRIVATE transfer 30 X to B: TWO carriers (A then B), recipient sees it only once both are canonical.
  const selN=A.select({asset:X,amount:'30000000'});assert.equal(selN.notes.length,1);
  const nativeBefore=A.native();assert.ok(nativeBefore.outputs.filter(o=>!o.spent&&!o.reserved).length>=2,'two spendable XMR outputs for two carriers');
  const pv=await A.build({kind:'private',to:B.shieldedAddress(),amount:'30000000',notes:selN.notes});assert.equal(pv.transactions,2);assert.deepEqual(pv.bytes,[932,900]);assert.equal(pv.change,'20000000');
  assert.equal(A.verify({wires:pv.wires}).record,'accepted');assert.equal(A.verify(pv.wires[0]).record,'pending','part A alone is pending');assert.equal(A.verify(pv.wires[1]).record,'pending','part B alone is pending');
  const cA=await carry(A,'private',pv.wires[0],{kind:'private'});
  await post('mine',{blocks:1});await A.sync();await B.sync();
  assert.equal(A.status().shielded.balances[X],'50000000','nothing moves while part B is missing');assert.equal(B.status().shielded.balances[X]??'0','0');
  assert.equal(A.status().records[pv.recordIds[0]].status,'pending');
  const cB=await carry(A,'private',pv.wires[1],{kind:'private'},1);assert.notEqual(cA.keyImage,cB.keyImage,'two different XMR inputs');
  await post('mine',{blocks:1});await A.sync();await B.sync();
  assert.equal(A.status().shielded.balances[X],'20000000');assert.equal(B.status().shielded.balances[X],'30000000');assert.equal(B.status().public.balances[X],'40000000');
  assert.ok(pv.recordIds.every(id=>A.status().records[id].status==='accepted'&&A.status().records[id].detail.completed===true),'both parts accepted once the operation completed');
  step('private transfer 30 X (2 txs)',{txids:[cA.txid,cB.txid],fees:[cA.fee,cB.fee],provingMs:pv.provingMs});const s4=await pool();assert.equal(s4.pool.shieldedSupply[X],'50000000','shielded supply unchanged by a private transfer');
  // duplicates of either part change nothing
  assert.equal(A.verify(pv.wires[0]).record,'pending');assert.equal(A.verify(pv.wires[1]).record,'pending');

  // 5. B unshields 10 of its 30 X note to its own public key (one transaction), change 20 stays shielded.
  const bNote=B.status().shielded.notes[0];
  const un=await B.build({kind:'unshield',amount:'10000000',notes:[bNote.commitment]});assert.equal(un.transactions,1);assert.equal(un.bytes,924);assert.equal(un.change,'20000000');
  const c5=await carry(B,'unshield',un.wire,{kind:'unshield'});
  await post('mine',{blocks:1});await B.sync();st=B.status();assert.equal(st.public.balances[X],'50000000');assert.equal(st.shielded.balances[X],'20000000');
  step('unshield 10 X (1 tx)',{txid:c5.txid,fee:c5.fee,provingMs:un.provingMs});const s5=await pool();assert.equal(s5.pool.shieldedSupply[X],'40000000');

  // 6. B burns 25 X publicly for a payout; operator pays after D confirmations, exactly once.
  const rp=await post('redeemPrepare',{id:'B',symbol:'X',amount:'25000000'});assert.equal(rp.destination,solB.publicKey.toBase58());
  const selB=B.selectPublic({asset:X,amount:'25000000'});const burn=await B.build({kind:'burn',asset:X,amount:'25000000',binding:rp.binding,notes:selB.notes});
  const c6=await carry(B,'burn',burn.wire,{kind:'burn',inputs:selB.notes.length});
  await post('mine',{blocks:1});await B.sync();assert.equal(B.status().public.balances[X],'25000000');
  await assert.rejects(post('payout',{symbol:'X',txid:c6.txid}),/Only \d+ confirmations/);
  await post('mine',{blocks:backend.config?10:10});const paid=await post('payout',{symbol:'X',txid:c6.txid});assert.equal(paid.status,'paid');assert.equal(paid.net,'24625000');
  const again=await post('payout',{symbol:'X',txid:c6.txid});assert.equal(again.repeated,true);
  const stB=await post('state',{id:'B'});assert.equal(stB.assets.find(a=>a.symbol==='X').solanaBalance,String(1_000_000_000n+24_625_000n));
  step('burn 25 X -> payout 24.625 X once',{txid:c6.txid,fee:c6.fee});const s6=await pool();assert.equal(s6.assets.find(a=>a.symbol==='X').liabilities.ok,true,'operator liabilities balanced');

  // 7. Migration: A's synthetic legacy lot (X) -> PUBLIC credit of exactly the lot; duplicate refused.
  const lot=(await post('state',{id:'A'})).assets.find(a=>a.symbol==='X').legacy[0];assert.ok(lot&&!lot.claimed);
  const cp=await post('claimPrepare',{id:'A',claim:lot.claim,symbol:'X'});assert.equal(cp.body.owner,A.address());assert.equal(cp.amount,lot.amount);
  const x=legacyPrivate(kA,cp.txPublicKey,cp.outputIndex);assert.equal(hex(G.multiply(x).toRawBytes()),cp.P,'legacy output key belongs to A');
  const cl=await post('claimSubmit',{id:'A',symbol:'X',body:cp.body,legacySignature:signLegacy(cp.messageHash,x)});assert.equal(cl.amount,lot.amount);
  await assert.rejects(post('claimSubmit',{id:'A',symbol:'X',body:cp.body,legacySignature:signLegacy(cp.messageHash,x)}),/already/i);
  await post('mine',{blocks:1});await A.sync();assert.equal(A.status().public.balances[X],String(8_500_000n+BigInt(lot.amount)));
  step('legacy lot migrated to a PUBLIC note, exactly the lot',{amount:lot.amount,credit:cl.txid});const s7=await pool();assert.equal(s7.assets.find(a=>a.symbol==='X').liabilities.ok,true);

  // 8. Fresh-root recovery: a new engine from A's root rebuilds both balances; a wrong root sees nothing; a viewing key sees shielded only.
  const A2=await open(rootA);await A2.sync();assert.deepEqual(A2.status().public.balances,A.status().public.balances);assert.deepEqual(A2.status().shielded.balances,A.status().shielded.balances);assert.equal(A2.address(),A.address());
  const Z=await open(randomBytes(32));await Z.sync();assert.deepEqual(Z.status().public.balances,{});assert.deepEqual(Z.status().shielded.balances,{});
  const V=await openTokenWallet({wasm,manifest:MANIFEST,daemonRpc:rpc,parameterServer:BASE,cache,fetch:closeFetch,viewingKey:A.viewingKey()});await V.sync();assert.equal(V.status().shielded.balances[X],'20000000');assert.deepEqual(V.status().public.balances,{},'a viewing key alone reveals no public ownership');assert.equal(V.canSpend,false);
  step('recovery from root; wrong root empty; viewing key shielded-only');

  // 9. Rollback: A publishes part A of a new private transfer, the chain rolls back below it before part B exists; the indexer
  //    forgets the half, nothing was reserved on chain; A re-publishes the SAME two signed carriers and the operation completes once.
  const sel9=A.select({asset:X,amount:'5000000'});const pv9=await A.build({kind:'private',to:B.shieldedAddress(),amount:'5000000',notes:sel9.notes});
  const tipBefore=(await post('state',{id:'A'})).tip;const c9a=await carry(A,'private',pv9.wires[0],{kind:'private'});await post('mine',{blocks:2});await A.sync();assert.equal(A.status().records[pv9.recordIds[0]].status,'pending');
  const popped=await post('pop',{blocks:2});assert.equal(popped.tip,tipBefore);await A.sync();assert.equal(A.status().records[pv9.recordIds[0]],undefined,'rolled-back half forgotten by replay');
  assert.equal(A.status().shielded.balances[X],'20000000');
  const re=await A.publish(c9a.blob);assert.equal(re.ok,true,'the same signed carrier is accepted again (no new fee)');
  const c9b=await carry(A,'private',pv9.wires[1],{kind:'private'},1);await post('mine',{blocks:1});await A.sync();await B.sync();
  assert.equal(A.status().shielded.balances[X],'15000000');assert.equal(B.status().shielded.balances[X],'25000000');assert.ok(pv9.recordIds.every(id=>A.status().records[id].status==='accepted'&&A.status().records[id].detail.completed===true),'both parts of the completed operation are accepted');
  step('rollback of part A before part B; identical carriers re-published; completed once',{popped:popped.popped,txids:[c9a.txid,c9b.txid]});await pool();

  // 10. Independent indexer replay: the backend's indexer summary equals the holder engine's local pool summary.
  const s10=await post('state',{id:'A'});const local=A.status().pool;
  for(const k of ['root','shieldedNotes','nullifiers','publicNotes','minted','burned','publicSupply','shieldedSupply','completedOperations'])assert.deepEqual(local[k],s10.pool[k],'indexer vs holder: '+k);
  step('indexer replay equals the holder replica',{root:local.root});

  // 11. DISCLOSURE AUDIT: no native output key or key image of either wallet appears in any record, in any carrier's tx_extra, or in
  //     any backend request. Known native data: every output key and key image the wallets hold.
  const native=[...A.native().outputs,...B.native().outputs];const needles=new Set();for(const o of native){for(const k of ['key','keyImage','publicKey','ki'])if(typeof o[k]==='string'&&o[k].length===64)needles.add(o[k]);}
  for(const c of [c1,c2,cA,cB,c5,c6,c9a,c9b])if(c.keyImage)needles.add(c.keyImage);
  assert.ok(needles.size>=8,'audit needs the wallets\' native data');
  const wires=[pub.wire,sh.wire,...pv.wires,un.wire,burn.wire,...pv9.wires].map(w=>w.toLowerCase());
  for(const n of needles)for(const w of wires)assert.ok(!w.includes(n),'record contains native key material');
  const requests=await readFile(backend.run+'/requests.log','utf8');for(const n of needles)assert.ok(!requests.toLowerCase().includes(n),'backend request log contains native key material');
  // every carrier's tx_extra is exactly one tx pubkey + the record chunks (no extra fields)
  for(const c of [c1,c2,cA,cB,c5,c6]){const t=await (await closeFetch(rpc+'/get_transactions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({txs_hashes:[c.txid],decode_as_json:true})})).json();const j=JSON.parse(t.txs[0].as_json);assert.ok(j.extra.length<=1060,'tx_extra within the relay limit');assert.equal(j.extra[0],1,'tx pubkey first');}
  step('disclosure audit passed',{needles:needles.size,records:wires.length});
  evidence.final={A:A.status().public.balances,Ash:A.status().shielded.balances,B:B.status().public.balances,Bsh:B.status().shielded.balances,pool:s10.pool};
  await writeFile(dir+'runs/flow-results.json',JSON.stringify(evidence,null,1));
 }finally{await backend.close();}
});
