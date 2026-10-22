import test from 'node:test';
import assert from 'node:assert/strict';
import {EXPIRING_CREDIT_PROFILE,OFFLINE_RECEIVER_PROFILE,manifestId} from './records.mjs';
import {PrototypeIndex} from './replay.mjs';
import {fixtureManifest,creditRecord,authorize,observation,label,sale,ZERO} from './test-fixtures.mjs';
const manifest=()=>({...fixtureManifest(),profile:EXPIRING_CREDIT_PROFILE,identity:0xfc});
const credit=(m,epoch=3)=>authorize({...creditRecord(m),epoch,image:ZERO,c:ZERO,s:ZERO},{},[],{preserveRecipientProofs:true});
function block(index,transactions=[]){
 const s=index.snapshot(),height=s.height+1n;
 return index.applyBlock({height,hash:label('expiring credit '+height),parent:s.blockHash,transactions});
}
test('S5 has a separate identity; credit expiry never changes S4 authorization',()=>{
 const m=manifest();assert.notEqual(manifestId(m),manifestId({...m,profile:OFFLINE_RECEIVER_PROFILE}));
 const old={...m,profile:OFFLINE_RECEIVER_PROFILE},i=new PrototypeIndex(old);
 assert.equal(block(i,[observation(credit(old,3))])[0].status,'rejected');
 assert.equal(block(new PrototypeIndex(old),[observation(credit(old,0))])[0].status,'accepted');
});
test('creation is permitted through its inclusive deadline and refused afterwards',()=>{
 for(const height of [2,3,4]){
  const m=manifest(),i=new PrototypeIndex(m);while(i.snapshot().height<BigInt(height-1))block(i);
  const result=block(i,[observation(credit(m))])[0];
  assert.equal(result.status,height<=3?'accepted':'rejected');
  assert.equal(i.snapshot().issued,height<=3?1000n:0n);
 }
});
test('already-created tokens survive the entry deadline and transfer without Solana',()=>{
 const m=manifest(),i=new PrototypeIndex(m),c=credit(m);
 assert.equal(block(i,[observation(c)])[0].status,'accepted');
 while(i.snapshot().height<12n)block(i);
 const send=sale(c,m,{allocations:[{vout:0,amount:1000n}]});
 assert.equal(block(i,[observation(send,200n)])[0].status,'accepted');
 assert.equal(i.snapshot().issued,1000n);assert.equal(i.snapshot().consumed.size,1);
});
