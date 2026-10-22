// Public, unfunded fixtures only. Checkpoint authentication and canonical chain
// ancestry are separate wallet-layer requirements; these tests exercise codec
// rejection and equivalence, never treat a state hash as a consensus proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PrototypeIndex, TOKEN_CHECKPOINT_CODEC_VERSION, TOKEN_CHECKPOINT_VERIFICATION_VERSION,
  MAX_TOKEN_CHECKPOINT_BYTES, MAX_TOKEN_CHECKPOINT_ROWS} from './replay.mjs';
import {Buffer} from 'buffer';
import {Reader, domain, hash, uint} from './bytes.mjs';
import {manifestId, OFFLINE_RECEIVER_PROFILE, EXPIRING_CREDIT_PROFILE} from './records.mjs';
import {fixtureManifest, fundedIndex, sale, authorize, creditRecord, claimFor, observation, append, label, key, keyImage, ZERO} from './test-fixtures.mjs';

const restore = (index, envelope = index.exportCheckpoint()) => PrototypeIndex.fromAuthenticatedCheckpoint(index.manifest, envelope, index.checkpoint());
const same = (a, b) => { assert.deepEqual(a.canonicalState(), b.canonicalState()); assert.equal(a.stateHash(), b.stateHash()); assert.deepEqual(a.snapshot(), b.snapshot()); };
function changed(envelope, edit, rehash = true) {
  const copy = {...envelope, checkpoint: {...envelope.checkpoint}, state: Buffer.from(envelope.state)};
  edit(copy); if (rehash) copy.stateHash = hash(copy.state).toString('hex'); return copy;
}
function layout(state) {
  const r = new Reader(state), size = domain('XN1-LOCAL-S2-STATE').length;
  const fields = {height: size + 1 + 32, issued: size + 1 + 32 + 8 + 32};
  fields.burned = fields.issued + 8; fields.reserved = fields.burned + 8;
  r.take(fields.reserved + 8 + 1); const tables = [];
  for (let id = 1; id <= 8; id++) {
    const at = r.at; assert.equal(r.u(1), id); const countAt = r.at, count = Number(r.u(8)), rows = [];
    for (let i = 0; i < count; i++) { const prefix = r.at, length = r.u(4), data = r.at; r.take(length); rows.push({prefix, data, length}); }
    tables[id] = {at, countAt, rows};
  }
  r.done(); return {fields, tables};
}

test('checkpoint restores exact state and future credit, move, native spends, burn and rewind behavior', () => {
  const {index, manifest, credit} = fundedIndex(), base = index.checkpoint(), resumed = restore(index);
  same(index, resumed); assert.equal(resumed.rewindWindow().retainedBlocks, 0);
  assert.throws(() => resumed.rewind(manifest.height, manifest.blockHash), /rebuild required/);
  resumed.rewind(base.height, base.blockHash); same(index, resumed);
  assert.throws(() => resumed.rewind(base.height, label('wrong ancestor')), /rebuild required/);
  const additional=authorize(creditRecord(manifest,{issuance:label('issue-2'),lock:label('lock-2'),image:keyImage(31)}),{serial:3,outputKeys:[key(31),key(32)]});
  assert.deepEqual(append(index,[observation(additional,300n)]),append(resumed,[observation(additional,300n)]));same(index,resumed);same(index,restore(index));
  const move = sale(credit, manifest);
  assert.deepEqual(index.previewTransaction(move.bytes), resumed.previewTransaction(move.bytes));
  assert.deepEqual(append(index, [observation(move, 200n)]), append(resumed, [observation(move, 200n)])); same(index, resumed);
  same(index, restore(index));
  index.rewind(base.height, base.blockHash); resumed.rewind(base.height, base.blockHash); same(index, resumed);
  const burn = sale(credit, manifest, {op:'BURN', allocations:[], amount:1000n, recipient:label('return destination'), redemption:label('return id')});
  assert.deepEqual(append(index, [observation(burn, 200n)]), append(resumed, [observation(burn, 200n)])); same(index, resumed); same(index, restore(index));
  index.rewind(base.height, base.blockHash); resumed.rewind(base.height, base.blockHash);
  const invalid = sale(credit, manifest, {allocations:[{vout:0,amount:999n}]});
  const before = index.snapshot(); assert.equal(append(index, [observation(invalid, 200n)])[0].status, 'rejected'); append(resumed, [observation(invalid, 200n)]);
  same(index, resumed); same(index, restore(index)); assert.equal(index.snapshot().lots.size, before.lots.size); assert.ok(index.snapshot().spends.has(keyImage(11)));
});

