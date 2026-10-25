// PROVISIONAL WITHDRAWAL POLICY, D = 20 confirmations (Monero -> Solana), with rollbacks BELOW, AT and BEYOND the depth, BEFORE
// and AFTER payout. SIMULATED: offline zero-peer fakechain, controlled /pop_blocks rollbacks (the pool is flushed so popped
// carriers do not return by themselves), LiteSVM Solana custody, wallet-lib holders. No mainnet probability is claimed: 20 is a
// risk policy chosen by the owner's handoff, not finality (an 18-block mainnet reorganisation is on record).
// What the policy adds over the lab's 10: the operator (backend/operator.mjs) DETECTS a reorganisation of a pending burn (height
// change or disappearance), records an incident and PAUSES payouts until an explicit resume; after resume the payout is
// re-validated against the burn's CURRENT height, so confirmations restart. The post-payout loss (counterexample A) is preserved:
// a payout released at 20 and then rolled back is final on Solana, the operator latches paidWithoutBurn and halts. No reserve,
// insurance or maximum-depth assumption is introduced.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Keypair,Transaction} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import {startBackend} from '../backend/service.mjs';
import {createHolderEngine,createChainScanner} from '../wallet-extension/src/holder-engine.js';
import {createParameterLoader} from '../wallet-extension/src/holder-params.js';
import {createCarrierBuilder} from '../wallet-extension/src/holder-carrier.js';
const dir=fileURLToPath(new URL('../',import.meta.url));
const PORTS={rpcPort:30087,p2pPort:30086,httpPort:8957};const BASE=`http://127.0.0.1:${PORTS.httpPort}`;const D=20;
const closeFetch=(u,o={})=>fetch(u,{...o,headers:{...(o.headers||{}),connection:'close'}});
const post=async(action,body)=>{const r=await closeFetch(BASE+'/action/'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const text=await r.text();let v=null;try{v=text?JSON.parse(text):null;}catch{throw Error(`${action}: non-JSON response (HTTP ${r.status}): ${text.slice(0,200)}`);}if(!r.ok)throw Error(v?.error||(`${action}: HTTP ${r.status}`));if(v===null)throw Error(`${action}: empty response (HTTP ${r.status})`);return v;};
const MANIFEST=JSON.parse(await readFile(dir+'params/test-v1/manifest.json','utf8'));
const cache=(()=>{const m=new Map();return {get:async k=>m.get(k)||null,put:async(k,v)=>{m.set(k,v);},delete:async k=>{m.delete(k);}};})();
const hex=b=>Buffer.from(b).toString('hex');

test('payout depth policy D=20: rollbacks below/at/beyond the depth before payout are detected, pause payouts and re-validate; the post-payout loss is preserved',{timeout:3600000},async()=>{
 const wasm=await WebAssembly.compile(await readFile(dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm'));
 const backend=await startBackend({...PORTS,confirmations:D,log:m=>console.error('backend:',m),origins:[]});const rpc=backend.rpcUrl;
 const daemon=async(method,params={})=>{const r=await closeFetch(rpc+'/json_rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'t',method,params})});const v=await r.json();if(v.error)throw Error(JSON.stringify(v.error));return v.result;};
 const tip=async()=>(await daemon('get_info')).height-1;
 const rollback=async(n)=>{const before=await tip();const r=await closeFetch(rpc+'/pop_blocks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nblocks:n})});const v=await r.json();if(v.status!=='OK')throw Error('pop_blocks: '+JSON.stringify(v));await daemon('flush_txpool',{txids:[]});return {before,after:await tip(),popped:n};};
 const mine=async(n)=>{for(let left=n;left>0;left-=50)await post('mine',{blocks:Math.min(50,left)});};
 async function open(root,label){const engine=await createHolderEngine({wasm});const d=engine.call({op:'derive',root:hex(root),account:0});const loader=createParameterLoader({fetch:closeFetch,manifest:MANIFEST,engine,baseUrl:BASE,cache});const served=await loader.loadServedConfig();engine.call({op:'params',manifest:MANIFEST,served});
  const scanner=createChainScanner(engine,{rpc,fetch:closeFetch,genesis:MANIFEST.network.genesis});const carrier=createCarrierBuilder({engine,rpc,fetch:closeFetch});return {label,engine,loader,scanner,carrier,tokenAddress:d.tokenAddress,nativeAddress:d.nativeAddress};}
 const pub=()=>{const a=ed25519.utils.randomPrivateKey(),b=ed25519.utils.randomPrivateKey();return {A:hex(ed25519.getPublicKey(a)),B:hex(ed25519.getPublicKey(b))};};
 const status=e=>e.engine.call({op:'status'});
 const evidence={execution:'SIMULATED (offline zero-peer fakechain; controlled /pop_blocks rollbacks; LiteSVM Solana custody)',policy:{confirmations:D,provisional:true,note:'risk policy, not finality'},steps:[]};
 const step=(name,x={})=>{evidence.steps.push({at:new Date().toISOString(),name,...x});console.error(JSON.stringify({step:name,...x}).slice(0,400));};
 const row=async()=>(await post('state',{id:'A'})).assets.find(a=>a.symbol==='X');
 const payoutOf=async(txid)=>(await row()).payouts.find(p=>p.txid===txid);
 const refused=async(txid,re)=>{let err=null;try{await post('payout',{symbol:'X',txid});}catch(e){err=e.message;}assert.ok(err&&re.test(err),`payout must be refused (${re}): ${err}`);return err;};
 try{
  assert.equal(backend.state?.confirmations??D,D);
  const A=await open(randomBytes(32),'A');const solA=Keypair.generate();
  await post('register',{id:'A',sol:solA.publicKey.toBase58(),xmr:A.nativeAddress,...pub(),tokenAddress:A.tokenAddress});
  // The lab's synthetic legacy reserve (985,000,000) is exactly two lots; the backing invariant needs both registered (as in bridge-rollback-loss).
  const B=await open(randomBytes(32),'B');await post('register',{id:'B',sol:Keypair.generate().publicKey.toBase58(),xmr:B.nativeAddress,...pub(),tokenAddress:B.tokenAddress});
  // Deposit 100 X -> private credit (confirmed at D); carrier funding for four burns; coinbase matures after 60 blocks.
  const prep=await post('depositPrepare',{id:'A',symbol:'X',amount:'100000000'});const tx=Transaction.from(Buffer.from(prep.transaction,'base64'));tx.sign(solA);await post('depositSubmit',{id:'A',nonce:prep.nonce,transaction:tx.serialize().toString('base64')});
  await post('fund',{id:'A',blocks:5});await mine(70);await A.scanner.sync();await A.loader.loadProvingKey(0);await A.loader.loadProvingKey(1);
  const X=backend.assets.X.asset;assert.equal(status(A).balances[X],'98500000','100 X deposited, one 1.5% fee');
  // Fragment into four notes: 10, 10, 10, 10 (self-sends), so each burn spends exactly one note.
  for(const amt of ['10000000','10000000','10000000','10000000']){const q=await A.carrier.quote({kind:'send'});const sel=A.engine.call({op:'select',asset:X,amount:amt,exclude:[]});const built=A.engine.call({op:'build',kind:'send',to:A.tokenAddress,amount:amt,notes:sel.notes});const s=A.carrier.sign(q.quoteId,built.wire);const r=await A.carrier.publish(s.blob);assert.equal(r.ok,true);await mine(D+1);await A.scanner.sync();}
  const notes=()=>status(A).notes.filter(n=>n.amount==='10000000');assert.ok(notes().length>=4,'four 10 X notes');
  const burn=async(label)=>{const note=notes()[0];const rp=await post('redeemPrepare',{id:'A',symbol:'X',amount:'10000000'});const q=await A.carrier.quote({kind:'redeem'});const built=A.engine.call({op:'build',kind:'redeem',amount:'10000000',binding:rp.binding,notes:[note.commitment]});const b=A.carrier.sign(q.quoteId,built.wire);const pr=await A.carrier.publish(b.blob);assert.equal(pr.ok,true);await mine(1);await A.scanner.sync();const p=await payoutOf(b.txid);assert.ok(p,'operator lists the burn after one block');step(label+': burn published and mined (1 confirmation)',{txid:b.txid,height:p.height});return {...b,note,wire:built.wire,recordId:built.recordId};};
  const republish=async(b)=>{const r=await closeFetch(rpc+'/send_raw_transaction',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tx_as_hex:b.blob,do_not_relay:false,do_sanity_checks:false})});const v=await r.json();assert.equal(v.status,'OK','honest wallet re-publishes the SAME saved carrier (lookup-before-retry would do this): '+JSON.stringify(v));await mine(1);await A.scanner.sync();};
  const before=(await row()).liabilities;assert.equal(before.ok,true,'backing holds before any burn: '+JSON.stringify(before));

  // ---- CASE 1a: SHALLOW rollback BELOW the burn's own confirmations, BEFORE payout: the burn stays canonical, its confirmation
  //      count drops and is re-counted from the chain; nothing is paid, no incident (nothing about the burn changed) ----
  const b1=await burn('case1');await mine(11);await A.scanner.sync();let p=await payoutOf(b1.txid);assert.equal(p.confirmations,12);
  await refused(b1.txid,/Only 12 confirmations/);
  const rb1a=await rollback(5);await mine(1);await A.scanner.sync();p=await payoutOf(b1.txid);
  assert.equal(p.status,'pending');assert.equal(p.confirmations,8,'confirmations re-counted after a shallow rollback (12 -> 8)');assert.equal((await row()).operator.paused,false,'no incident: the burn itself did not move');
  await refused(b1.txid,/Only 8 confirmations/);step('case1a: shallow rollback (5 < burn depth 12): burn canonical, confirmations 12 -> 8, still refused, no incident',{rollback:rb1a});
  // ---- CASE 1b: rollback DEEPER than the burn's confirmations but still BELOW D, BEFORE payout: the burn leaves canonical history ->
  //      incident, payouts paused, nothing paid; the honest wallet re-publishes the identical carrier; confirmations restart from
  //      the NEW height; an explicit resume is required and does not pay by itself ----
  const rb1=await rollback(9);await mine(1);/* the indexer replays the whole chain each scan */await A.scanner.sync();await row();p=await payoutOf(b1.txid);
  assert.notEqual(p.status,'paid');const op1=(await row()).operator;assert.equal(op1.paused,true,'payouts PAUSED after the burn left canonical history: '+JSON.stringify({payout:p,operator:op1}).slice(0,400));assert.ok(op1.incidents.some(i=>i.kind==='burnVanished'&&i.txid===b1.txid),'burnVanished incident recorded');
  await refused(b1.txid,/paused|not payable|Only/);step('case1b: rollback 9 (> burn depth 8, < D) before payout -> burn vanished, incident, paused, nothing paid',{rollback:rb1,status:p.status});
  await republish(b1);await mine(D-2);await A.scanner.sync();p=await payoutOf(b1.txid);assert.equal(p.status,'pending');assert.equal(p.confirmations,D-1,'confirmations restarted from the re-mined height');
  await refused(b1.txid,/paused/);// still paused until an explicit review
  await post('resume',{symbol:'X',note:'test: incident reviewed; burn re-mined at a new height'});
  await refused(b1.txid,new RegExp(`Only ${D-1} confirmations`));// resume does not pay: the depth is re-validated against the NEW height
  await mine(1);await A.scanner.sync();p=await payoutOf(b1.txid);assert.equal(p.confirmations,D);
  const paid1=await post('payout',{symbol:'X',txid:b1.txid});assert.equal(paid1.status,'paid');assert.equal(paid1.net,'9850000');
  const again1=await post('payout',{symbol:'X',txid:b1.txid});assert.equal(again1.repeated,true,'second request pays nothing');
  step('case1b: re-mined, resumed, paid exactly once at D confirmations of the NEW height (D-1 refused)',{paidNet:paid1.net,heightAfterReorg:p.height});
  assert.equal((await row()).liabilities.ok,true,'backing holds');

  // ---- CASE 2: AT the depth: 19 refused, 20 paid (no reorganisation) ----
  const b2=await burn('case2');await mine(D-2);await A.scanner.sync();p=await payoutOf(b2.txid);assert.equal(p.confirmations,D-1);await refused(b2.txid,new RegExp(`Only ${D-1} confirmations`));
  await mine(1);await A.scanner.sync();const paid2=await post('payout',{symbol:'X',txid:b2.txid});assert.equal(paid2.status,'paid');step('case2: refused at D-1, paid at exactly D',{paidNet:paid2.net});

  // ---- CASE 3: rollback BEYOND the depth, BEFORE payout: a burn with D+5 confirmations vanishes; nothing paid; pause; recovery ----
  const b3=await burn('case3');await mine(D+4);await A.scanner.sync();p=await payoutOf(b3.txid);assert.equal(p.confirmations,D+5);assert.equal(p.status,'pending');
  const rb3=await rollback(D+6);await mine(1);await A.scanner.sync();await row();p=await payoutOf(b3.txid);const op3=(await row()).operator;
  assert.notEqual(p.status,'paid');assert.equal(op3.paused,true);assert.ok(op3.incidents.some(i=>i.kind==='burnVanished'&&i.txid===b3.txid));await refused(b3.txid,/paused|not payable/);
  assert.equal((await row()).liabilities.ok,true,'backing holds: nothing was paid for the vanished burn');
  step('case3: rollback beyond the depth before payout -> detected, paused, nothing paid, backing intact',{rollback:rb3,status:p.status});
  // The note is unspent again on the rolled-back chain; the honest wallet re-publishes the identical carrier (same txid), confirmations restart.
  await republish(b3);await post('resume',{symbol:'X',note:'test: reviewed case 3'});await mine(D-1);await A.scanner.sync();p=await payoutOf(b3.txid);assert.equal(p.confirmations,D);
  const paid3=await post('payout',{symbol:'X',txid:b3.txid});assert.equal(paid3.status,'paid');step('case3: re-mined and paid once after D fresh confirmations',{paidNet:paid3.net});

  // ---- CASE 4 (PRESERVED LOSS): payout released at D, then a rollback deeper than D removes the burn ----
  const b4=await burn('case4');await mine(D-1);await A.scanner.sync();const paid4=await post('payout',{symbol:'X',txid:b4.txid});assert.equal(paid4.status,'paid');
  const okBefore=(await row()).liabilities;assert.equal(okBefore.ok,true);
  const rb4=await rollback(D+1);await mine(1);await A.scanner.sync();const after=await row();
  assert.equal(after.liabilities.ok,false,'backing invariant FAILS after a post-payout rollback');assert.equal(after.liabilities.shortfall,'10000000','shortfall equals the paid burn');
  assert.equal(after.operator.halted,true,'operator HALTED (loss incident), not merely paused');assert.ok(after.operator.incidents.some(i=>i.kind==='paidWithoutBurn'&&i.txid===b4.txid));
  let halted=null;try{await post('payout',{symbol:'X',txid:b2.txid});}catch(e){halted=e.message;}assert.match(String(halted),/halted/,'no further payouts while halted');
  let noResume=null;try{await post('resume',{symbol:'X',note:'must fail'});}catch(e){noResume=e.message;}assert.match(String(noResume),/halted/,'a loss incident cannot be resumed away');
  step('case4: COUNTEREXAMPLE PRESERVED — payout final, burn gone after a rollback deeper than D, backing short by the paid amount, operator halted',{rollback:rb4,shortfall:after.liabilities.shortfall});
  evidence.summary={confirmations:D,case1a:'shallow rollback below the burn depth: burn canonical, confirmations re-counted, still refused, no incident',case1b:'rollback deeper than the burn but below D, before payout: detected (burnVanished), paused, re-mined, resume, refused at D-1, paid once at D of the new height',case2:'at depth: refused at D-1, paid at D',case3:'beyond depth before payout: detected, paused, nothing paid, backing intact, paid once after fresh D',case4:'beyond depth AFTER payout: LOSS preserved (paidWithoutBurn, halted, shortfall = paid amount); no reserve or insurance claimed',limits:'controlled rollbacks on an offline chain; a mined heavier fork, network partitions and real reorganisation probabilities are not modelled'};
 }finally{await backend.close();await mkdir(dir+'settlement/evidence',{recursive:true});await writeFile(dir+'settlement/evidence/payout-depth-policy-20-'+new Date().toISOString().slice(0,10)+'.json',JSON.stringify(evidence,null,1));await writeFile(dir+'runs/payout-depth-policy-results.json',JSON.stringify(evidence,null,1));}
});
