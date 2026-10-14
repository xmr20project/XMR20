import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {createTurnkeySigner} from '../src/turnkey.mjs';
import {ExecutionJournal} from '../src/execution-journal.mjs';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('unknown provider completion is reconciled by exact intent without signing again',async()=>{
 const f=fixture({versioned:true,partial:true}),dir=mkdtempSync(join(tmpdir(),'turnkey-reconcile-'));
 const journal=new ExecutionJournal(join(dir,'journal.vault'),'synthetic reconciliation passphrase');
 let completed,queries=0;
 const original=f.client.signTransaction;
 f.client.signTransaction=async request=>{completed=(await original(request)).activity;completed.intent={signTransactionIntentV2:structuredClone(request.parameters)};throw Error('connection lost after completion');};
 f.client.query=async(method,args)=>{queries++;assert.equal(method,'get_activities');assert.equal(args.paginationOptions.limit,'100');return {activities:[completed]};};
 const signer=createTurnkeySigner({client:f.client,journal,organizationId:'synthetic-org',now:()=>1000});
 try {
  await assert.rejects(()=>signer.signReviewed(f.args),/OUTCOME_UNKNOWN/);assert.equal(journal.get('order-1').state,'reserved');
  const result=await signer.reconcile('order-1');assert.equal(result.state,'signed');assert.equal(result.transaction,undefined);assert.equal(journal.get('order-1').state,'signed');assert.equal(f.calls(),1);assert.equal(queries,1);
  await signer.reconcile('order-1');assert.equal(queries,1);assert.equal(f.calls(),1);
 }finally{journal.close();rmSync(dir,{recursive:true,force:true});}
});

test('reconciliation refuses unknown intent or corrupted signed messages',async()=>{
 for(const tamper of ['intent','signature']){
  const f=fixture(),dir=mkdtempSync(join(tmpdir(),'turnkey-reconcile-reject-')),journal=new ExecutionJournal(join(dir,'journal.vault'),'synthetic reconciliation passphrase');let activity;
  const original=f.client.signTransaction;
  f.client.signTransaction=async request=>{activity=(await original(request)).activity;activity.intent={signTransactionIntentV2:structuredClone(request.parameters)};throw Error('ambiguous');};
  f.client.query=async()=>({activities:[activity]});const signer=createTurnkeySigner({client:f.client,journal,organizationId:'synthetic-org',now:()=>1000});
  try{
   await assert.rejects(()=>signer.signReviewed(f.args));
   if(tamper==='intent')activity.intent.signTransactionIntentV2.signWith='another-wallet';
   else{const bytes=Buffer.from(activity.result.signTransactionResult.signedTransaction,'hex');bytes[2]^=1;activity.result.signTransactionResult.signedTransaction=bytes.toString('hex');}
   await assert.rejects(()=>signer.reconcile('order-1'),/SIGNING_/);assert.equal(journal.get('order-1').state,'reserved');assert.equal(f.calls(),1);
  }finally{journal.close();rmSync(dir,{recursive:true,force:true});}
 }
});