test('empty and offline-recipient checkpoints retain their supported manifest semantics', () => {
  const empty = new PrototypeIndex(fixtureManifest()); same(empty, restore(empty));
  for (const profile of [OFFLINE_RECEIVER_PROFILE, EXPIRING_CREDIT_PROFILE]) {
    const manifest = {...fixtureManifest(), profile, identity:0xfc}, index = new PrototypeIndex(manifest);
    const credit = authorize({...creditRecord(manifest), ...(profile === EXPIRING_CREDIT_PROFILE ? {epoch:30} : {}), image:ZERO,c:ZERO,s:ZERO}, {}, [], {preserveRecipientProofs:true});
    assert.equal(append(index, [observation(credit)])[0].status, 'accepted'); same(index, restore(index));
  }
});

test('deferred lots cannot reuse one revealed spend image for two consumed sources',()=>{
  const manifest={...fixtureManifest(),profile:OFFLINE_RECEIVER_PROFILE,identity:0xfc},index=new PrototypeIndex(manifest);
  const deferred=(n,start)=>authorize({...creditRecord(manifest),issuance:label('deferred issue '+n),lock:label('deferred lock '+n),image:ZERO,c:ZERO,s:ZERO},
    {serial:n,outputKeys:[key(start),key(start+1)]},[],{preserveRecipientProofs:true});
  const a=deferred(1,11),b=deferred(3,31);append(index,[observation(a,100n)]);append(index,[observation(b,200n)]);
  while(index.checkpoint().height<11n)append(index);
  const move=authorize({op:'MOVE',manifest:manifestId(manifest),claims:[claimFor(a.txid),claimFor(b.txid,{vin:1})],allocations:[{vout:0,amount:2000n,image:ZERO,c:ZERO,s:ZERO}]},
    {serial:5,outputKeys:[key(61),key(62)],inputs:[{keyImage:keyImage(11),offsets:Array.from({length:16},(_,i)=>100n+BigInt(i))},{keyImage:keyImage(31),offsets:Array.from({length:16},(_,i)=>200n+BigInt(i))}]},[11n,31n],{preserveRecipientProofs:true});
  assert.equal(append(index,[observation(move,300n)])[0].status,'accepted');same(index,restore(index));
  const envelope=index.exportCheckpoint(),rows=layout(envelope.state).tables[2].rows;
  const malformed=changed(envelope,e=>e.state.copy(e.state,rows[1].data+69,rows[0].data+69,rows[0].data+101));
  assert.throws(()=>restore(index,malformed),/consumed lot provenance/);
});

test('checkpoint metadata, versions, private checkpoint and state hash must match exactly', () => {
  const {index} = fundedIndex(), envelope = index.exportCheckpoint();
  assert.equal(envelope.codecVersion, TOKEN_CHECKPOINT_CODEC_VERSION); assert.equal(envelope.verificationVersion, TOKEN_CHECKPOINT_VERIFICATION_VERSION);
  for (const edit of [e=>e.codecVersion++, e=>e.verificationVersion++, e=>e.manifest=label('foreign manifest'), e=>e.genesis=label('foreign genesis'),
    e=>e.extra=true, e=>e.checkpoint.height='010', e=>e.checkpoint.height=10n, e=>e.checkpoint.blockHash=label('other fork'), e=>e.stateHash=label('wrong state')]) {
    assert.throws(() => restore(index, changed(envelope, edit, false)));
  }
  assert.throws(() => PrototypeIndex.fromAuthenticatedCheckpoint(index.manifest, envelope, {...index.checkpoint(),height:9n}), /Private and token/);
  assert.throws(() => PrototypeIndex.fromAuthenticatedCheckpoint(index.manifest, envelope, {...index.checkpoint(),extra:true}), /Exact record/);
  assert.throws(() => restore(index, changed(envelope,e=>{e.state[0]^=1;},false)), /state hash/);
  assert.throws(() => restore(index, {...envelope,state:new Uint8Array(MAX_TOKEN_CHECKPOINT_BYTES+1)}), /byte bound/);
  if (typeof SharedArrayBuffer !== 'undefined') assert.throws(() => restore(index, {...envelope,state:new Uint8Array(new SharedArrayBuffer(16))}), /byte bound/);
});

test('canonical decoder rejects table bounds, order, duplicate keys, reserved fields, bad widths and trailing bytes even with a matching digest', () => {
  const {index,manifest,credit} = fundedIndex(); append(index,[observation(sale(credit,manifest),200n)]);
  const envelope=index.exportCheckpoint(), {fields,tables}=layout(envelope.state);
  const edits = [
    e=>{e.state[fields.reserved]=1;}, e=>{e.state[tables[1].at]=2;},
    e=>uint(MAX_TOKEN_CHECKPOINT_ROWS+1,8).copy(e.state,tables[3].countAt),
    e=>uint(1,8).copy(e.state,tables[8].countAt), e=>{e.state[tables[1].rows[0].prefix]++;},
    e=>e.state.copy(e.state,tables[3].rows[1].data,tables[3].rows[0].data,tables[3].rows[0].data+32),
    e=>{const [a,b]=tables[3].rows, first=Buffer.from(e.state.subarray(a.data,a.data+a.length));e.state.copy(e.state,a.data,b.data,b.data+b.length);first.copy(e.state,b.data);},
    e=>{e.state=Buffer.concat([e.state,Buffer.from([0])]);}, e=>{e.state=e.state.subarray(0,e.state.length-1);},
    e=>{e.state[domain('XN1-LOCAL-S2-STATE').length]=3;}
  ];
  for(const edit of edits) assert.throws(()=>restore(index,changed(envelope,edit)));
});

