// REPLAY EQUIVALENCE: an indexer that followed the chain incrementally (scan after every phase, including through a
// rollback) must report byte-identical public state to a FRESH indexer started afterwards (clean replay from the pool start),
// at the same canonical tip. Also: indexer restart (new process) and a rollback that removes mined records.
// Offline zero-peer fakechain; lab issuer + indexers bound to the trusted test-v1 manifest; holders via wallet-lib.
// What "state" means here: the indexer's public view {tip, tipHash, state (pool summary: supply, nullifiers, record counts),
// events (canonical admission/rejection events in chain order)}. Canonical ordering = chain order (block height, tx order).
// Known limitation (documented in CONFORMANCE.txt): the lab indexer is stateless per process (it rebuilds from the chain on
// every scan), so "database corruption" cannot occur in it; the stateful component is the operator journal, covered by
// operator-journal-corruption.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {startRoles,startFakechain,closeFetch,daemonRpc} from '../stagenet/roles.mjs';
import {startParamServer} from '../stagenet/param-server.mjs';
import {openPrivateWallet,memoryCache} from '../wallet-lib/private-wallet.mjs';
const dir=fileURLToPath(new URL('../',import.meta.url));
const PORTS={rpcPort:30079,p2pPort:30078,paramPort:8958};
const canon=o=>JSON.stringify(o,Object.keys(o).sort());
const digest=pub=>createHash('sha256').update(canon({tip:pub.tip,tipHash:pub.tipHash,state:pub.state,events:pub.events})).digest('hex');
test('clean replay == incremental indexing at the same canonical height; restart; rollback',{timeout:1800000},async()=>{
 const run=await mkdtemp(path.join(dir,'runs','replay-equivalence-'));const own=[];const evidence={execution:'SIMULATED (offline fakechain)',phases:[]};
 try{
  const chain=await startFakechain({...PORTS,dir:run+'/chain'});own.push(chain);
  const paramsDir=path.join(dir,'params/test-v1');const manifestPath=path.join(paramsDir,'manifest.json');const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  const ps=await startParamServer({dir:paramsDir,port:PORTS.paramPort});own.push(ps);
  const wasm=await WebAssembly.compile(await readFile(dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm'));
  // Incremental indexer (I1) and the issuer live for the whole run.
  const roles=await startRoles({paramsDir,trustedManifest:manifestPath,rpcUrl:chain.rpcUrl,runDir:run+'/roles-1'});own.push(roles);
  const freshIndexer=async(tag)=>{const r=await startRoles({paramsDir,trustedManifest:manifestPath,rpcUrl:chain.rpcUrl,runDir:run+'/roles-'+tag,roles:['indexer']});own.push(r);return r;};
  const open=async(root)=>openPrivateWallet({wasm,manifest,daemonRpc:chain.rpcUrl,parameterServer:ps.url,cache:memoryCache(),fetch:closeFetch,root});
  const A=await open(randomBytes(32).toString('hex')),B=await open(randomBytes(32).toString('hex'));
  await chain.mine(roles.issuerNativeAddress,5);await chain.mine(A.nativeAddress(),3);await chain.mine(B.nativeAddress(),3);await chain.mine(roles.issuerNativeAddress,250);
  await roles.issuerScan();const asset=await roles.assetId('uxmr20private-rehearsal');
  const compare=async(label)=>{const inc=await roles.indexerScan();const fresh=await freshIndexer(label);const clean=await fresh.indexerScan();await fresh.close();own.splice(own.indexOf(fresh),1);
   assert.equal(clean.tip,inc.tip,label+': same tip');assert.equal(clean.tipHash,inc.tipHash,label+': same tip hash');
   const dInc=digest(inc),dClean=digest(clean);assert.equal(dClean,dInc,label+': clean replay differs from incremental state');
   evidence.phases.push({label,tip:inc.tip,tipHash:inc.tipHash,stateDigest:dInc,events:inc.events.length,state:inc.state});return inc;};
  // Phase 1: credits (issuer-funded XB3) to A and B.
  const credits=[];for(const [to,amount] of [[A.address(),'5000000'],[A.address(),'3000000'],[B.address(),'2000000']]){credits.push(await roles.credit({to,asset,amount,binding:randomBytes(32).toString('hex')}));await chain.mine(roles.issuerNativeAddress,11);}
  await A.sync();await B.sync();assert.equal(A.status().balances[asset],'8000000');assert.equal(B.status().balances[asset],'2000000');
  const p1=await compare('after-credits');assert.ok(p1.events.length>=3,'credit events admitted');
  // Phase 2: transfers A->B (two inputs, exact change) and B->A.
  const send=async(from,to,amount)=>{const q=await from.quoteCarrier({kind:'send'});const sel=from.select({asset,amount});const built=await from.prove({kind:'send',to:to.address(),amount,notes:sel.notes});const s=from.signCarrier(q.quoteId,built.wire);const r=await from.publish(s.blob);assert.equal(r.ok,true);return {txid:s.txid,recordId:built.recordId,inputs:built.inputs,blob:s.blob,fee:String(s.fee)};};
  const t1=await send(A,B,'6000000');await chain.mine(roles.issuerNativeAddress,11);await A.sync();await B.sync();
  const t2=await send(B,A,'1000000');await chain.mine(roles.issuerNativeAddress,11);await A.sync();await B.sync();
  assert.equal(A.status().balances[asset],'3000000');assert.equal(B.status().balances[asset],'7000000');
  const p2=await compare('after-transfers');assert.equal(t1.inputs,2,'A spent two notes with exact change');
  // Phase 3: indexer RESTART (new process) must equal the incremental one.
  const restarted=await freshIndexer('restart');const rs=await restarted.indexerScan();assert.equal(digest(rs),digest(p2),'restarted indexer equals incremental');await restarted.close();own.splice(own.indexOf(restarted),1);
  // Phase 4: ROLLBACK removing t2's block and more (12 blocks), pool flushed: both incremental and clean views must drop t2's
  // record; then t2's SAME carrier is re-sent and re-mined; states converge again.
  const tipBefore=(await daemonRpc(chain.rpcUrl,'get_info')).height-1;const r=await closeFetch(chain.rpcUrl+'/pop_blocks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nblocks:12})});assert.equal((await r.json()).status,'OK');await daemonRpc(chain.rpcUrl,'flush_txpool',{txids:[]});
  const tipAfter=(await daemonRpc(chain.rpcUrl,'get_info')).height-1;assert.equal(tipAfter,tipBefore-12);
  const p3=await compare('after-rollback');assert.ok(!p3.events.some(e=>e.txid===t2.txid||e.recordId===t2.recordId),'t2 no longer in canonical events');assert.ok(p3.events.some(e=>e.txid===t1.txid||e.recordId===t1.recordId),'t1 still canonical');
  await A.sync();await B.sync();assert.equal(B.status().balances[asset],'8000000','B’s spend reverted (notes unspent again)');
  // Re-send the same signed carrier for t2 (no new fee) and converge.
  const look=await B.lookup(t2.txid);assert.equal(look.known,false,'daemon no longer knows t2 after pop+flush');
  const pub2=await B.publishWithRecovery(t2.blob,t2.txid);assert.equal(pub2.ok,true,'the SAME signed carrier is accepted again (no new carrier, no new fee)');
  await chain.mine(roles.issuerNativeAddress,11);await A.sync();await B.sync();assert.equal(B.status().balances[asset],'7000000','t2 canonical again after the re-send');
  const p4=await compare('after-rollback-resend');assert.ok(p4.events.some(e=>e.txid===t2.txid||e.recordId===t2.recordId),'t2 admitted again at its new height');
  evidence.rollback={popped:12,from:tipBefore,to:tipAfter,t2KnownAfterFlush:look.known,resent:{ok:pub2.ok,resends:pub2.resends,recovered:pub2.recovered},t2NewHeight:p4.events.find(e=>e.txid===t2.txid||e.recordId===t2.recordId)?.height??null};
  evidence.result='PASSED';evidence.transfers={t1,t2};evidence.credits=credits.map(c=>c.txid);
  A.close();B.close();
 }finally{for(const o of own.reverse())await o.close().catch(()=>{});await mkdir(dir+'conformance/evidence',{recursive:true});await writeFile(dir+'conformance/evidence/indexer-replay-equivalence-'+new Date().toISOString().slice(0,10)+'.json',JSON.stringify(evidence,null,1));}
});