const hash = value => createHash('sha256').update(value).digest('hex');
function address(bytes) {
  let n = BigInt('0x' + bytes.toString('hex')), result = '';
  while (n) { result = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[Number(n % 58n)] + result; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; result = '1' + result; }
  return result;
}
function fixture({versioned = false, partial = false, change = () => {}, delay = false} = {}) {
  // Disposable synthetic signers only. A valid SystemProgram transfer message,
  // with an optional second required signer to test launch partial signatures.
  const pair = generateKeyPairSync('ed25519'), second = generateKeyPairSync('ed25519');
  const raw = p => p.publicKey.export({format:'der', type:'spki'}).subarray(-32);
  const keys = partial ? [raw(pair), raw(second), Buffer.alloc(32, 7), Buffer.alloc(32)] : [raw(pair), Buffer.alloc(32, 7), Buffer.alloc(32)];
  const amount = Buffer.alloc(12); amount.writeUInt32LE(2); amount.writeBigUInt64LE(1000n, 4);
  const message = Buffer.concat([versioned ? Buffer.from([128]) : Buffer.alloc(0), Buffer.from([partial ? 2 : 1, partial ? 1 : 0, 1, keys.length]), ...keys, Buffer.alloc(32, 9), Buffer.from([1, keys.length - 1, 2, 0, keys.length - 2, 12]), amount, versioned ? Buffer.from([0]) : Buffer.alloc(0)]);
  const count = partial ? 2 : 1;
  const transaction = Buffer.concat([Buffer.from([count]), Buffer.alloc(64), ...(partial ? [sign(null, message, second.privateKey)] : []), message]);
  let time = 1000, calls = 0;
  const records = new Map();
  const journal = {
    async reserve(record) { assert.ok(!records.has(record.operationId), 'duplicate operation'); records.set(record.operationId, {...record, state:'reserved'}); },
    async complete(record) { records.set(record.operationId, {...record, state:'complete'}); }
  };
  const client = {async signTransaction(request) {
    calls++;
    assert.equal(request.parameters.type, 'TRANSACTION_TYPE_SOLANA');
    assert.equal(request.parameters.unsignedTransaction, transaction.toString('hex'));
    const signed = Buffer.from(transaction); sign(null, message, pair.privateKey).copy(signed, 1);
    const activity = {id:'synthetic-activity', organizationId:'synthetic-org', type:'ACTIVITY_TYPE_SIGN_TRANSACTION_V2', status:'ACTIVITY_STATUS_COMPLETED', result:{signTransactionResult:{signedTransaction:signed.toString('hex')}}};
    change(activity, signed);
    if (delay) time = 3000;
    return {activity};
  }};
  const args = {operationId:'order-1', address:address(raw(pair)), transaction, messageSha256:hash(message), expiresAt:2000};
  return {client, journal, args, records, calls:() => calls, signer:createTurnkeySigner({client, journal, organizationId:'synthetic-org', now:() => time})};
}

for (const versioned of [false, true]) test(`signing preserves ${versioned ? 'v0' : 'legacy'} message and other launch signatures`, async () => {
  const f = fixture({versioned, partial:true});
  const result = await f.signer.signReviewed(f.args);
  assert.deepEqual(result.transaction.subarray(65), f.args.transaction.subarray(65));
  assert.equal(f.records.get('order-1').state, 'complete');
  await assert.rejects(f.signer.signReviewed(f.args), /duplicate operation/);
  assert.equal(f.calls(), 1);
});

test('unreviewed, expired and wrong-wallet requests never reach Turnkey', async () => {
  const f = fixture();
  await assert.rejects(f.signer.signReviewed({...f.args, messageSha256:'0'.repeat(64)}), /REVIEW_MISMATCH/);
  await assert.rejects(f.signer.signReviewed({...f.args, expiresAt:999}), /SIGNING_APPROVAL/);
  await assert.rejects(f.signer.signReviewed({...f.args, address:'11111111111111111111111111111111'}), /SIGNER_NOT_REQUIRED/);
  assert.equal(f.calls(), 0); assert.equal(f.records.size, 0);
});

test('durable reservation failure prevents signing', async () => {
  const f = fixture(); f.journal.reserve = async () => { throw Error('disk unavailable'); };
  await assert.rejects(f.signer.signReviewed(f.args), /disk unavailable/);
  assert.equal(f.calls(), 0);
});

test('response message mutation and unrelated signature mutation are rejected', async () => {
  for (const index of [80, 140]) {
    const f = fixture({partial:true, change(activity, signed) { signed[index] ^= 1; activity.result.signTransactionResult.signedTransaction = signed.toString('hex'); }});
    await assert.rejects(f.signer.signReviewed(f.args), /SIGNING_(MESSAGE|SIGNATURE)_CHANGED/);
    assert.equal(f.records.get('order-1').state, 'reserved');
  }
});

test('wrong organization, pending approval and invalid signatures do not return bytes', async () => {
  for (const change of [a => { a.organizationId = 'another-org'; }, a => { a.status = 'ACTIVITY_STATUS_CONSENSUS_NEEDED'; }, (a, signed) => { signed[5] ^= 1; a.result.signTransactionResult.signedTransaction = signed.toString('hex'); }]) {
    const f = fixture({change});
    await assert.rejects(f.signer.signReviewed(f.args), /SIGNING_/);
    assert.equal(f.records.get('order-1').state, 'reserved');
  }
});

