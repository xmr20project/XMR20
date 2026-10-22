// Digest guards must always describe the exact committed ledger, including
// failed asynchronous admission and fork recovery. Public synthetic fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PrototypeIndex} from './replay.mjs';
import {hash} from './bytes.mjs';
import {fundedIndex,sale,observation,append,label} from './test-fixtures.mjs';

const exact=index=>{
 const {height,blockHash,issued,burned}=index.snapshot();
 assert.deepEqual(index.accountingSummary(),{height,blockHash,issued,burned});
 const expected=hash(index.canonicalState()).toString('hex');
 for(let i=0;i<4;i++)assert.equal(index.stateHash(),expected);
 return expected;
};
test('digest follows committed empty/native/token blocks and exact rewind branches',()=>{
 const {index,credit,manifest}=fundedIndex(),base=index.checkpoint(),before=exact(index);
 const move=sale(credit,manifest);append(index,[observation(move,200n)]);
 const moved=exact(index);assert.notEqual(moved,before);
 append(index);assert.notEqual(exact(index),moved);
 index.rewind(base.height,base.blockHash);assert.equal(exact(index),before);
 const burn=sale(credit,manifest,{op:'BURN',allocations:[],amount:1000n,recipient:label('digest return'),redemption:label('digest burn')});
 append(index,[observation(burn,200n)]);assert.notEqual(exact(index),moved);
 index.rewind(base.height,base.blockHash);assert.equal(exact(index),before);
});
test('in-flight and failed asynchronous policy retain only the committed digest',async()=>{
 const {index,credit,manifest}=fundedIndex(),base=index.checkpoint(),before=exact(index),move=sale(credit,manifest);
 const block={height:base.height+1n,parent:base.blockHash,hash:label('digest async block'),transactions:[observation(move,200n)]};
 let seen=false;
 await assert.rejects(index.applyBlockWithPolicy(block,{
  beforeTransaction:async()=>{seen=true;assert.equal(exact(index),before);await Promise.resolve();},
  authorizeRecord:async()=>{assert.equal(exact(index),before);return true;},
  afterTransaction:async()=>{assert.equal(exact(index),before);throw Error('public fixture admission unavailable');}
 }),/admission unavailable/);
 assert.ok(seen);assert.equal(exact(index),before);assert.deepEqual(index.checkpoint(),base);
 await index.applyBlockWithPolicy(block,{beforeTransaction:async()=>{},authorizeRecord:async()=>true,afterTransaction:async()=>{}});
 assert.notEqual(exact(index),before);
});
test('restored state and detached public values cannot change a committed digest',()=>{
 const {index}=fundedIndex(),envelope=index.exportCheckpoint(),restored=PrototypeIndex.fromAuthenticatedCheckpoint(index.manifest,envelope,index.checkpoint());
 const before=exact(restored);assert.equal(before,exact(index));
 envelope.state.fill(0);restored.canonicalState().fill(0);const snapshot=restored.snapshot();
 snapshot.height++;snapshot.lots.clear();snapshot.spends.clear();snapshot.transactions.clear();
 const summary=restored.accountingSummary();summary.height++;summary.issued++;
 assert.equal(exact(restored),before);append(restored);assert.notEqual(exact(restored),before);
});
