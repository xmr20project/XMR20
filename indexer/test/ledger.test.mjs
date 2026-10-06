import test from 'node:test';
import assert from 'node:assert/strict';
import {calculate,readClient} from '../build/ledger.mjs';
import {fixture} from './fixture.mjs';
function rpcFor(f,change=()=>{}){
  return async(method,params)=>{
    if(method==='getGenesisHash')return f.input.solana.genesisHash;
    if(method==='getProgramAccounts')return structuredClone(f.input.solana.tokens[0].enumeration);
    if(method==='getMultipleAccounts'){
      if(params[0].length===2){const p=f.input.solana.programs[0];return {context:{slot:p.slot},value:[p.program,p.programData]};}
      const r=structuredClone(f.input.solana.tokens[0].accountReads[0]);change(r);return r;
    }
    throw Error('Unexpected RPC');
  };
}
for(const v of [1,2,3])test('independent replay reconciles raw V'+v+' accounts and exact receipts',async()=>{
  const f=fixture(v),result=await calculate(f.input,rpcFor(f),f.options);
  assert.equal(result.snapshots[0].moneroRaw,'1000');assert.equal(result.snapshots[0].solanaRaw,'9000');
  assert.equal(result.accepted.transfers,2);assert.equal(result.accepted.credits,1);
});
test('moving Solana contexts never publish mixed account states',async()=>{const f=fixture();await assert.rejects(calculate(f.input,rpcFor(f,r=>r.context.slot++),f.options),/solana-context-changing/)});
test('wrong deposit backing is rejected',async()=>{const f=fixture();f.input.solana.tokens[0].accountReads[0].value[3].owner=f.holder.toBase58();await assert.rejects(calculate(f.input,rpcFor(f),f.options),/receipt-owner/)});
test('RPC transport rejects transactions before fetch',async()=>{const rpc=readClient('https://example.invalid',()=>{throw Error('network must not run')});await assert.rejects(rpc('sendTransaction',[]),/rpc-method/)});

for(const [name,edit,category] of [
 ['missing holder account',f=>f.input.solana.tokens[0].enumeration.value.pop(),'enumeration-incomplete'],
 ['duplicate holder account',f=>f.input.solana.tokens[0].enumeration.value.push(f.input.solana.tokens[0].enumeration.value[0]),'duplicate-token-account'],
 ['wrong confirmation count',f=>f.input.scan.events[1].confirmations++,'event-checkpoint'],
 ['duplicate Monero carrier',f=>f.input.scan.events[1].txid=f.input.scan.events[0].txid,'duplicate-event'],
 ['out of order events',f=>f.input.scan.events.reverse(),'event-order'],
 ['mutable bridge program',f=>{const r=f.input.solana.programs[0].programData,b=Buffer.from(r.data[0],'base64');b[12]=1;r.data[0]=b.toString('base64');},'program-immutable'],
 ['different bridge binary',f=>{const r=f.input.solana.programs[0].programData,b=Buffer.from(r.data[0],'base64');b[45]^=1;r.data[0]=b.toString('base64');},'program-binary'],
 ['wrong deployment binding',f=>{const r=f.input.solana.tokens[0].accountReads[0].value[1],b=Buffer.from(r.data[0],'base64');b[97]^=1;r.data[0]=b.toString('base64');},'escrow-binding'],
 ['missing catalog binding',f=>f.input.projection.launches=[],'unbound-credited-mint']
])test(name+' rejects fabricated or incomplete evidence',async()=>{
 const f=fixture();edit(f);await assert.rejects(calculate(f.input,rpcFor(f),f.options),new RegExp(category));
});