test('canonical-looking state rejects inconsistent counters and transaction, lot, input, output and consumed provenance', () => {
  const {index,manifest,credit}=fundedIndex(); append(index,[observation(sale(credit,manifest),200n)]);
  const envelope=index.exportCheckpoint(),{fields,tables}=layout(envelope.state);
  for(const edit of [
    e=>uint(1001,8).copy(e.state,fields.issued), e=>uint(1,8).copy(e.state,fields.burned),
    e=>uint(999,8).copy(e.state,tables[1].rows[0].data+100),
    e=>uint(99,8).copy(e.state,tables[1].rows[0].data+116),
    e=>uint(4096,2).copy(e.state,tables[3].rows[0].data+64),
    e=>Buffer.from(label('unknown transaction'),'hex').copy(e.state,tables[3].rows[0].data+32),
    e=>uint(20,8).copy(e.state,tables[6].rows[0].data+32),
    e=>uint(4096,4).copy(e.state,tables[7].rows[0].data+8+32),
    e=>{e.state[tables[2].rows[0].data+36+32]=4;},
    e=>Buffer.from(label('unknown spent image'),'hex').copy(e.state,tables[2].rows[0].data+36+32+1)
  ]) assert.throws(()=>restore(index,changed(envelope,edit)));
});

test('export and import detach all externally mutable bytes and cannot snapshot an in-flight admission', async () => {
  const {index,manifest,credit}=fundedIndex(), envelope=index.exportCheckpoint(), resumed=restore(index,envelope), expected=resumed.stateHash();
  envelope.state.fill(0); envelope.checkpoint.height='0'; assert.equal(resumed.stateHash(),expected); same(index,resumed);
  const next=index.exportCheckpoint(); next.state.fill(0); assert.equal(index.stateHash(),expected);
  const move=sale(credit,manifest), checkpoint=index.checkpoint();let during=false;
  await index.applyBlockWithPolicy({height:checkpoint.height+1n,parent:checkpoint.blockHash,hash:label('async checkpoint'),transactions:[observation(move,200n)]},{
    beforeTransaction:async()=>{during=true;assert.throws(()=>index.exportCheckpoint(),/admission already/);},authorizeRecord:async()=>true,afterTransaction:async()=>{}
  });assert.ok(during);same(index,restore(index));
});

test('realistic public-history sized checkpoint decodes without variadic limits or redoing chain cryptography', () => {
  // Structural codec-only fixture: no token ownership and no real transactions.
  const manifest=fixtureManifest(),id=manifestId(manifest),count=40000,blockHash=label('large codec fixture'),tables=Array.from({length:7},()=>[]);
  for(let i=0;i<count;i++){
    const txid=hash(domain('public codec tx'),uint(i,8)),height=BigInt(Math.floor(i/10000)+1);
    tables[5].push({key:txid,row:Buffer.concat([txid,uint(height,8)])});
    for(let vin=0;vin<2;vin++) {const image=hash(domain('public codec image'),uint(i,8),uint(vin,1));tables[2].push({key:image,row:Buffer.concat([image,txid,uint(vin,2),uint(height,8)])});}
    for(let vout=0;vout<2;vout++){const key=uint(BigInt(i*2+vout),8);tables[6].push({key,row:Buffer.concat([key,txid,uint(vout,4)])});}
  }
  const encoded=tables.map((rows,i)=>{rows.sort((a,b)=>Buffer.compare(a.key,b.key));return Buffer.concat([uint(i+1,1),uint(rows.length,8),...rows.map(({row})=>Buffer.concat([uint(row.length,4),row]))]);});
  const state=Buffer.concat([domain('XN1-LOCAL-S2-STATE'),uint(2,1),Buffer.from(id,'hex'),uint(4,8),Buffer.from(blockHash,'hex'),uint(0,8),uint(0,8),uint(0,8),uint(8,1),...encoded,uint(8,1),uint(0,8)]);
  assert.ok(state.length>10_000_000);
  const envelope={codecVersion:1,verificationVersion:1,manifest:id,genesis:manifest.genesis,checkpoint:{height:'4',blockHash},stateHash:hash(state).toString('hex'),state};
  const resumed=PrototypeIndex.fromAuthenticatedCheckpoint(manifest,envelope,{height:4n,blockHash});
  assert.equal(resumed.stateHash(),envelope.stateHash);assert.deepEqual(resumed.exportCheckpoint().state,state);assert.equal(resumed.snapshot().transactions.size,count);
  const before=resumed.checkpoint();append(resumed);resumed.rewind(before.height,before.blockHash);assert.equal(resumed.stateHash(),envelope.stateHash);
});
