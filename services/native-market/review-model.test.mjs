// Documentation models for the 2026-10-16 independent review.
// NO cryptographic signing, RPC, wallet, native transaction construction or funds.
// These model the stated overlay rules and idealized consensus key-image uniqueness;
// passing them is NOT a daemon-accepted exploit or an atomic-settlement validation.
import test from 'node:test';
import assert from 'node:assert/strict';

function replay(txs, cap = 100n) {
  const spent = new Set(), lots = new Map(), recovered = new Set();
  let issued = 0n;
  const outcomes = [];
  for (const tx of txs) {
    if (tx.inputs.some(image => spent.has(image))) {
      outcomes.push({id:tx.id, native:false, token:false, paid:0n});
      continue;
    }
    for (const image of tx.inputs) spent.add(image);
    // Assume all other native consensus checks pass. XN1 is not one of them.
    const outcome = {id:tx.id, native:true, token:false, paid:tx.payment ?? 0n};
    const r = tx.record;
    if (r?.op === 'credit' && r.issuerProofValid && issued + r.amount <= cap) {
      // Deliberately mirrors review §3.2: no used-supply-reference set.
      lots.set(tx.id + ':' + r.vout, r.amount);
      issued += r.amount; outcome.token = true;
    }
    if (r?.op === 'move' && r.proofValid && tx.inputs.includes(r.image) &&
        lots.get(r.source) === r.amount) {
      lots.delete(r.source); lots.set(tx.id + ':' + r.vout, r.amount);
      outcome.token = true;
    }
    if (r?.op === 'recover' && r.proofValid && spent.has(r.oldImage) &&
        !recovered.has(r.source) && lots.get(r.source) === r.amount) {
      // Review's bare DLEQ establishes P/I ownership but not current allocations.
      lots.delete(r.source); lots.set(tx.id + ':' + r.vout, r.amount);
      recovered.add(r.source); outcome.token = true;
    }
    outcomes.push(outcome);
  }
  return {lots, issued, spent, outcomes};
}

const credit = (id, amount = 100n, reference = 'lock-1') => ({
  id, inputs:[id + '-funding'],
  record:{op:'credit', amount, vout:0, reference, issuerProofValid:true}
});
const move = (id, source, image, payment = 0n) => ({
  id, inputs:[image, id + '-funding'], payment,
  record:{op:'move', source, image, amount:100n, vout:0, proofValid:true}
});

test('review model: competing fixed-branch spends cannot leave a losing buyer paid', () => {
  const saleA = move('sale-A', 'origin:0', 'lot-image', 12n);
  const saleB = move('sale-B', 'origin:0', 'lot-image', 14n);
  const cancel = move('cancel', 'origin:0', 'lot-image');
  for (const [first, second] of [[saleA,saleB],[saleB,saleA],[cancel,saleA],[saleA,cancel]]) {
    const state = replay([credit('origin'),first,second]);
    assert.equal(state.outcomes[1].token, true);
    assert.deepEqual(state.outcomes[2], {id:second.id, native:false, token:false, paid:0n});
  }
});

test('review counterexample: bare recovery proof can be copied onto attacker allocations', () => {
  const source = credit('origin');
  const silent = {id:'silent', inputs:['lot-image']};
  const intended = {op:'recover', source:'origin:0', oldImage:'lot-image', amount:100n,
    vout:0, proofValid:true, publicProof:'same-P-I-c-s'};
  // The attacker copies the public proof; no knowledge of x is assumed.
  const attacker = {id:'attacker-carrier', inputs:['attacker-funding'], record:{...intended}};
  const owner = {id:'owner-carrier', inputs:['owner-funding'], record:{...intended}};
  const state = replay([source,silent,attacker,owner]);
  assert.equal(state.lots.get('attacker-carrier:0'), 100n);
  assert.equal(state.lots.has('owner-carrier:0'), false);
  assert.equal(state.outcomes[3].native, true);
  assert.equal(state.outcomes[3].token, false);
});

test('review counterexample: CAP alone does not deduplicate the issuance reference', () => {
  const state = replay([credit('C1',40n,'same-lock'),credit('C2',40n,'same-lock')]);
  assert.equal(state.issued,80n);
  assert.equal(state.outcomes.every(o => o.token),true);
  // Only one 40-unit lock exists. Signatures/credit destination binding must also
  // be designed; this model isolates the missing one-reference-one-issuance rule.
});

test('review counterexample: ancestry reorg can keep native sale valid and invalidate token leg', () => {
  const origin = credit('C',100n,'lock-C');
  const sale = move('S','C:0','C-output-image',12n);
  const empty = {id:'filler', inputs:['competing-credit-funding']};
  const before = replay([empty,origin,sale]);
  assert.equal(before.outcomes[2].token,true); // Buyer validated this history.
  // Alternative fork: another issuer-authorized credit occupies CAP before C.
  // C's native output still exists, so S can spend it and pay on the new fork.
  // A transaction-level construction must preserve ring indices/members and ages
  // (same output counts/decoys) across forks. No daemon construction is claimed.
  const competing = credit('D',100n,'lock-D');
  competing.inputs = ['competing-credit-funding'];
  const after = replay([competing,origin,sale]);
  assert.deepEqual(after.outcomes[2],{id:'S',native:true,token:false,paid:12n});
  assert.equal(after.lots.has('S:0'),false);
});

test('review counterexample: duplicate output keys do not create independent key images', () => {
  // Symbolic application of the actual legacy Monero equation I = x * Hp(P).
  // txid/vout do not occur in this equation; no curve implementation is simulated.
  const image = (x,P) => `${x}*Hp(${P})`;
  const A = {outpoint:'A:0',x:'same-secret',P:'same-public-key'};
  const B = {...A,outpoint:'B:1'};
  assert.notEqual(A.outpoint,B.outpoint);
  assert.equal(image(A.x,A.P),image(B.x,B.P));
  const state = replay([
    {id:'spend-A',inputs:[image(A.x,A.P)]},
    {id:'spend-B',inputs:[image(B.x,B.P)]}
  ]);
  assert.equal(state.outcomes[1].native,false);
});
