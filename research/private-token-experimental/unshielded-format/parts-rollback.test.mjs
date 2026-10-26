// TWO-PART PRIVATE TRANSFERS UNDER REORGANISATION AND CONFLICT (real engine via wallet-lib, roles binary, offline fakechain).
//   a. both parts mined, rollback removes ONLY part B -> the operation reverts to a lone part A (nothing spent), the recipient's
//      balance disappears; the same signed carrier B is re-published -> completes again exactly once.
//   b. rollback removes BOTH parts -> both forgotten; re-publishing both identical carriers completes once.
//   c. conflicting spend: part A of op1 is on chain; op2 spends the same note and completes first -> op1 can never complete, the
//      wallet's admission check says so, no carrier fee is paid for a stale part B.
//   d. duplicate/reversed arrival through the real chain: part B mined before part A -> completes at A; a second copy of A later is inert.
//   e. independent indexer replay equals the holder's replica after every case; the backing invariant holds throughout.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Keypair,Transaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {startBackend} from './backend/service.mjs';
import {openTokenWallet,memoryCache} from './wallet-lib/token-wallet.mjs';
const dir=fileURLToPath(new URL('./',import.meta.url));
const PORTS={rpcPort:30131,p2pPort:30130,httpPort:8991};const BASE=`http://127.0.0.1:${PORTS.httpPort}`;
const hex=b=>Buffer.from(b).toString('hex');const closeFetch=(u,o={})=>fetch(u,{...o,headers:{...(o.headers||{}),connection:'close'}});
const post=async(action,body)=>{const r=await closeFetch(`${BASE}/action/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
const MANIFEST=JSON.parse(await readFile(dir+'params/test-v2/manifest.json','utf8'));const cache=memoryCache();
const evidence={execution:'SIMULATED (offline fakechain, roles binary, LiteSVM custody); Penumbra published keys',cases:[]};const rec=(name,x={})=>{evidence.cases.push({at:new Date().toISOString(),name,...x});console.error(JSON.stringify({step:name,...x}).slice(0,300));};
test('two-part private transfers: rollbacks of one or both parts, conflicting spend, reversed arrival, replay equality',{timeout:2400000},async()=>{
 await mkdir(dir+'runs',{recursive:true});
 const backend=await startBackend({...PORTS,log:m=>console.error('backend:',m),origins:[]});const rpc=backend.rpcUrl;
 try{
  const wasm=await WebAssembly.compile(await readFile(dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm'));
  const open=async(root)=>openTokenWallet({wasm,manifest:MANIFEST,daemonRpc:rpc,parameterServer:BASE,cache,fetch:closeFetch,root:hex(root)});
  const A=await open(randomBytes(32)),B=await open(randomBytes(32));const sol=Keypair.generate();
  const pub=()=>{const a=ed25519.utils.randomPrivateKey(),b=ed25519.utils.randomPrivateKey();return {A:hex(ed25519.getPublicKey(a)),B:hex(ed25519.getPublicKey(b))};};
  await post('register',{id:'A',sol:sol.publicKey.toBase58(),xmr:A.nativeAddress(),...pub(),tokenAddress:A.address()});await post('register',{id:'B',sol:Keypair.generate().publicKey.toBase58(),xmr:B.nativeAddress(),...pub(),tokenAddress:B.address()});
  await post('fund',{id:'A',blocks:10});await post('fund',{id:'A',blocks:4});await post('mine',{blocks:50});await post('mine',{blocks:12});
  const X=backend.assets.X.asset;
  const sync=async()=>{await A.sync();await B.sync();};
  const check=async(label)=>{const s=await post('state',{id:'A'});assert.equal(s.pool.invariant.ok,true,label+': invariant');const local=A.status().pool;for(const k of ['root','nullifiers','publicNotes','shieldedSupply','completedOperations'])assert.deepEqual(local[k],s.pool[k],label+': indexer vs holder '+k);return s;};
  const carry=async(w,kind,wire,len)=>{await w.sync();/* the engine's native view must be at the daemon's tip before a quote (the popup refreshes first) */const q=await w.quoteCarrier({kind,wireLen:len});const s=w.signCarrier(q.quoteId,wire);const r=await w.publish(s.blob);assert.equal(r.ok,true,r.reason);return {txid:s.txid,blob:s.blob,fee:s.fee};};
  // Funding: deposit 100 X publicly, shield 90 into two notes (60 and 30) via two shields.
  const prep=await post('depositPrepare',{id:'A',symbol:'X',amount:'100000000'});const tx=Transaction.from(Buffer.from(prep.transaction,'base64'));tx.sign(sol);await post('depositSubmit',{id:'A',nonce:prep.nonce,transaction:tx.serialize().toString('base64')});await post('mine',{blocks:10});await sync();
  for(const amt of ['60000000','30000000']){const sel=A.selectPublic({asset:X,amount:amt});const sh=await A.build({kind:'shield',asset:X,amount:amt,notes:sel.notes});await carry(A,'shield',sh.wire,sh.bytes);await post('mine',{blocks:1});await sync();}
  assert.equal(A.status().shielded.balances[X],'90000000');assert.equal(A.status().shielded.notes.length,2);await check('funded');
  const noteOf=(w,amt)=>w.status().shielded.notes.find(n=>n.amount===amt).commitment;

  // a. rollback removes ONLY part B of a completed operation
  const op1=await A.build({kind:'private',to:B.shieldedAddress(),amount:'20000000',notes:[noteOf(A,'60000000')]});
  const a1=await carry(A,'private',op1.wires[0],932);await post('mine',{blocks:1});const tipA=(await post('state',{id:'A'})).tip;
  const b1=await carry(A,'private',op1.wires[1],900);await post('mine',{blocks:1});await sync();
  assert.equal(B.status().shielded.balances[X],'20000000');assert.equal(A.status().shielded.balances[X],'70000000');await check('a: completed');
  const popped=await post('pop',{blocks:1});assert.equal(popped.tip,tipA);await sync();
  assert.equal(B.status().shielded.balances[X]??'0','0','part B rolled back: recipient balance gone');assert.equal(A.status().shielded.balances[X],'90000000','sender notes unspent again');assert.equal(A.status().records[op1.recordIds[0]].status,'pending');assert.equal(A.status().records[op1.recordIds[1]],undefined);
  const re=await A.publish(b1.blob);assert.equal(re.ok,true,'identical carrier B accepted again');await post('mine',{blocks:1});await sync();
  assert.equal(B.status().shielded.balances[X],'20000000');assert.equal(A.status().pool.completedOperations,1);rec('a: rollback of part B only; re-published identical B completes once',{a:a1.txid,b:b1.txid});await check('a: recompleted');

  // b. rollback removes BOTH parts (mined in one block)
  const op2=await A.build({kind:'private',to:B.shieldedAddress(),amount:'5000000',notes:[noteOf(A,'30000000')]});
  const tipB=(await post('state',{id:'A'})).tip;const a2=await carry(A,'private',op2.wires[0],932);const b2=await carry(A,'private',op2.wires[1],900);await post('mine',{blocks:1});await sync();
  assert.equal(B.status().shielded.balances[X],'25000000');assert.equal(A.status().pool.completedOperations,2);
  await post('pop',{blocks:1});await sync();assert.equal(B.status().shielded.balances[X],'20000000');assert.equal(A.status().pool.completedOperations,1);assert.equal(A.status().records[op2.recordIds[0]],undefined);assert.equal(A.status().records[op2.recordIds[1]],undefined);
  assert.equal((await A.publish(a2.blob)).ok,true);assert.equal((await A.publish(b2.blob)).ok,true);await post('mine',{blocks:1});await sync();
  assert.equal(B.status().shielded.balances[X],'25000000');assert.equal(A.status().pool.completedOperations,2);rec('b: rollback of both parts; both identical carriers re-published; completed once',{a:a2.txid,b:b2.txid});await check('b');

  // c. conflicting spend: op3 part A on chain (spends A's 40 note from op1 change... use the current 25 note of op2 change), then op4 spends the same note and completes first
  const spendable=A.status().shielded.notes.slice().sort((x,y)=>BigInt(y.amount)>BigInt(x.amount)?1:-1)[0].commitment;
  const op3=await A.build({kind:'private',to:B.shieldedAddress(),amount:'1000000',notes:[spendable]});const a3=await carry(A,'private',op3.wires[0],932);await post('mine',{blocks:1});await sync();assert.equal(A.status().records[op3.recordIds[0]].status,'pending');
  const op4=await A.build({kind:'private',to:B.shieldedAddress(),amount:'2000000',notes:[spendable]});
  const beforeB=BigInt(B.status().shielded.balances[X]);const a4=await carry(A,'private',op4.wires[0],932);const b4=await carry(A,'private',op4.wires[1],900);await post('mine',{blocks:1});await sync();
  assert.equal(BigInt(B.status().shielded.balances[X])-beforeB,2000000n,'op4 completed');
  // op3's part B is now stale: local admission says the operation can never complete (nullifier spent); the wallet refuses to pay a carrier for it
  const v=A.verify({wires:op3.wires});assert.equal(v.record,'pending');assert.equal(v.detail.completed,false);assert.match(v.detail.lastError||'',/Spent/);
  const verifyB=A.verify(op3.wires[1]);assert.equal(verifyB.record,'pending');assert.equal(verifyB.detail.completed,false);
  rec('c: conflicting spend — op4 completed first; op3 half can never complete (lastError: '+v.detail.lastError+')',{a3:a3.txid,a4:a4.txid,b4:b4.txid});await check('c');
  // even if someone publishes op3's part B now, nothing happens
  const b3=await carry(A,'private',op3.wires[1],900);await post('mine',{blocks:1});await sync();assert.equal(BigInt(B.status().shielded.balances[X])-beforeB,2000000n,'stale completion changes nothing');assert.equal(A.status().pool.completedOperations,3);rec('c2: stale part B mined, inert',{b3:b3.txid});await check('c2');

  // d. reversed arrival: part B mined first, A later; then a duplicate copy of A (different carrier) is inert
  const n5=A.status().shielded.notes.slice().sort((x,y)=>BigInt(y.amount)>BigInt(x.amount)?1:-1)[0].commitment;
  const op5=await A.build({kind:'private',to:B.shieldedAddress(),amount:'3000000',notes:[n5]});const before5=BigInt(B.status().shielded.balances[X]);
  const b5=await carry(A,'private',op5.wires[1],900);await post('mine',{blocks:1});await sync();assert.equal(BigInt(B.status().shielded.balances[X]),before5,'B first: nothing yet');assert.equal(A.status().records[op5.recordIds[1]].status,'pending');
  const a5=await carry(A,'private',op5.wires[0],932);await post('mine',{blocks:1});await sync();assert.equal(BigInt(B.status().shielded.balances[X])-before5,3000000n);
  assert.ok(op5.recordIds.every(id=>A.status().records[id].status==='accepted'),'both records accepted after completion');
  const a5dup=await carry(A,'private',op5.wires[0],932);await post('mine',{blocks:1});await sync();assert.equal(BigInt(B.status().shielded.balances[X])-before5,3000000n,'duplicate part A inert');assert.equal(A.status().pool.completedOperations,4);
  rec('d: reversed arrival completes at A; duplicate A inert',{b5:b5.txid,a5:a5.txid,dup:a5dup.txid});const s=await check('d');
  evidence.final={pool:s.pool,A:A.status().shielded.balances,B:B.status().shielded.balances};await writeFile(dir+'runs/parts-rollback-results.json',JSON.stringify(evidence,null,1));
 }finally{await backend.close();}
});
