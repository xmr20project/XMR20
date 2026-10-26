// H2 INTEGRATION (realistic): the FIXED operator inside the real offline backend (fakechain daemon, roles binary, LiteSVM custody
// with the compiled program) driven by the real holder engine (wallet-lib). A custody submission is interrupted after the program
// paid (the supported afterSubmit hook, the lost-reply model); the operator must keep that exposure reserved, refuse the payout
// that would exceed the window cap, recover the receipt without a second payment, and pay the remaining burn once the window
// has passed. Exclusive per-run endpoints (M5). SIMULATED; synthetic keys only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Keypair,Transaction} from '@solana/web3.js';
import {startBackend} from '../backend/service.mjs';
import {openTokenWallet,memoryCache} from '../wallet-lib/token-wallet.mjs';
import {EXPOSURE} from '../backend/operator.mjs';
import {ed25519} from '@noble/curves/ed25519';
import {ORDER} from '../../../website/services/native-market/xn1/proofs.mjs';
import {le} from '../../../website/services/native-market/xn1/bytes.mjs';
// synthetic legacy view/spend public keys, as the supplied flow test registers them (the test backend derives a legacy lot from them)
const G=ed25519.ExtendedPoint.BASE;const scalar=()=>{let k;do{k=le(randomBytes(64))%ORDER;}while(!k);return k;};const legacyKeys=()=>({A:hex(G.multiply(scalar()).toRawBytes()),B:hex(G.multiply(scalar()).toRawBytes())});
const dir=fileURLToPath(new URL('../',import.meta.url));
const hex=b=>Buffer.from(b).toString('hex');const closeFetch=(u,o={})=>fetch(u,{...o,headers:{...(o.headers||{}),connection:'close'}});
const MANIFEST=JSON.parse(await readFile(dir+'params/test-v2/manifest.json','utf8'));
test('H2 (integration): interrupted custody submission keeps its reservation; window cap holds; receipt recovered; no double payment',{timeout:900000},async()=>{
 let trip=true;const injected=[];
 const backend=await startBackend({ports:'exclusive',origins:[],log:m=>console.error('backend:',m),operatorInject:(stage,txid)=>{injected.push(stage);if(stage==='afterSubmit'&&trip){trip=false;throw Error('synthetic interruption after custody paid');}}});
 const BASE=backend.url.replace(/\/$/,'');const post=async(action,body)=>{const r=await closeFetch(`${BASE}/action/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
 try{
  console.error(JSON.stringify({isolatedEndpoints:backend.ports}));
  const wasm=await WebAssembly.compile(await readFile(dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm'));const cache=memoryCache();
  const B=await openTokenWallet({wasm,manifest:MANIFEST,daemonRpc:backend.rpcUrl,parameterServer:BASE,cache,fetch:closeFetch,root:hex(randomBytes(32))});const solB=Keypair.generate();
  const k=legacyKeys();const r=await post('register',{id:'B',sol:solB.publicKey.toBase58(),xmr:B.nativeAddress(),A:k.A,B:k.B,tokenAddress:B.address()});assert.equal(r.registered,true);
  // the synthetic legacy position of asset X backs exactly two holders' lots: register a second (idle) account so liabilities balance
  const A=await openTokenWallet({wasm,manifest:MANIFEST,daemonRpc:backend.rpcUrl,parameterServer:BASE,cache,fetch:closeFetch,root:hex(randomBytes(32))});const kA=legacyKeys();await post('register',{id:'A',sol:Keypair.generate().publicKey.toBase58(),xmr:A.nativeAddress(),A:kA.A,B:kA.B,tokenAddress:A.address()});A.close();
  await post('fund',{id:'B',blocks:6});await post('mine',{blocks:50});await post('mine',{blocks:12});await B.sync();
  const X=backend.assets.X.asset;const single=BigInt(EXPOSURE.maxSinglePayout);// 100 X; window cap 200 X (operator defaults)
  // deposit enough for three burns of the single-payout maximum
  const prep=await post('depositPrepare',{id:'B',symbol:'X',amount:(single*3n*10000n/9850n+1n).toString()});const tx=Transaction.from(Buffer.from(prep.transaction,'base64'));tx.sign(solB);
  const dep=await post('depositSubmit',{id:'B',nonce:prep.nonce,transaction:tx.serialize().toString('base64')});assert.ok(BigInt(dep.receipt.net)>=single*3n);
  const op=backend.assets.X.operator;assert.ok(op,'operator created on first use');assert.equal(op.exposure.maxPaidPerWindow,EXPOSURE.maxPaidPerWindow);
  await post('mine',{blocks:op.confirmations});await B.sync();
  const carry=async(wire,kind)=>{await B.sync();const q=await B.quoteCarrier({kind,wireLen:wire.length/2});const s=B.signCarrier(q.quoteId,wire);const p=await B.publish(s.blob);assert.equal(p.ok,true,p.reason);return s.txid;};
  const burns=[];
  for(let i=0;i<3;i++){const rp=await post('redeemPrepare',{id:'B',symbol:'X',amount:single.toString()});await B.sync();const sel=B.selectPublic({asset:X,amount:single.toString()});const b=await B.build({kind:'burn',asset:X,amount:single.toString(),binding:rp.binding,notes:sel.notes});burns.push(await carry(b.wire,'burn'));await post('mine',{blocks:1});}
  await post('mine',{blocks:op.confirmations});
  // 1. first payout: custody pays, then the process "dies" before the journal says paid
  await assert.rejects(post('payout',{symbol:'X',txid:burns[0]}),/synthetic interruption/);
  assert.equal(op.state.payouts[burns[0]].status,'submitting');assert.ok(backend.assets.X.bridge.redemptionReceipt(burns[0]),'custody holds the receipt');
  // 2. second payout fits the window (100 reserved + 100); the third is refused by the cap
  const p2=await post('payout',{symbol:'X',txid:burns[1]});assert.equal(p2.status,'paid');
  await assert.rejects(post('payout',{symbol:'X',txid:burns[2]}),/window payout limit/);
  // 3. recovery: the first payout resolves from the custody receipt without a second payment; the cap still holds
  const rec=await post('payout',{symbol:'X',txid:burns[0]});assert.equal(rec.status,'paid');assert.equal(op.state.payouts[burns[0]].recovered,true);
  await assert.rejects(post('payout',{symbol:'X',txid:burns[2]}),/window payout limit/);
  const receiptsNow=burns.filter(t=>backend.assets.X.bridge.redemptionReceipt(t)).length;assert.equal(receiptsNow,2,'exactly two custody receipts exist');
  // 4. after the window passes the third burn is paid once
  await post('mine',{blocks:op.exposure.windowBlocks});const p3=await post('payout',{symbol:'X',txid:burns[2]});assert.equal(p3.status,'paid');
  assert.deepEqual(burns.map(t=>op.state.payouts[t].status),['paid','paid','paid']);assert.equal(burns.filter(t=>backend.assets.X.bridge.redemptionReceipt(t)).length,3);
  const again=await post('payout',{symbol:'X',txid:burns[1]});assert.equal(again.repeated,true);
  const liabilities=(await post('state',{id:'B'})).assets.find(a=>a.symbol==='X').liabilities;assert.equal(liabilities.ok,true,JSON.stringify(liabilities));
  console.error(JSON.stringify({burns,injected:injected.filter(s=>s==='afterSubmit').length,payouts:burns.map(t=>({txid:t.slice(0,12),status:op.state.payouts[t].status,recovered:Boolean(op.state.payouts[t].recovered)}))}));
  B.close();
 }finally{await backend.close();await rm(backend.run,{recursive:true,force:true});}
});
