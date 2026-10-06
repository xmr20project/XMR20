import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {discoverAndCalculate,calculate,readClient} from '../build/ledger.mjs';
import {fixture} from './fixture.mjs';
import {PROGRAMS} from '../src/accounting.mjs';
import {addresses} from '../src/escrow.mjs';

function chainFixture(version=3){
 const f=fixture(version),map=new Map(),manifests=[];
 const loader=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
 for(const v of [1,2,3]){
  const g=fixture(v),p=g.input.solana.programs[0];manifests.push(...g.options.manifests);
  map.set(p.programId,p.program);map.set(PublicKey.findProgramAddressSync([new PublicKey(p.programId).toBuffer()],loader)[0].toBase58(),p.programData);
 }
 const t=f.input.solana.tokens[0],read=t.accountReads[0];
 read.keys.forEach((k,i)=>map.set(k,read.value[i]));
 const calls=[];
 const rpc=async(method,params=[])=>{
  calls.push({method,params});
  if(method==='getGenesisHash')return f.input.solana.genesisHash;
  if(method==='getProgramAccounts')return structuredClone(t.enumeration);
  if(method==='getMultipleAccounts')return {context:{slot:500},value:params[0].map(k=>structuredClone(map.get(k)??null))};
  throw Error('Unexpected method; no catalog or transaction access');
 };
 const input={schemaVersion:1,policy:f.input.policy,scanStartHeight:100,scan:f.input.scan,checkpoint:f.input.checkpoint};
 return {f,input,map,rpc,calls,options:{manifests}};
}
for(const v of [1,2,3])test('discovers V'+v+' from chain accounts without any token catalog',async()=>{
 const c=chainFixture(v),r=await discoverAndCalculate(c.input,c.rpc,c.options);
 assert.equal(r.catalog.length,1);assert.equal(r.catalog[0].id,c.f.launch.moneroTxid);
 assert.equal(r.catalog[0].bridgeVersion,v);assert.equal(r.snapshots[0].moneroRaw,'1000');
 assert.equal(r.snapshots[0].solanaRaw,'9000');assert.equal(r.discoverySource,'chain');
 assert.match(r.verification.sourceSha256,/^[a-f0-9]{64}$/);
 assert.deepEqual([...new Set(c.calls.map(c=>c.method))].sort(),['getGenesisHash','getMultipleAccounts','getProgramAccounts']);
 const old=await calculate(c.f.input,c.rpc,c.f.options);
 assert.deepEqual(r.snapshots[0].holders,old.snapshots[0].holders);
 assert.deepEqual(r.accepted,old.accepted);
});
test('arbitrary primary listing flags cannot hide a chain-discovered token',async()=>{
 const c=chainFixture();c.input.projection={launches:[{...c.f.launch,hidden:true,halted:true,cancelledAt:1}]};
 const r=await discoverAndCalculate(c.input,c.rpc,c.options);assert.equal(r.snapshots.length,1);
});
test('missing escrow with an operator credit fails closed',async()=>{
 const c=chainFixture();c.map.delete(c.f.a.config.toBase58());
 await assert.rejects(discoverAndCalculate(c.input,c.rpc,c.options),/credit-without-escrow/);
});
test('a declaration without escrow and credits is unbound, not a zero-balance claim',async()=>{
 const c=chainFixture();c.map.delete(c.f.a.config.toBase58());c.input.scan.events=c.input.scan.events.slice(0,1);
 const r=await discoverAndCalculate(c.input,c.rpc,c.options);assert.equal(r.unbound.length,1);assert.equal(r.snapshots.length,0);
 assert.equal(r.catalog[0].state,'unbound');assert.equal(r.unbound[0].amountRaw,undefined);
});
test('multiple matching escrow programs are rejected instead of guessed',async()=>{
 const c=chainFixture(),g=fixture(2);c.map.set(g.a.config.toBase58(),g.input.solana.tokens[0].accountReads[0].value[1]);
 await assert.rejects(discoverAndCalculate(c.input,c.rpc,c.options),/ambiguous-escrow/);
});
test('binding cannot change between discovery and the exact accounting slot',async()=>{
 const c=chainFixture(),g=fixture(2);let enumerated=false;
 const rpc=async(m,p)=>{if(m==='getProgramAccounts')enumerated=true;if(enumerated)c.map.set(g.a.config.toBase58(),g.input.solana.tokens[0].accountReads[0].value[1]);return c.rpc(m,p);};
 await assert.rejects(discoverAndCalculate(c.input,rpc,c.options),/ambiguous-escrow/);
});
test('a config pointing to another deployment is rejected',async()=>{
 const c=chainFixture(),raw=c.map.get(c.f.a.config.toBase58()),b=Buffer.from(raw.data[0],'base64');b[97]^=1;raw.data[0]=b.toString('base64');
 await assert.rejects(discoverAndCalculate(c.input,c.rpc,c.options),/config-binding/);
});
test('checkpoint mismatch is rejected before discovery',async()=>{
 const c=chainFixture();c.input.checkpoint.height++;
 await assert.rejects(discoverAndCalculate(c.input,c.rpc,c.options),/checkpoint/);
});
test('own loopback RPC is supported; unencrypted remote RPC is rejected',async()=>{
 assert.equal(typeof readClient('http://127.0.0.1:8899'),'function');
 assert.throws(()=>readClient('http://example.com:8899'),/rpc-url/);
 assert.throws(()=>readClient('https://user:password@example.com'),/rpc-url/);
});
test('published historical exclusion policy is honored, including associated credits',async()=>{
 const c=chainFixture();c.input.policy.abandonedLaunches=[{txid:c.f.launch.moneroTxid,mint:c.f.launch.mint,ticker:c.f.launch.ticker}];
 const r=await discoverAndCalculate(c.input,c.rpc,c.options);assert.equal(r.catalog.length,0);assert.equal(r.accepted.deployments,0);assert.equal(r.accepted.credits,0);
});
