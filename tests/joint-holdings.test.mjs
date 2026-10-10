import test from 'node:test';import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {createJointHoldings,jointHoldingRow,replaceHoldingSource,isJointHolding} from '../src/joint-holdings.js';
import {PRIVATE_TEST_POLICY as policy} from '../bridge/core-transferable/private-test.mjs';
import {transferableManifest} from '../bridge/core-transferable/mainnet-config.mjs';
import {addresses} from '../bridge/core-transferable/sdk.mjs';
import {digest,commitment} from '../bridge/core-transferable/records.mjs';
import {tokenGroups} from '../src/token-display.js';
const account={sol:policy.owner,xmr:policy.moneroOwner},asset={mint:policy.mint,name:'XMR20',symbol:'XMR20'},manifest=transferableManifest(asset.mint),config={...manifest,owner:account.sol,binding:digest(account.xmr)},position=addresses(config).position.toBase58(),at=Date.now();
function fixture(){
 const link={record:{p:'xmr20-joint',v:3,net:'mainnet',op:'link',program:manifest.program,mint:asset.mint,owner:account.xmr,to:account.sol,nonce:'a1'.repeat(32)},signature:'SigV2'+'1'.repeat(90)},credit={record:{op:'credit',program:manifest.program,mint:asset.mint,owner:account.xmr,amount:'985000'}};
 const report={schema:'joint-index-v3',complete:true,manifest,privateTestPolicy:policy,positions:[{config,position,moneroOwner:account.xmr,solanaOwner:account.sol,linkTxid:'ab'.repeat(32),balance:'985000',chainBalance:'985000',available:'985000'}],accepted:[{txid:'ab'.repeat(32),envelope:link},{txid:'cd'.repeat(32),envelope:credit}]};
 return {report,link};
}
function data(report,link){const b=Buffer.alloc(169);b[0]=3;new PublicKey(account.sol).toBuffer().copy(b,1);new PublicKey(manifest.verifier).toBuffer().copy(b,33);new PublicKey(asset.mint).toBuffer().copy(b,65);Buffer.from(config.binding,'hex').copy(b,97);Buffer.from(commitment(link),'hex').copy(b,129);b.writeBigUInt64LE(BigInt(report.positions[0].chainBalance),161);return b;}
function setup({snapshot,readAccount,verifyProgram,now=()=>at,storage}={}){
 const f=fixture(),disk=new Map();let calls=0,reads=0,checks=0;
 const store=storage??{getItem:k=>disk.get(k)??null,setItem:(k,v)=>disk.set(k,v)};
 const c=createJointHoldings({privateTest:true,storage:store,now,adapters:{runtime:()=>({snapshot:async()=>{calls++;return snapshot?await snapshot(f.report):f.report;}}),chain:()=>({verifyProgram:async()=>{checks++;if(verifyProgram)await verifyProgram();},readAccount:async key=>{reads++;assert.equal(key,position);return readAccount?await readAccount():{owner:manifest.program,finalized:true,executable:false,data:data(f.report,f.link)};}})}});
 return {...f,c,disk,store,get calls(){return calls;},get reads(){return reads;},get checks(){return checks;}};
}
test('confirmed credit becomes one Monero row with the net amount and exact paired wallet',()=>{
 const {report}=fixture(),row=jointHoldingRow(report,account,asset,{privateTest:true,now:at});assert.equal(row.amountRaw,'985000');assert.equal(row.stale,false);assert.equal(row.network,'monero');assert.equal(row.position,position);assert.equal(row.receipt.url,'https://xmrchain.net/tx/'+'cd'.repeat(32));assert.ok(isJointHolding(row));
 const sol={network:'solana',mint:asset.mint,amountRaw:'10000000'};assert.deepEqual(tokenGroups([sol,row]).map(g=>g.items[0].row.amountRaw),['985000','10000000']);
});
test('partial history, wrong policy/account/mint, missing link and inflated available amounts cannot create a balance',()=>{
 for(const change of [r=>r.complete=false,r=>r.manifest={...manifest,mint:'bad'},r=>r.privateTestPolicy=null,r=>r.positions[0].solanaOwner='bad',r=>r.positions.push(r.positions[0]),r=>r.positions[0].available='1000000',r=>r.accepted.shift(),r=>r.accepted.pop(),r=>r.positions[0].config={...config,binding:'ab'.repeat(32)}]){const {report}=fixture();change(report);assert.throws(()=>jointHoldingRow(report,account,asset,{privateTest:true}));}
});
test('pending custody credit is not shown until native replay makes it available',()=>{
 const {report}=fixture();report.positions[0].balance='0';report.positions[0].available='0';report.accepted.pop();assert.equal(jointHoldingRow(report,account,asset,{privateTest:true}),null);
});
test('reader verifies deployment and matching finalized custody, then persists display-only public history',async()=>{
 const f=setup(),result=await f.c.load(account);assert.equal(result.complete,true);assert.equal(result.rows[0].amountRaw,'985000');assert.equal(f.checks,1);assert.equal(f.reads,1);assert.equal(f.c.cached(account)[0].stale,true);
 const saved=JSON.parse([...f.disk.values()][0]);assert.deepEqual(Object.keys(saved).sort(),['mint','report','savedAt','sol','xmr']);
});
test('changed custody or program failure cannot be displayed as a current balance',async()=>{
 for(const options of [{verifyProgram:async()=>{throw Error('Changed code');}},{readAccount:async()=>null},{readAccount:async()=>({owner:manifest.program,executable:true,finalized:true,data:Buffer.alloc(169)})}]){const f=setup(options),r=await f.c.load(account);assert.equal(r.complete,false);assert.deepEqual(r.rows,[]);assert.equal(f.disk.size,0);}
});
test('concurrent refreshes share one read and a slow read does not cause immediate repeated scans',async()=>{
 let release,time=at;const f=setup({now:()=>time,snapshot:r=>new Promise(resolve=>release=()=>resolve(r))});
 const first=f.c.load(account),second=f.c.load(account);await new Promise(r=>setImmediate(r));assert.equal(f.calls,1);time+=90000;release();await Promise.all([first,second]);await f.c.load(account);assert.equal(f.calls,1);
});
test('a restarted wallet shows old data as last-known and does not read another private account',async()=>{
 const f=setup();await f.c.load(account);const next=setup({storage:f.store});assert.equal(next.c.cached(account)[0].stale,true);
 const other={...account,sol:manifest.verifier};assert.deepEqual(next.c.cached(other),[]);assert.deepEqual((await next.c.load(other)).rows,[]);assert.equal(next.calls,0);
});
test('outage retains only marked last-known data and a fresh zero removes it',async()=>{
 let time=at,mode='good';const f=setup({now:()=>time,snapshot:r=>{if(mode==='fail')throw Error('Offline');if(mode==='zero'){r.positions[0].available='0';r.positions[0].balance='0';r.positions[0].chainBalance='0';}return r;}});
 await f.c.load(account);time+=61000;mode='fail';let r=await f.c.load(account);assert.equal(r.complete,false);assert.equal(r.rows[0].stale,true);
 time+=61000;mode='zero';r=await f.c.load(account);assert.equal(r.complete,true);assert.deepEqual(r.rows,[]);assert.deepEqual(f.c.cached(account),[]);
});
test('clearing account state discards a late positive result and prevents display-cache writes',async()=>{
 let release;const f=setup({snapshot:r=>new Promise(resolve=>release=()=>resolve(r))});const pending=f.c.load(account);await new Promise(r=>setImmediate(r));f.c.clear();release();assert.equal((await pending).complete,false);assert.equal(f.disk.size,0);
});
test('independent index updates preserve the other bridge and never duplicate an existing new position',()=>{
 const joint=jointHoldingRow(fixture().report,account,asset,{privateTest:true}),legacy={network:'monero',mint:asset.mint,amountRaw:'2'},sol={network:'solana',mint:asset.mint,amountRaw:'9'};
 let rows=replaceHoldingSource([joint,sol],[legacy],{network:'monero'});assert.deepEqual(rows,[joint,sol,legacy]);rows=replaceHoldingSource(rows,[joint],{bridge:asset.mint});assert.equal(rows.length,3);assert.equal(rows.filter(isJointHolding).length,1);
 rows=replaceHoldingSource(rows,[],{bridge:asset.mint});assert.deepEqual(rows,[sol,legacy]);
});