test('ambiguous provider error is redacted, keeps reservation and never retries', async () => {
  const f = fixture(); let calls = 0;
  f.client.signTransaction = async () => { calls++; throw Error('synthetic provider details must not escape'); };
  await assert.rejects(f.signer.signReviewed(f.args), /^Error: SIGNING_OUTCOME_UNKNOWN$/);
  await assert.rejects(f.signer.signReviewed(f.args), /duplicate operation/);
  assert.equal(calls, 1);
});

test('receipt persistence failure and expired approval withhold signed bytes', async () => {
  const f = fixture(); f.journal.complete = async () => { throw Error('disk unavailable'); };
  await assert.rejects(f.signer.signReviewed(f.args), /disk unavailable/);
  const delayed = fixture({delay:true});
  await assert.rejects(delayed.signer.signReviewed(delayed.args), /APPROVAL_EXPIRED/);
  assert.equal(delayed.records.get('order-1').state, 'complete');
});

test('encrypted journal preserves signed receipts and blocks duplicate signing after restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-execution-'));
  const path = join(root, 'execution.vault'), password = 'synthetic-journal-password';
  let journal;
  try {
    journal = new ExecutionJournal(path, password);
    const f = fixture({partial:true, versioned:true});
    const signer = createTurnkeySigner({client:f.client, journal, organizationId:'synthetic-org', now:() => 1000});
    const signed = await signer.signReviewed(f.args);
    const record = journal.get('order-1');
    assert.equal(record.state, 'signed');
    assert.equal(record.receipt.signedTransactionHex, signed.transaction.toString('hex'));
    assert.equal(record.request.parameters.unsignedTransaction, f.args.transaction.toString('hex'));
    assert.equal(record.activityId, 'synthetic-activity');
    assert.ok(!readFileSync(path).includes(Buffer.from(record.receipt.signedTransactionHex)));
    record.state = 'forged'; assert.equal(journal.get('order-1').state, 'signed');
    assert.throws(() => new ExecutionJournal(path, password), /locked/);
    journal.close(); journal = new ExecutionJournal(path, password);
    const resumed = createTurnkeySigner({client:f.client, journal, organizationId:'synthetic-org', now:() => 1000});
    await assert.rejects(resumed.signReviewed(f.args), /JOURNAL_ALREADY_RESERVED/);
    assert.equal(f.calls(), 1);
    assert.equal(journal.get('order-1').receipt.signedTransactionHex, signed.transaction.toString('hex'));
  } finally { journal?.close(); rmSync(root, {recursive:true, force:true}); }
});

test('ambiguous and pending signing remains reserved across restarts with recovery evidence', async () => {
  for (const pending of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'synthetic-recovery-'));
    const path = join(root, 'execution.vault'), password = 'synthetic-journal-password';
    let journal;
    try {
      journal = new ExecutionJournal(path, password);
      const f = fixture({change:a => { a.status = 'ACTIVITY_STATUS_CONSENSUS_NEEDED'; }});
      if (!pending) f.client.signTransaction = async () => { throw Error('timeout'); };
      const signer = createTurnkeySigner({client:f.client, journal, organizationId:'synthetic-org', now:() => 1000});
      await assert.rejects(signer.signReviewed(f.args), /SIGNING_(OUTCOME_UNKNOWN|REQUIRES_RECONCILIATION)/);
      journal.close(); journal = new ExecutionJournal(path, password);
      const record = journal.get('order-1');
      assert.equal(record.state, 'reserved');
      assert.equal(record.requestSha256, hash(Buffer.from(JSON.stringify(record.request))).toString('hex'));
      if (pending) assert.equal(record.activityId, 'synthetic-activity');
      const resumed = createTurnkeySigner({client:f.client, journal, organizationId:'synthetic-org', now:() => 1000});
      await assert.rejects(resumed.signReviewed(f.args), /JOURNAL_ALREADY_RESERVED/);
      if (pending) assert.throws(() => journal.observeActivity({operationId:'order-1',activityId:'changed',status:'ACTIVITY_STATUS_COMPLETED'}), /JOURNAL_ACTIVITY_MISMATCH/);
    } finally { journal?.close(); rmSync(root, {recursive:true, force:true}); }
  }
});
